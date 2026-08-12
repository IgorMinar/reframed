import { assert } from './utils/assert';
import { getInternalReference } from './iframe-patches';

export function reframedDomInsertion<T extends Node>(
	nodeToInsert: T,
	doInsertTheNode: Function,
	iframeDocument?: Document,
): T {
	// if we are operating outside of a reframed DOM or the appended child is neither an element nor
	// a document fragment (which can carry scripts, e.g. cloned template contents), then just append
	if (!iframeDocument || !(nodeToInsert instanceof HTMLElement || nodeToInsert instanceof DocumentFragment)) {
		return doInsertTheNode();
	}

	// if the child's prototype is directly HTMLElement, then check if this is a HTML/BODY/HEAD element and rewrite it
	if (nodeToInsert instanceof HTMLElement && Object.getPrototypeOf(nodeToInsert) === HTMLElement.prototype) {
		patchSpecialHtmlElement(nodeToInsert, iframeDocument);
	}

	// if the child is a script, then append and execute it in a reframed context
	if (nodeToInsert instanceof HTMLScriptElement) {
		// if the child is an unattached inline script that doesn't yet have text any content, then we need treat it in a special way
		if (!nodeToInsert.src && !nodeToInsert.firstChild && !nodeToInsert.parentNode) {
			prepareUnattachedInlineScript(nodeToInsert, iframeDocument!);
			return doInsertTheNode();
		}

		setInertScriptType(nodeToInsert);
		const returnVal = doInsertTheNode();
		restoreScriptType(nodeToInsert);
		executeInertScript(nodeToInsert, iframeDocument);
		return returnVal;
	}

	// if it's a preload or prefetch link for a script then append it to the iframe and leave an inert node in the reframed DOM
	if (
		nodeToInsert instanceof HTMLLinkElement &&
		(nodeToInsert.rel === 'preload' || nodeToInsert.rel === 'prefetch' || nodeToInsert.rel === 'modulepreload')
	) {
		setInertLinkRel(nodeToInsert);
		const returnVal = doInsertTheNode();
		executeInertPreloadLink(nodeToInsert, iframeDocument);
		return returnVal;
	}

	const nestedScriptsAndLinks: NodeListOf<HTMLScriptElement | HTMLLinkElement> = nodeToInsert.querySelectorAll?.(
		'script,link[rel=preload],link[rel=prefetch],link[rel=modulepreload]',
	);

	// if the child doesn't contains nested scripts or links, then just append it
	if (nestedScriptsAndLinks.length === 0) {
		return doInsertTheNode();
	}

	// otherwise, append the child and execute all nested scripts in a reframed context
	nestedScriptsAndLinks.forEach((element) => makeElementInert(element));
	const returnVal = doInsertTheNode();
	nestedScriptsAndLinks.forEach((element) => restoreElement(element));
	nestedScriptsAndLinks.forEach((element) => executeElement(element, iframeDocument));
	return returnVal;
}

/**
 * Handles a multi-node insertion (append, prepend, replaceChildren, replaceWith) into a reframed DOM.
 *
 * All scripts and preload links across all node arguments are neutralized first, then the actual
 * insertion runs exactly once, and only then are the scripts restored and executed in the reframed
 * context, in argument order. (Neutralizing/restoring per-node around a shared deferred insertion
 * would restore earlier scripts to their live form before the insertion actually happens, causing
 * them to execute in the main JS context.)
 */
