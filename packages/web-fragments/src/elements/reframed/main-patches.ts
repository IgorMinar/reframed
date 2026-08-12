import { ReframedShadowRoot, reframedMetadataSymbol } from './reframed';
import { reframedDomInsertion, reframedMultiNodeDomInsertion } from './script-execution';

export function initializeMainContext(patchHistory: boolean) {
	if (!(reframedInitializedSymbol in window)) {
		Object.assign(window, { [reframedInitializedSymbol]: true });
		monkeyPatchDOMInsertionMethods();
		monkeyPatchMiscNodeMethods();
	}

	if (patchHistory && !(reframedInitializedHistoryPatchSymbol in window)) {
		Object.assign(window, { [reframedInitializedHistoryPatchSymbol]: true });
		monkeyPatchHistoryAPI();
	}
}

const reframedInitializedSymbol = Symbol('reframed:initialized');
const reframedInitializedHistoryPatchSymbol = Symbol('reframed:initializedHistoryPatch');

const unpatchedNodeProto = {
	appendChild: Node.prototype.appendChild,
	insertBefore: Node.prototype.insertBefore,
	replaceChild: Node.prototype.replaceChild,
	getRootNode: Node.prototype.getRootNode,
};

const unpatchedElementProto = {
	after: Element.prototype.after,
	append: Element.prototype.append,
	prepend: Element.prototype.prepend,
	replaceChildren: Element.prototype.replaceChildren,
	replaceWith: Element.prototype.replaceWith,
	insertAdjacentElement: Element.prototype.insertAdjacentElement,
};

/**
 * Returns the iframe document associated with a fragment if the `node` passed is part of the fragment.
 *
 * The `includeShadowRoot` flag is useful because when `node` is the fragment's shadowroot, there are times when we want to consider it to be part of the fragment and other times when when we want it to be considered outside of the fragment's dom.
 *
 * Because the fragment's shadowroot is a boundary between the virtualized and non-virtualized DOM, it is being interacted with by both the code running in the iframe and the code running in the main frame. This is why we need to be able to treat it correctly in both contexts.
 *
 * Good example of shadowroot being considered to be part of the fragment is when we are appending a new child to the shadowroot, and we need to get hold of the iframe document so that we execute any scripts being appended in the iframe.
 *
 * On the other hand if a code executing in the main frame is checking `ownerDocument` of the shadowroot, we don't want to expose the iframe document.
 *
 * @param node
 * @param includeShadowRoot  If true, consider the shadow root node to be part of the fragment and return the iframe document, otherwise return undefined.
 * @returns
 */
function getIframeDocumentIfWithinReframedDom(node: Node, includeShadowRoot = true) {
	const root = unpatchedNodeProto.getRootNode.call(node) as ReframedShadowRoot;
	// if the node is a shadowroot then return nothing.
	if (root === node && !includeShadowRoot) {
		return undefined;
	}
	return root?.[reframedMetadataSymbol]?.iframe.contentDocument ?? undefined;
}

function monkeyPatchDOMInsertionMethods() {
	Node.prototype.appendChild = function appendChild<T extends Node>(this: Node, childNode: T): T {
		const doInsertTheNode = () => unpatchedNodeProto.appendChild.apply(this, arguments as any) as T;
		const iframeDocument = getIframeDocumentIfWithinReframedDom(this);
		return reframedDomInsertion(childNode, doInsertTheNode, iframeDocument);
	};

	Node.prototype.insertBefore = function insertBefore<T extends Node>(this: Node, childNode: T): T {
		const doInsertTheNode = () => unpatchedNodeProto.insertBefore.apply(this, arguments as any) as T;
		const iframeDocument = getIframeDocumentIfWithinReframedDom(this);
		return reframedDomInsertion(childNode, doInsertTheNode, iframeDocument);
	};

	Node.prototype.replaceChild = function replaceChild<T extends Node>(this: Node, childNode: Node, oldChildNode: T): T {
		const doInsertTheNode = () => unpatchedNodeProto.replaceChild.apply(this, arguments as any) as T;
		const iframeDocument = getIframeDocumentIfWithinReframedDom(this);
		reframedDomInsertion(childNode, doInsertTheNode, iframeDocument);
		return oldChildNode;
	};

	Element.prototype.insertAdjacentElement = function after<T extends Element>(
		this: Element,
		where: InsertPosition,
		element: T,
	): T | null {
		const doInsertTheNode = () => unpatchedElementProto.insertAdjacentElement.apply(this, arguments as any) as T;
		const iframeDocument = getIframeDocumentIfWithinReframedDom(this);
		return reframedDomInsertion(element, doInsertTheNode, iframeDocument);
	} satisfies typeof Element.prototype.insertAdjacentElement;

	(['append', 'prepend', 'replaceChildren', 'replaceWith'] as const).forEach((elementInsertionMethod) => {
		Element.prototype[elementInsertionMethod] = function patchedElementInsertion(...nodes) {
			const iframeDocument = getIframeDocumentIfWithinReframedDom(this);
			reframedMultiNodeDomInsertion(
				nodes,
				() => unpatchedElementProto[elementInsertionMethod].apply(this, arguments as any),
				iframeDocument,
			);
		};
	});
}

