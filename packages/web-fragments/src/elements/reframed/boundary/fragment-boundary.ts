import {
	reframedDomInsertion,
	reframedMultiNodeDomInsertion,
	executeInertScript,
	executeInertPreloadLink,
	restoreScriptType,
	alreadyExecutedScriptsAndLinks,
} from '../script-execution';
import { removeBornInertShadowing, unwrapBornInertScriptToLive } from './born-inert-scripts';

/**
 * The fragment boundary: strict host-isolation replacement for the global main-realm patches in
 * `main-patches.ts` (see rfcs/host-page-isolation.md).
 *
 * Instead of patching the host page's `Node`/`Element` prototypes, every node inside a fragment's
 * DOM is "stamped" with a per-fragment prototype spliced above its native prototype
 * (`Object.create(nativeProto, overrides)` + `Object.setPrototypeOf(node, …)`). The overrides
 * provide exactly what the global patches used to provide — script/preload activation on insertion
 * and virtualized `ownerDocument`/`getRootNode` — but only for nodes that belong to the fragment.
 * The host page runs on pristine prototypes.
 *
 * Stamping is applied synchronously at every point where nodes enter the fragment world, and stamped
 * entry points propagate the stamp to whatever they create or admit (insertion methods, `cloneNode`,
 * `innerHTML`, `insertAdjacentHTML`), so the stamped set is closed under the operations fragment code
 * can perform on it.
 *
 * A `MutationObserver` scoped to the fragment's shadow root acts as the safety net for insertions
 * that bypass stamped methods (e.g. code calling captured native functions): scripts reaching the
 * DOM through such paths are inert by construction (see `born-inert-scripts.ts` and the gateway's
 * SSR neutralization), and the observer activates them — one microtask later — in the fragment's JS
 * context, stamps the stray subtree, and reports the bypass in dev mode.
 */

// Native main-realm references, captured at module load (before any legacy patching could occur).
const native = {
	appendChild: Node.prototype.appendChild,
	insertBefore: Node.prototype.insertBefore,
	replaceChild: Node.prototype.replaceChild,
	getRootNode: Node.prototype.getRootNode,
	cloneNode: Node.prototype.cloneNode,
	ownerDocument: Object.getOwnPropertyDescriptor(Node.prototype, 'ownerDocument')!.get!,
	elementAppend: Element.prototype.append,
	elementPrepend: Element.prototype.prepend,
	elementReplaceChildren: Element.prototype.replaceChildren,
	elementReplaceWith: Element.prototype.replaceWith,
	insertAdjacentElement: Element.prototype.insertAdjacentElement,
	insertAdjacentHTML: Element.prototype.insertAdjacentHTML,
	elementInnerHTML: Object.getOwnPropertyDescriptor(Element.prototype, 'innerHTML')!,
	fragmentAppend: DocumentFragment.prototype.append,
	fragmentPrepend: DocumentFragment.prototype.prepend,
	fragmentReplaceChildren: DocumentFragment.prototype.replaceChildren,
	shadowRootInnerHTML: Object.getOwnPropertyDescriptor(ShadowRoot.prototype, 'innerHTML')!,
};

export interface FragmentBoundary {
	/** Stamps a single element with the fragment's boundary prototype. */
	stampNode(node: Node): void;
	/** Stamps an element (or DocumentFragment contents) and all its element descendants. */
	stampTree(root: Node): void;
	/** Disconnects the boundary observer. Called when the fragment is destroyed. */
	disconnect(): void;
}

