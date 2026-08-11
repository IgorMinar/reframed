import { rewriteQuerySelector } from '../utils/selector-helpers';
import { FacadeOverrides } from './document-facade';

/**
 * Everything the document overrides need from the surrounding reframed context.
 *
 * All dependencies are injected so that this module stays free of imports with side effects and can be exercised by
 * unit tests outside of a browser.
 */
export interface DocumentOverridesContext {
	/** The document of the fragment's hidden iframe. */
	iframeDocument: Document;
	/** The main frame's document which owns the fragment's DOM. */
	mainDocument: Document;
	/** The `<wf-document>` element that acts as the fragment's virtual document element in the main DOM. */
	wfDocumentElement: HTMLElement;
	/** The shadow root of the `<web-fragment-host>` element that contains the fragment's DOM. */
	reframedShadowRoot: ShadowRoot;
	/** Whether the fragment's navigation is bound to the main window's navigation. */
	boundNavigation: boolean;
	/** Returns the virtualized readyState of the fragment's document. */
	getIframeDocumentReadyState: () => DocumentReadyState;
	/** Returns the inert clone (in the main DOM) of the script currently executing in the fragment's JS context. */
	getCurrentScript: () => HTMLScriptElement | undefined;
}

/**
 * Creates the facade overrides that virtualize the Document API surface for a reframed fragment.
 *
 * Each override redirects a Document member to operate on the fragment's DOM in the main document (the shadow root
 * of `<web-fragment-host>` and its `<wf-document>` element) instead of the hidden iframe's document.
 *
 * Every member overridden here must be classified as `'virtualized'` in `document-member-classification.ts`.
 */