export function reframedMultiNodeDomInsertion(
	nodes: (Node | string)[],
	doInsertTheNodes: () => void,
	iframeDocument?: Document,
) {
	if (!iframeDocument) {
		return doInsertTheNodes();
	}

	const scriptsAndLinks: (HTMLScriptElement | HTMLLinkElement)[] = [];

	for (const node of nodes) {
		if (typeof node === 'string') {
			console.warn(
				'reframed: string arguments to append/prepend/replaceChildren/replaceWith are not supported and could result in incorrect script execution. Inserted string: ',
				node,
			);
			continue;
		}

		if (node instanceof HTMLElement && Object.getPrototypeOf(node) === HTMLElement.prototype) {
			patchSpecialHtmlElement(node, iframeDocument);
		}

		if (node instanceof HTMLScriptElement) {
			if (!node.src && !node.firstChild && !node.parentNode) {
				prepareUnattachedInlineScript(node, iframeDocument);
			} else {
				scriptsAndLinks.push(node);
			}
		} else if (
			node instanceof HTMLLinkElement &&
			(node.rel === 'preload' || node.rel === 'prefetch' || node.rel === 'modulepreload')
		) {
			scriptsAndLinks.push(node);
		} else if (node.nodeType === Node.ELEMENT_NODE || node.nodeType === Node.DOCUMENT_FRAGMENT_NODE) {
			const nested: NodeListOf<HTMLScriptElement | HTMLLinkElement> | undefined = (
				node as Element | DocumentFragment
			).querySelectorAll?.('script,link[rel=preload],link[rel=prefetch],link[rel=modulepreload]');
			nested?.forEach((element) => scriptsAndLinks.push(element));
		}
	}

	scriptsAndLinks.forEach((element) => makeElementInert(element));
	doInsertTheNodes();
	scriptsAndLinks.forEach((element) => restoreElement(element));
	scriptsAndLinks.forEach((element) => executeElement(element, iframeDocument));
}

function makeElementInert(element: HTMLScriptElement | HTMLLinkElement) {
	if (element instanceof HTMLScriptElement) {
		setInertScriptType(element);
	} else {
		setInertLinkRel(element);
	}
}

function restoreElement(element: HTMLScriptElement | HTMLLinkElement) {
	if (element instanceof HTMLScriptElement) {
		restoreScriptType(element);
	} else {
		// don't restore links as we currently don't have another way of keeping them inert
	}
}

function executeElement(element: HTMLScriptElement | HTMLLinkElement, iframeDocument: Document) {
	if (element instanceof HTMLScriptElement) {
		executeInertScript(element, iframeDocument);
	} else {
		executeInertPreloadLink(element, iframeDocument);
	}
}

export function executeScriptsInPiercedFragment(shadowRoot: ShadowRoot, iframe: HTMLIFrameElement) {
	const iframeDocument = iframe.contentDocument;
	assert(iframeDocument !== null, 'iframe.contentDocument is not defined');

	// In addition to executing scripts, we also need to patch wf- tags if they are present so that the scripts see them
	// without the prefix.
	[...shadowRoot.querySelectorAll('wf-html, wf-body, wf-head')].forEach((element) =>
		patchSpecialHtmlElement(element, iframeDocument),
	);

	const scriptsAndLinks = [
		...shadowRoot.querySelectorAll(
			'link[rel=inert-preload],link[rel=inert-prefetch],link[rel=inert-modulepreload],script',
		),
	] as (HTMLLinkElement | HTMLScriptElement)[];

	scriptsAndLinks.forEach((inertElement) => {
		if (inertElement instanceof HTMLLinkElement) {
			executeInertPreloadLink(inertElement, iframeDocument);
		} else {
			restoreScriptType(inertElement);
			executeInertScript(inertElement, iframeDocument);
		}
	});
}

/**
 * Weak map of scripts running in the iframe to their inert clones in the reframed DOM.
 */
export const execToInertScriptMap = new WeakMap<HTMLScriptElement, HTMLScriptElement>();
export const alreadyExecutedScriptsAndLinks = new WeakSet<HTMLScriptElement | HTMLLinkElement>();

/**
 * Executes a script in a reframed JS context.
 * @param inertScript inert script already appended to a document within reframed DOM
 * @param iframeDocument iframe document in which the script should execute.
 * @returns true if the script executed, false if it was ignored
 */