export function createFragmentBoundary(options: {
	iframeDocument: Document;
	shadowRoot: ShadowRoot;
	wfDocumentElement: HTMLElement;
	abortSignal: AbortSignal;
}): FragmentBoundary {
	const { iframeDocument, shadowRoot, wfDocumentElement, abortSignal } = options;

	const stampedNodes = new WeakSet<Node>();
	const stampedProtos = new Map<object, object>();
	const stampedProtoSet = new WeakSet<object>();
	let warnedAboutUnstampedEntry = false;

	/** A node is inside this fragment's DOM iff its plain root is the fragment's shadow root. */
	function isInFragmentDom(node: Node): boolean {
		return native.getRootNode.call(node) === shadowRoot;
	}

	/**
	 * Reverts any born-inert scripts in the given node (or its subtree) to their live form, so the
	 * standard insertion handling below can process them exactly like legacy-mode insertions.
	 *
	 * This also covers *clones* of born-inert scripts: clones carry the `type="inert"` +
	 * `data-script-type` attributes (attributes copy with cloneNode) but not the WeakSet membership.
	 * In legacy mode the equivalent script would be live at this point, so reviving it here restores
	 * behavior parity.
	 */
	function reviveInertScript(script: HTMLScriptElement): void {
		unwrapBornInertScriptToLive(script);
		if (script.getAttribute('type') === 'inert' && !alreadyExecutedScriptsAndLinks.has(script)) {
			restoreScriptType(script);
		}
	}

	function prepareForInsertion<T extends Node>(node: T): T {
		if (node instanceof HTMLScriptElement) {
			reviveInertScript(node);
		} else if (node.nodeType === Node.ELEMENT_NODE || node.nodeType === Node.DOCUMENT_FRAGMENT_NODE) {
			(node as unknown as Element).querySelectorAll?.('script').forEach((script) => {
				reviveInertScript(script as HTMLScriptElement);
			});
		}
		return node;
	}

	/**
	 * Nodes to stamp after an insertion: the node itself, or — for a DocumentFragment, whose children
	 * move into the target during insertion — its current children.
	 */
	function nodesToStampAfterInsertion(node: Node): Node[] {
		return node.nodeType === Node.DOCUMENT_FRAGMENT_NODE ? [...node.childNodes] : [node];
	}

	/**
	 * Creates a wrapper for a single-child insertion method (appendChild, insertBefore).
	 *
	 * When the target is inside the fragment's DOM, the insertion gets the same script handling that
	 * the legacy global patches provided (via `reframedDomInsertion`). In all cases the inserted
	 * subtree is stamped so the stamped set stays closed.
	 */
	function makeSingleNodeInsertion(nativeFn: Function) {
		return function boundaryInsertion<T extends Node>(this: Node, childNode: T): T {
			const args = arguments;
			const futureStamps = nodesToStampAfterInsertion(childNode);
			const doInsertTheNode = () => {
				const result = nativeFn.apply(this, args);
				futureStamps.forEach(stampTree);
				return result as T;
			};

			if (!isInFragmentDom(this)) {
				// matches legacy behavior: insertions into unattached trees are not script-processed;
				// scripts are handled when the tree itself is inserted into the fragment's DOM
				return doInsertTheNode();
			}

			return reframedDomInsertion(prepareForInsertion(childNode), doInsertTheNode, iframeDocument);
		};
	}

	function boundaryReplaceChild<T extends Node>(this: Node, newChild: Node, oldChild: T): T {
		const args = arguments;
		const futureStamps = nodesToStampAfterInsertion(newChild);
		const doInsertTheNode = () => {
			const result = native.replaceChild.apply(this, args as any);
			futureStamps.forEach(stampTree);
			return result;
		};

		if (!isInFragmentDom(this)) {
			doInsertTheNode();
		} else {
			reframedDomInsertion(prepareForInsertion(newChild), doInsertTheNode, iframeDocument);
		}
		return oldChild;
	}

	function boundaryInsertAdjacentElement(this: Element, where: InsertPosition, element: Element): Element | null {
		const args = arguments;
		const doInsertTheNode = () => {
			const result = native.insertAdjacentElement.apply(this, args as any);
			stampTree(element);
			return result;
		};

		if (!isInFragmentDom(this)) {
			return doInsertTheNode();
		}
		return reframedDomInsertion(prepareForInsertion(element), doInsertTheNode, iframeDocument) as Element | null;
	}

	/**
	 * Creates a wrapper for the multi-node insertion methods (append, prepend, replaceChildren,
	 * replaceWith), mirroring the deferred-countdown pattern of the legacy patches: the native
	 * insertion runs once, after every node argument has been preprocessed.
	 */
	function makeMultiNodeInsertion(nativeFn: Function) {
		return function boundaryMultiInsertion(this: Node, ...nodes: (Node | string)[]) {
			const args = arguments;
			const nodeArgs = nodes.filter((node): node is Node => typeof node !== 'string');
			const futureStamps = nodeArgs.flatMap(nodesToStampAfterInsertion);

			const doInsertTheNodes = () => {
				nativeFn.apply(this, args);
				futureStamps.forEach(stampTree);
			};

			if (!isInFragmentDom(this)) {
				return doInsertTheNodes();
			}

			nodeArgs.forEach(prepareForInsertion);
			reframedMultiNodeDomInsertion(nodes, doInsertTheNodes, iframeDocument);
		};
	}

	function makeHtmlParsingOverrides(innerHTMLDescriptor: PropertyDescriptor): PropertyDescriptorMap {
		return {
			// scripts parsed from html never execute (per spec), so parsing only needs stamp propagation
			innerHTML: {
				configurable: true,
				enumerable: true,
				get(this: Element) {
					return innerHTMLDescriptor.get!.call(this);
				},
				set(this: Element, value: string) {
					innerHTMLDescriptor.set!.call(this, value);
					stampTree(this);
				},
			},
		};
	}

	const elementOverrides: PropertyDescriptorMap = {
		appendChild: { configurable: true, writable: true, value: makeSingleNodeInsertion(native.appendChild) },
		insertBefore: { configurable: true, writable: true, value: makeSingleNodeInsertion(native.insertBefore) },
		replaceChild: { configurable: true, writable: true, value: boundaryReplaceChild },
		insertAdjacentElement: { configurable: true, writable: true, value: boundaryInsertAdjacentElement },
		append: { configurable: true, writable: true, value: makeMultiNodeInsertion(native.elementAppend) },
		prepend: { configurable: true, writable: true, value: makeMultiNodeInsertion(native.elementPrepend) },
		replaceChildren: {
			configurable: true,
			writable: true,
			value: makeMultiNodeInsertion(native.elementReplaceChildren),
		},
		replaceWith: { configurable: true, writable: true, value: makeMultiNodeInsertion(native.elementReplaceWith) },
		insertAdjacentHTML: {
			configurable: true,
			writable: true,
			value: function boundaryInsertAdjacentHTML(this: Element, position: InsertPosition, text: string) {
				const result = native.insertAdjacentHTML.call(this, position, text);
				const lowercasePosition = String(position).toLowerCase();
				stampTree(
					lowercasePosition === 'afterbegin' || lowercasePosition === 'beforeend' ? this : this.parentNode ?? this,
				);
				return result;
			},
		},
		cloneNode: {
			configurable: true,
			writable: true,
			value: function boundaryCloneNode(this: Node, deep?: boolean) {
				const clone = native.cloneNode.call(this, deep);
				stampTree(clone);
				return clone;
			},
		},
		ownerDocument: {
			configurable: true,
			enumerable: true,
			get(this: Node) {
				return isInFragmentDom(this) ? iframeDocument : native.ownerDocument.call(this);
			},
		},
		getRootNode: {
			configurable: true,
			writable: true,
			value: function boundaryGetRootNode(this: Node, getRootNodeOptions?: GetRootNodeOptions) {
				const plainRoot = native.getRootNode.call(this);
				if (plainRoot === shadowRoot) {
					// matches the legacy global patch: nodes in a fragment report the fragment's document
					return iframeDocument;
				}
				return getRootNodeOptions ? native.getRootNode.call(this, getRootNodeOptions) : plainRoot;
			},
		},
		...makeHtmlParsingOverrides(native.elementInnerHTML),
	};

	function stampNode(node: Node): void {
		if (node.nodeType !== Node.ELEMENT_NODE) return;
		if (stampedNodes.has(node)) return;

		const proto = Object.getPrototypeOf(node);
		if (proto === null || stampedProtoSet.has(proto)) {
			stampedNodes.add(node);
			return;
		}

		let stampedProto = stampedProtos.get(proto);
		if (!stampedProto) {
			stampedProto = Object.create(proto, elementOverrides);
			stampedProtos.set(proto, stampedProto!);
			stampedProtoSet.add(stampedProto!);
		}
		Object.setPrototypeOf(node, stampedProto!);
		stampedNodes.add(node);
	}

	function stampTree(root: Node): void {
		if (root.nodeType === Node.ELEMENT_NODE) {
			stampNode(root);
		} else if (root.nodeType !== Node.DOCUMENT_FRAGMENT_NODE) {
			return;
		}
		(root as Element | DocumentFragment).querySelectorAll('*').forEach(stampNode);
	}

	/**
	 * Stamp the shadow root itself with own-property overrides (a shadow root is a per-fragment
	 * singleton, so instance properties are simpler than a spliced prototype and just as effective).
	 * Note: per legacy semantics the shadow root keeps its native ownerDocument/getRootNode behavior
	 * for `ownerDocument` (reporting the main document) — only insertions are intercepted.
	 */
	Object.defineProperties(shadowRoot, {
		appendChild: { configurable: true, writable: true, value: makeSingleNodeInsertion(native.appendChild) },
		insertBefore: { configurable: true, writable: true, value: makeSingleNodeInsertion(native.insertBefore) },
		replaceChild: { configurable: true, writable: true, value: boundaryReplaceChild },
		append: { configurable: true, writable: true, value: makeMultiNodeInsertion(native.fragmentAppend) },
		prepend: { configurable: true, writable: true, value: makeMultiNodeInsertion(native.fragmentPrepend) },
		replaceChildren: {
			configurable: true,
			writable: true,
			value: makeMultiNodeInsertion(native.fragmentReplaceChildren),
		},
		...makeHtmlParsingOverrides(native.shadowRootInnerHTML),
	});

	// stamp the initial fragment DOM (for pierced fragments this includes the SSR'ed content;
	// for fetched fragments this is the empty wf-document that the stream will fill through
	// stamped insertions)
	stampTree(wfDocumentElement);

	/**
	 * The boundary observer: activates inert scripts/preload-links that entered the fragment's DOM
	 * through unstamped paths, stamps stray subtrees, and reports bypasses in dev mode.
	 * Everything it does is idempotent with the synchronous stamped-insertion handling.
	 */
	const observer = new MutationObserver((records) => {
		for (const record of records) {
			for (const addedNode of record.addedNodes) {
				if (addedNode.nodeType !== Node.ELEMENT_NODE) continue;
				const addedElement = addedNode as Element;

				if (!stampedNodes.has(addedElement)) {
					if (import.meta.env.DEV && !warnedAboutUnstampedEntry) {
						warnedAboutUnstampedEntry = true;
						console.warn(
							`WebFragments: a node entered a fragment's DOM through a code path the fragment boundary doesn't intercept synchronously (e.g. a captured native DOM function).\n` +
								`Scripts inserted this way still execute in the fragment's JS context, but one microtask later than usual. Node:`,
							addedElement,
						);
					}
					stampTree(addedElement);
				}

				activateInertScriptsAndLinks(addedElement);
			}
		}
	});

	function activateInertScriptsAndLinks(root: Element): void {
		const inertSelector =
			'script[type="inert"],link[rel="inert-preload"],link[rel="inert-prefetch"],link[rel="inert-modulepreload"]';
		const candidates: (HTMLScriptElement | HTMLLinkElement)[] = [];
		if (root.matches(inertSelector)) {
			candidates.push(root as HTMLScriptElement | HTMLLinkElement);
		}
		candidates.push(...(root.querySelectorAll(inertSelector) as NodeListOf<HTMLScriptElement | HTMLLinkElement>));

		for (const candidate of candidates) {
			if (candidate instanceof HTMLLinkElement) {
				executeInertPreloadLink(candidate, iframeDocument);
			} else {
				if (!candidate.src && !candidate.textContent) {
					// an empty inert script can't execute; leave it be
					continue;
				}
				removeBornInertShadowing(candidate);
				restoreScriptType(candidate);
				executeInertScript(candidate, iframeDocument);
			}
		}
	}

	observer.observe(shadowRoot, { childList: true, subtree: true });
	abortSignal.addEventListener('abort', () => observer.disconnect());

	return {
		stampNode,
		stampTree,
		disconnect: () => observer.disconnect(),
	};
}