export function createDocumentOverrides(ctx: DocumentOverridesContext): FacadeOverrides {
	const { iframeDocument, mainDocument, wfDocumentElement, reframedShadowRoot, boundNavigation } = ctx;

	return {
		title: {
			get: function () {
				return (
					// https://html.spec.whatwg.org/multipage/dom.html#document.title
					wfDocumentElement.querySelector('title')?.textContent?.trim() ?? '[reframed document]'
				);
			},
			set: function (newTitle: string) {
				const titleElement = wfDocumentElement.querySelector('title');
				if (titleElement) {
					titleElement.textContent = newTitle;
				}
				if (boundNavigation) {
					mainDocument.title = newTitle;
				}
			},
		},

		readyState: {
			get() {
				return ctx.getIframeDocumentReadyState();
			},
		},

		currentScript: {
			get() {
				return ctx.getCurrentScript();
			},
		},

		// redirect getElementById to be a scoped reframedContainer.querySelector query
		getElementById: {
			value(id: string) {
				return wfDocumentElement.querySelector(`[id="${id}"]`);
			},
		},

		getElementsByClassName: {
			value(names: string) {
				return wfDocumentElement.getElementsByClassName(names);
			},
		},

		getElementsByName: {
			value(name: string) {
				return wfDocumentElement.querySelector(`[name="${name}"]`);
			},
		},

		getElementsByTagNameNS: {
			value(namespaceURI: string | null, name: string) {
				return wfDocumentElement.getElementsByTagNameNS(namespaceURI, name);
			},
		},

		// redirect to mainDocument
		activeElement: {
			get: () => {
				return (
					reframedShadowRoot.activeElement ??
					(mainDocument.activeElement === mainDocument.body ? iframeDocument.body : null)
				);
			},
		},

		styleSheets: {
			get: () => {
				return reframedShadowRoot.styleSheets;
			},
		},

		adoptedStyleSheets: {
			get() {
				return reframedShadowRoot.adoptedStyleSheets;
			},
			set(value: CSSStyleSheet[]) {
				reframedShadowRoot.adoptedStyleSheets = value;
			},
		},

		dispatchEvent: {
			value(event: Event) {
				return wfDocumentElement.dispatchEvent(event);
			},
		},

		childElementCount: {
			get() {
				return wfDocumentElement.childElementCount;
			},
		},

		hasChildNodes: {
			value() {
				return wfDocumentElement.hasChildNodes();
			},
		},

		children: {
			get() {
				return wfDocumentElement.children;
			},
		},

		firstElementChild: {
			get() {
				return wfDocumentElement.firstElementChild;
			},
		},

		firstChild: {
			get() {
				return wfDocumentElement.firstChild;
			},
		},

		lastElementChild: {
			get() {
				return wfDocumentElement.lastElementChild;
			},
		},

		lastChild: {
			get() {
				return wfDocumentElement.lastChild;
			},
		},

		/**
		 * The following properties are references to special elements in a Document (html, head, body).
		 * The browser does not allow multiple instances of these elements within a Document,
		 * so we cannot render true <html>, <head>, <body> elements within the shadow root of a fragment.
		 *
		 * Instead, render custom elements (wf-html, wf-head, wf-body) that act like the html, head, and body.
		 * The tagName and nodeName properties of these custom elements are then
		 * patched to return "HTML", "HEAD", and "BODY", respectively.
		 *
		 * iframeDocument query methods must also be patched for custom wf-html, wf-head, and wf-body elements.
		 * CSS Selector queries that contain html,head,body tag selectors are rewritten to the custom elements
		 */
		querySelector: {
			value(selector: string) {
				return wfDocumentElement.querySelector(rewriteQuerySelector(selector));
			},
		},
		querySelectorAll: {
			value(selector: string) {
				return wfDocumentElement.querySelectorAll(rewriteQuerySelector(selector));
			},
		},
		getElementsByTagName: {
			value(tagName: string) {
				// The shadowRoot node itself does not have a getElementsByTagName method.
				// For html, head, and body, rely on the patched querySelectorAll method on iframeDocument.
				// This will return a NodeList instead of an HTMLCollection, which will suffice for most use cases.
				return wfDocumentElement.querySelectorAll(rewriteQuerySelector(tagName));
			},
		},
		documentElement: {
			get() {
				return wfDocumentElement.querySelector('wf-html') ?? wfDocumentElement.firstElementChild;
			},
		},
		head: {
			get() {
				return wfDocumentElement.querySelector('wf-head') ?? wfDocumentElement.firstElementChild;
			},
		},
		body: {
			get() {
				return wfDocumentElement.querySelector('wf-body') ?? wfDocumentElement.firstElementChild;
			},
		},

		// document.createElement & friends overrides: nodes must be created in the main document
		// so that they can be attached to the fragment's DOM without adoption
		...Object.fromEntries(
			(
				[
					'createAttributeNS',
					'createCDATASection',
					'createComment',
					'createDocumentFragment',
					'createEvent',
					'createExpression',
					'createNSResolver',
					'createNodeIterator',
					'createProcessingInstruction',
					'createRange',
					'createTextNode',
					'createTreeWalker',
				] as const
			).map((createProperty) => [
				createProperty,
				{
					value: function reframedCreateFn(...args: unknown[]) {
						// @ts-expect-error WTD?!?
						return mainDocument[createProperty].apply(mainDocument, args);
					},
				},
			]),
		),

		createElement: {
			value: function createElement(...[tagName, ...rest]: Parameters<Document['createElement']>) {
				return Document.prototype.createElement.apply(
					// create the element within iframeDocument if it contains a dash as it could be a custom element defined only in the iframe context
					tagName.includes('-') ? iframeDocument : mainDocument,
					[tagName, ...rest],
				);
			},
		},
		createElementNS: {
			value: function createElementNS(...[namespaceURI, tagName, ...rest]: Parameters<Document['createElementNS']>) {
				return Document.prototype.createElementNS.apply(
					// create the element within iframeDocument if it contains a dash as it could be a custom element defined only in the iframe context
					namespaceURI === 'http://www.w3.org/1999/xhtml' && tagName.includes('-') ? iframeDocument : mainDocument,
					[namespaceURI, tagName, ...rest] as Parameters<Document['createElementNS']>,
				);
			},
		},
	} satisfies Partial<Record<keyof Document, unknown>> as FacadeOverrides;
}