export function executeInertScript(inertScript: HTMLScriptElement, iframeDocument: Document): boolean {
	// If the inert script has already been evaluated but later re-added to the DOM via any DOM insertion method
	// (i.e insertBefore() and appendChild()), do not evaluate the script again
	if (alreadyExecutedScriptsAndLinks.has(inertScript)) {
		return false;
	}

	// If the script does not have a valid type attribute, treat the script node as a data block.
	// We can add the data block directly to the main document instead of the iframe context.
	const validScriptTypes = ['module', 'text/javascript', 'importmap', 'speculationrules', '', null];
	if (!validScriptTypes.includes(inertScript.getAttribute('type'))) {
		return false;
	}

	assert(!!(inertScript.src || inertScript.textContent), `Can't execute script without src or textContent!`);

	attachScriptsToIframe({ inertScript, iframeDocument });

	return true;
}

export function executeInertPreloadLink(inertLink: HTMLLinkElement, iframeDocument: Document): boolean {
	// If the inert link has already been evaluated but later re-added to the DOM via any DOM insertion method
	// (i.e insertBefore() and appendChild()), do not evaluate the link again
	if (alreadyExecutedScriptsAndLinks.has(inertLink)) {
		return false;
	}

	// If the link does not have a valid href attribute then skip
	if (!inertLink.href) return false;

	const execLink = iframeDocument.importNode(inertLink, true);
	restoreLinkRel(execLink);

	// Grab the Event constructor from the iframe
	const Event = iframeDocument.defaultView!.Event;

	// Redispatch the load event onto the inert link in the reframed dom
	execLink.addEventListener('load', () => {
		inertLink.dispatchEvent(new Event('load', { cancelable: false }));
	});

	// Redispatch the error event onto the inert link in the reframed dom
	execLink.addEventListener('error', () => {
		inertLink.dispatchEvent(new Event('error', { cancelable: false }));
	});

	getInternalReference(iframeDocument, 'body').appendChild(execLink);
	alreadyExecutedScriptsAndLinks.add(inertLink);

	return true;
}

/**
 * Attaches exec scripts to iframe and keeps a record of already evaluated scripts
 * @param inertScript inert script already appended to a document within reframed DOM
 * @param execScript exec script to be attached to the iframe document.
 * @param iframeDocument iframe document in which the script should execute.
 */
export function attachScriptsToIframe({
	inertScript,
	execScript,
	iframeDocument,
}: {
	inertScript: HTMLScriptElement;
	execScript?: HTMLScriptElement;
	iframeDocument: Document;
}) {
	if (!execScript) {
		execScript = iframeDocument.importNode(inertScript, true);
	}

	// the following line will append the executable script to iframe
	// - inline scripts (script with textContent) will be executed synchronously when attached
	// - external scripts (with src attribute) will execute once the current turn of the event loop unwinds
	execToInertScriptMap.set(execScript, inertScript);

	// redispatch the load event onto the inert script in the reframed dom
	execScript.addEventListener('load', () => {
		inertScript.dispatchEvent(new Event('load', { cancelable: false }));
	});

	// redispatch the error event onto the inert script in the reframed dom
	execScript.addEventListener('error', () => {
		inertScript.dispatchEvent(new Event('error', { cancelable: false }));
	});

	getInternalReference(iframeDocument, 'body').appendChild(execScript);
	alreadyExecutedScriptsAndLinks.add(inertScript);
}

/**
 * Set the type attribute of a script element to "inert".
 *
 * This prevents the script from executing in the main JS context when the script is attached to the main document.
 *
 * @param script
 */
function setInertScriptType(script: HTMLScriptElement) {
	const scriptType = script.type;
	if (scriptType) {
		script.setAttribute('data-script-type', scriptType);
	}
	script.setAttribute('type', 'inert');
}

/**
 * Restore the original script type and erase any signs of us making the script inert.
 *
 * @param script
 */
export function restoreScriptType(script: HTMLScriptElement) {
	const scriptType = script.getAttribute('data-script-type');
	script.removeAttribute('data-script-type');
	script.removeAttribute('type');
	if (scriptType) {
		script.setAttribute('type', scriptType);
	}
}