function monkeyPatchMiscNodeMethods() {
	// https://developer.mozilla.org/en-US/docs/Web/API/Node/ownerDocument
	const _Node__ownerDocument = Object.getOwnPropertyDescriptor(Node.prototype, 'ownerDocument')!.get!;
	Object.defineProperty(Node.prototype, 'ownerDocument', {
		configurable: true,
		enumerable: true,
		get() {
			const iframeDocument = getIframeDocumentIfWithinReframedDom(this, false);
			if (iframeDocument) {
				return iframeDocument;
			}
			return _Node__ownerDocument.call(this);
		},
	});

	// https://developer.mozilla.org/en-US/docs/Web/API/Node/getRootNode
	const _Node_getRootNode = Node.prototype.getRootNode;
	Node.prototype.getRootNode = function getRootNode(options) {
		const realRoot = _Node_getRootNode.call(this);
		const iframeDocument = getIframeDocumentIfWithinReframedDom(realRoot);
		if (iframeDocument) {
			return iframeDocument;
		}
		return !options ? realRoot : _Node_getRootNode.call(this, options);
	};
}

function monkeyPatchHistoryAPI() {
	/**
	 * window.location is read-only and non-configurable, so we can't patch it
	 *
	 * In a browsing context with one or more iframes, the history all frames contribute to
	 * is the joint history: https://www.w3.org/TR/2011/WD-html5-20110525/history.html#joint-session-history.
	 * This means that we need to be careful not to add duplicate entries to the
	 * history stack via pushState within the iframe as that would double the
	 * number of history entries that back/forward button would have to work through
	 *
	 * Therefore we do the following:
	 * - Store all the original history functions for both the iframe and the main window.
	 * - intercept all history.pushState history.replaceState calls and replay them in the main window
	 * - update the window.location within the iframe via history.replaceState
	 * - intercept window.addEventListener('popstate', ...) registration and forward it onto the main window
	 * - restore the main window history prototype when the iframe is removed
	 *
	 * Make sure we only patch main window history once
	 */

	const historyMethods: (keyof Omit<History, 'length'>)[] = ['pushState', 'replaceState', 'back', 'forward', 'go'];

	historyMethods.forEach((historyMethod) => {
		const originalFn = window.history[historyMethod];

		Object.defineProperty(window.history, historyMethod, {
			// TODO: come up with a better workaround that a no-op setter that doesn't break Qwik.
			// QwikCity tries to monkey-patch `pushState` and `replaceState` which results in a runtime error:
			//   TypeError: Cannot set property pushState of #<History> which only has a getter
			// https://github.com/QwikDev/qwik/blob/3c5e5a7614c3f64cbf89f1304dd59609053eddf0/packages/qwik-city/runtime/src/spa-init.ts#L127-L135
			set: () => {},
			get: () => {
				return function reframedHistoryGetter() {
					Reflect.apply(originalFn, window.history, arguments);
					window.dispatchEvent(new CustomEvent('reframed:navigate'));
				};
			},
			configurable: true,
		});
	});
}