/**
 * Neutralizes the original link, so that it doesn't result in a duplicate network call
 *
 * TODO: This neutralization method cause hydration errors.
 *       Is it possible to make the link inert without exposing that information to the application?
 *
 * @param link The preload/prefetch link
 */
function setInertLinkRel(link: HTMLLinkElement) {
	const linkRel = link.rel;
	if (linkRel) {
		link.rel = 'inert-' + linkRel;
	}
}

/**
 * Reverses the `setInertLinkRel` operation.
 *
 * @param link The preload/prefetch link
 */
function restoreLinkRel(link: HTMLLinkElement) {
	const linkRel = link.rel;
	if (linkRel && linkRel.startsWith('inert-')) {
		// strip the 'inert-' prefix
		link.rel = linkRel.slice(6);
	}
}

/**
 * Inline scripts that do not have textContent set are not evaluated until the the first time textContent is set.
 *
 * We prepare these scripts for future execution by:
 * - appending a non-neutralized clone of the script to the iframe document
 * - neutralizing the original script so that it doesn't execute in the main JS context in the future
 * - patching the script's appendChild method to also append to the clone which will execute the script in the reframed context
 *
 * If a text content is added later, the script then executes in the reframed context.
 *
 * @param script Script element to prepare
 * @param iframeDocument Reframed iframe document
 */
function prepareUnattachedInlineScript(script: HTMLScriptElement, iframeDocument: Document) {
	// We must clone the script before neutralizing it, otherwise the clone will also be neutralized
	const execScript = iframeDocument.importNode(script, true);
	const inertScript = script;

	// neutralize the script so that it doesn't execute in the main JS context
	inertScript.textContent = '//inert';
	// TODO: should we use a different document?
	document.body.appendChild(inertScript);

	// now restore the inert script so the code using it doesn't see what we did
	inertScript.remove();
	inertScript.firstChild!.remove();

	// We have already cloned the inertScript so we don't need to clone it again.
	// Cloning again will cause the execScript to be neutralized.
	attachScriptsToIframe({ inertScript, execScript, iframeDocument });

	const origScriptAppendChild = inertScript.appendChild;
	inertScript.appendChild = function (node) {
		origScriptAppendChild.call(inertScript, node);
		execScript.appendChild.call(execScript, iframeDocument.importNode(node, true));
		// restore appendChild since only the first invocation should executes a script
		inertScript.appendChild = origScriptAppendChild;
		return node;
	};
}

// Rewrite the tagname for special custom elements added by writable-dom.
// Remove the WF-* prefix, but only for those elements.
//
// TODO: optimize patch for tagname rewrite to short circuit earlier,
// otherwise we potentially need to run this check millions/billions of times
const WF_CUSTOM_ELEMENTS = new Map([
	['WF-HTML', document.documentElement],
	['WF-HEAD', document.head],
	['WF-BODY', document.body],
]);
function patchSpecialHtmlElement(node: Element, iframeDocument: Document) {
	const originalTagName = node.tagName;
	const mappedElement = WF_CUSTOM_ELEMENTS.get(originalTagName);
	if (mappedElement) {
		Object.defineProperties(node, {
			clientWidth: {
				get() {
					return mappedElement.clientWidth;
				},
			},
			clientHeight: {
				get() {
					return mappedElement.clientHeight;
				},
			},
			nodeName: {
				get() {
					return originalTagName.replace(/^WF-/i, '');
				},
			},
			tagName: {
				get() {
					return originalTagName.replace(/^WF-/i, '');
				},
			},
		});

		// if the node is WF-HEAD, we are done
		if (node.tagName === 'HEAD') {
			return;
		}

		// otherwise we need to patch addEventListener and removeEventListener to support retargeting to main <html> and <body> elements
		node.addEventListener = iframeDocument.addEventListener;
		node.removeEventListener = iframeDocument.removeEventListener;
	}
}
