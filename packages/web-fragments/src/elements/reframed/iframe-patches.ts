import { ReframedShadowRoot, reframedMetadataSymbol } from './reframed';
import { execToInertScriptMap } from './script-execution';
import { assert } from './utils/assert';
import { rewriteQuerySelector } from './utils/selector-helpers';

/**
 * Apply monkey-patches to the source iframe so that we trick code running in it to behave as if it
 * was running in the main frame.
 */
export function initializeIFrameContext(
	iframe: HTMLIFrameElement,
	reframedShadowRoot: ReframedShadowRoot,
	wfDocumentElement: HTMLElement,
	boundNavigation: boolean,
) {
	assert(
		iframe.contentWindow !== null && iframe.contentDocument !== null,
		'attempted to patch iframe before it was ready',
	);

	const iframeWindow = iframe.contentWindow as Window & typeof globalThis;
	const iframeDocument = iframe.contentDocument;

	// When an iframe element is added to the page, it always triggers a load event
	// even if the src is empty. In this case, don't monkey patch the iframe document
	// because we will end up doing it twice.
	if (iframeWindow?.location.origin === 'null' && iframeWindow?.location.protocol === 'about:') {
		return;
	}

	const mainDocument = reframedShadowRoot.host.ownerDocument;
	const mainWindow = mainDocument.defaultView!;

	// Create an abort controller we'll use to remove any event listeners when the fragment is destroyed
	const fragmentAbortController = new AbortController();

	// cleanup event listeners attached to the window when the iframe gets destroyed.
	// TODO: using the "pagehide" event would be preferred over the discouraged "unload" event,
	// but we'd need to figure out how to restore the previously attached event if the page is resumed from the bfcache
	iframeWindow.addEventListener('unload', () => fragmentAbortController.abort());

	/** ---------------------------------------------- Window Patches ------------------------------------------------ */

	/**
	 * START> WINDOW: GLOBAL CONSTRUCTORS PATCHES
	 */
	const globalConstructors: Function[] = Object.entries(Object.getOwnPropertyDescriptors(iframeWindow)).flatMap(
		([property, descriptor]) =>
			/^[A-Z]/.test(property) && typeof descriptor.value === 'function' ? descriptor.value : [],
	);

	function hasInstance(this: Function, instance: any) {
		const parentContextConstructor: Function = mainWindow[this.name as keyof typeof mainWindow];

		return (
			Function.prototype[Symbol.hasInstance].call(this, instance) ||
			(typeof parentContextConstructor === 'function' && instance instanceof parentContextConstructor)
		);
	}

	// extend global constructors to support instanceof checks using
	// their equivalent constructor from the parent execution context
	globalConstructors.forEach((constructor) => {
		try {
			Object.defineProperty(constructor, Symbol.hasInstance, {
				value: hasInstance,
			});
		} catch (e) {
			console.warn(
				`WebFragments: failed to patch \`${constructor.name}[Symbol.hasInstance]\`\nA browser extension might be interfering with the browser APIs...\nSome application functionality may not work as expected!`,
				'\nError:',
				e,
				`\nDescriptor:`,
				Object.getOwnPropertyDescriptor(constructor, Symbol.hasInstance),
			);
		}
	});
	// END> WINDOW: GLOBAL CONSTRUCTORS PATCHES

	/**
	 * START> WINDOW: MISC PATCHES
	 */
	iframeWindow.IntersectionObserver = mainWindow.IntersectionObserver;
	iframeWindow.MutationObserver = mainWindow.MutationObserver;
	iframeWindow.ResizeObserver = mainWindow.ResizeObserver;

	// CSSStyleSheet don't work across documents, so we need to use the constructor from the main context
	iframeWindow.CSSStyleSheet = mainWindow.CSSStyleSheet;

	iframeWindow.matchMedia = mainWindow.matchMedia.bind(mainWindow); // needs to be bound to mainWindow otherwise operates on the iframe window
	// the navigator API is defined as enumerable and configurable property with a getter and an undefined setter
	Object.defineProperty(iframeWindow, 'navigator', {
		set: undefined,
		get: () => mainWindow.navigator,
		configurable: true,
		enumerable: true,
	});

	// dispatch events onto the shadowRoot if the event is not one of the special iframe events
	const originalDispatchEvent = iframeWindow.dispatchEvent.bind(iframeWindow);
	iframeWindow.dispatchEvent = function reframedDispatchEvent(event: Event): boolean {
		if (iframeEvents.includes(event?.type)) {
			return originalDispatchEvent(event);
		} else {
			return reframedShadowRoot.dispatchEvent(event);
		}
	};

	const windowSizeProperties: (keyof Pick<
		Window,
		'innerHeight' | 'innerWidth' | 'outerHeight' | 'outerWidth' | 'visualViewport'
	>)[] = ['innerHeight', 'innerWidth', 'outerHeight', 'outerWidth', 'visualViewport'];
	for (const windowSizeProperty of windowSizeProperties) {
		Object.defineProperty(iframeWindow, windowSizeProperty, {
			get: function reframedWindowSizeGetter() {
				return mainWindow[windowSizeProperty];
			},
		});
	}
	// END> WINDOW: MISC PATCHES

	/**
	 * START> WINDOW: HISTORY PATCHES
	 */

	// WARNING: Be sure this class stays declared inside of this function!
	// We rely on each reframed context having its own instance of this constructor
	// so we can use an instanceof check to avoid double-handling the event inside
	// the same context it was dispatched from.
	class SyntheticPopStateEvent extends PopStateEvent {}

	if (boundNavigation) {
		setInternalReference(iframeWindow, 'history');

		const historyProxy = new Proxy(mainWindow.history, {
			get(target, property, receiver) {
				if (typeof Object.getOwnPropertyDescriptor(History.prototype, property)?.value === 'function') {
					return function (this: unknown, ...args: unknown[]) {
						const result = Reflect.apply(
							History.prototype[property as keyof History],
							this === receiver ? target : this,
							args,
						);

						// dispatch a popstate event on the main window to inform listeners of a location change
						mainWindow.dispatchEvent(new SyntheticPopStateEvent('popstate'));
						return result;
					};
				}

				return Reflect.get(target, property, target);
			},
			set(target, property, receiver) {
				return Reflect.set(target, property, receiver);
			},
		});

		Object.defineProperties(iframeWindow, {
			history: {
				get() {
					return historyProxy;
				},
				configurable: true,
			},
		});
	} else {
		const standaloneHistoryStack: Array<{ state: any; title: string; url: string | null }> = [
			{ state: iframeWindow.history.state, title: iframeDocument.title, url: iframeWindow.location.href },
		];
		let standaloneHistoryCursor = 0;

		// for standalone fragments we should always use replaceState instead of pushState so that we don't create unexpected history entries
		// in order for back() and forward() to work correctly, we need to implement our own history stack with the behavior similar to window.history
		Object.defineProperties(iframeWindow.history, {
			pushState: {
				value: function reframedStandalonePushState(state: any, title: string, url?: string | null) {
					if (standaloneHistoryCursor !== standaloneHistoryStack.length - 1) {
						standaloneHistoryStack.splice(standaloneHistoryCursor + 1);
					}
					standaloneHistoryStack.push({ state, title, url: url ?? null });
					standaloneHistoryCursor++;
					iframeWindow.history.replaceState(state, title, url);
				},
				writable: true,
				configurable: true,
			},

			back: {
				value: function reframedStandaloneBack() {
					if (standaloneHistoryCursor === 0) return;

					standaloneHistoryCursor--;

					let { state, title, url } = standaloneHistoryStack[standaloneHistoryCursor];
					iframeWindow.history.replaceState(state, title, url);
				},
				writable: true,
				configurable: true,
			},

			forward: {
				value: function reframedStandaloneForward() {
					if (standaloneHistoryCursor === standaloneHistoryStack.length - 1) return;

					standaloneHistoryCursor++;

					let { state, title, url } = standaloneHistoryStack[standaloneHistoryCursor];
					iframeWindow.history.replaceState(state, title, url);
				},
				writable: true,
				configurable: true,
			},

			length: {
				get() {
					return standaloneHistoryStack.length;
				},
				configurable: true,
			},
		});
	}

	if (boundNavigation) {
		// When a navigation event occurs on the main window, either programmatically through the History API or by the back/forward button,
		// we need to reflect those changes onto the iframe's location via history.replaceState().
		// Finally, dispatch a PopStateEvent so that fragments that are listening to popstate event are
		// made aware of a location change and retrigger their render updates.
		const handleNavigate = (e: Event) => {
			getInternalReference(iframeWindow, 'history').replaceState(window.history.state, '', window.location.href);

			if (e instanceof SyntheticPopStateEvent) {
				return;
			}

			iframeWindow.dispatchEvent(new PopStateEvent('popstate', e instanceof PopStateEvent ? e : undefined));
		};

		// reframed:navigate event is triggered by the patched main window.history methods
		window.addEventListener('reframed:navigate', handleNavigate, {
			signal: fragmentAbortController.signal,
		});

		// Forward the popstate event triggered on the main window to every registered iframe window
		window.addEventListener('popstate', handleNavigate, {
			signal: fragmentAbortController.signal,
		});
	}
	// END> WINDOW: HISTORY PATCHES

	/** ---------------------------------------------- Document Patches ------------------------------------------------ */

	/**
	 * START> DOCUMENT PATCHES
	 */
	setInternalReference(iframeDocument, 'body');

	const getUnpatchedIframeDocumentCurrentScript = Object.getOwnPropertyDescriptor(
		Object.getPrototypeOf(Object.getPrototypeOf(iframeDocument)),
		'currentScript',
	)!.get!.bind(iframeDocument);

	Object.defineProperties(iframeDocument, {
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
				return reframedShadowRoot[reframedMetadataSymbol].iframeDocumentReadyState;
			},
		},

		currentScript: {
			get() {
				// grab the currently executing script in the iframe, and map it to its clone in the main document
				return execToInertScriptMap.get(getUnpatchedIframeDocumentCurrentScript());
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
			value(id: string) {
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
	} satisfies Partial<Record<keyof Document, any>>);

	// document.createElement & friends patches
	const domCreateProperties: (keyof Pick<
		Document,
		| 'createAttributeNS'
		| 'createCDATASection'
		| 'createComment'
		| 'createDocumentFragment'
		| 'createEvent'
		| 'createExpression'
		| 'createNSResolver'
		| 'createNodeIterator'
		| 'createProcessingInstruction'
		| 'createRange'
		| 'createTextNode'
		| 'createTreeWalker'
	>)[] = [
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
	];
	for (const createProperty of domCreateProperties) {
		Object.defineProperty(iframeDocument, createProperty, {
			value: function reframedCreateFn() {
				// @ts-expect-error WTD?!?
				return mainDocument[createProperty].apply(mainDocument, arguments);
			},
		});
	}

	Object.defineProperties(iframeDocument, {
		createElement: {
			value: function createElement(...[tagName]: Parameters<Document['createElement']>) {
				return Document.prototype.createElement.apply(
					// create the element within iframeDocument if it contains a dash as it could be a custom element defined only in the iframe context
					tagName.includes('-') ? iframeDocument : mainDocument,
					arguments as any,
				);
			},
		},
		createElementNS: {
			value: function createElementNS(...[namespaceURI, tagName]: Parameters<Document['createElementNS']>) {
				return Document.prototype.createElementNS.apply(
					// create the element within iframeDocument if it contains a dash as it could be a custom element defined only in the iframe context
					namespaceURI === 'http://www.w3.org/1999/xhtml' && tagName.includes('-') ? iframeDocument : mainDocument,
					arguments as any,
				);
			},
		},
	});
	// END> DOCUMENT PATCHES

	/** ---------------------------------------------- Event System Patches ------------------------------------------------ */
	/**	 						spec: packages/web-fragments/test/playground/reframed-event-registration/spec.md 												 */

	/**
	 * START> EVENT SYSTEM PATCHES
	 */

	// A list of events for which we don't want to retarget listeners as these events are dispatched in the iframe.
	const iframeEvents = ['load', 'popstate', 'beforeunload', 'unload'];

	// Maps iframe EventTargets (window and document) to a target in the main context
	const iframeTargetToReframedTarget = (target: EventTarget): EventTarget => {
		switch (target) {
			case iframeWindow:
				return reframedShadowRoot;
			case iframeDocument:
				return wfDocumentElement;
			default:
				return target;
		}
	};

	const mainTargetToReframedTarget = (target: EventTarget): EventTarget => {
		switch (target) {
			case mainWindow:
				return iframeWindow;
			case mainDocument:
				return iframeDocument;
			case mainDocument.documentElement:
				return iframeDocument.documentElement;
			case mainDocument.body:
				return iframeDocument.body;
			default:
				console.warn('reframed events: Unknown main context target: ', target);
				return target;
		}
	};

	const reframedTargetToMainTarget = (target: EventTarget): EventTarget => {
		switch (target) {
			case reframedShadowRoot:
				return mainWindow;
			case wfDocumentElement:
				return mainDocument;
			case iframeDocument.documentElement:
				return mainDocument.documentElement;
			case iframeDocument.body:
				return mainDocument.body;
			default:
				console.warn('reframed events: Unknown reframed context target: ', target);
				return target;
		}
	};

	// Weak map that maps app provided listeners to listeners actually registered with the DOM.
	// The main purpose of this map is to facilitate deregistration of event listeners
	const appToReframedListenerMap = new WeakMap<
		EventListener,
		{ reframedListener: EventListener; mainProxyListener: EventListener }
	>();

	// Redirect event listeners (except for `iframeEvents` defined above)
	// from the iframe window or document to the shadow root.
	const reframedAddEventListener = new Proxy(iframeWindow.EventTarget.prototype.addEventListener, {
		apply(
			originalAddEventListener,
			originalListenerTarget,
			argumentsList: Parameters<typeof iframeWindow.EventTarget.prototype.addEventListener>,
		) {
			const [eventName, appListenerOrObject, optionsOrCapture] = argumentsList;

			// if the app didn't pass a listener, ignore the call
			if (!appListenerOrObject) return;

			if (!originalListenerTarget) {
				// addEventListener call be call unbound, in which case the target is the iframe window
				originalListenerTarget = iframeWindow;
			}

			// if the event is an iframe event, then skip everything and register the listener directly on the iframe window
			if (iframeEvents.includes(eventName) && originalListenerTarget === iframeWindow) {
				originalAddEventListener.call(iframeWindow, eventName, appListenerOrObject, optionsOrCapture);
				return;
			}

			// normalize the options object
			const options =
				typeof optionsOrCapture === 'boolean'
					? { capture: optionsOrCapture }
					: typeof optionsOrCapture === 'object'
						? optionsOrCapture ?? {}
						: {};

			// browsers default to passive events for the following events
			// https://dom.spec.whatwg.org/#default-passive-value
			if (
				!('passive' in options) &&
				(eventName === 'mousewheel' ||
					eventName === 'touchstart' ||
					eventName === 'touchmove' ||
					eventName === 'wheel') &&
				(originalListenerTarget === iframeWindow ||
					originalListenerTarget === iframeDocument ||
					originalListenerTarget === iframeDocument.documentElement ||
					originalListenerTarget === iframeDocument.body)
			) {
				options.passive = true;
			}

			// normalize appListener
			const appListener =
				typeof appListenerOrObject === 'object' ? appListenerOrObject?.handleEvent : appListenerOrObject;

			if (!appListener) {
				// this is some kind of unknown listener, possibly feature detection for passive event support like the one performed by react
				// https://github.com/facebook/react/blob/4a1f29079ccc61659e026bbcf205bc8d53780927/packages/react-dom-bindings/src/events/checkPassiveEvents.js#L26-L27
				Reflect.apply(originalAddEventListener, originalListenerTarget, argumentsList);
				return;
			}

			// reuse or create if needed a wrapper around the appListener that will patch the event to make it look an event the app receives in a standalone mode.
			let { reframedListener, mainProxyListener } = appToReframedListenerMap.get(appListener) ?? {};

			if (!reframedListener || !mainProxyListener) {
				// create the reframed listener
				reframedListener = function reframedListener(event: Event) {
					// capture properties of the original event
					const originalEventProps = {
						target: event.target,
						currentTarget: event.currentTarget,
						// TODO(perf): could we defer the composedPath() call until we actually need it
						composedPath: event.composedPath(),
					};

					// rewrite the composedPath by removing any references to the main or reframed objects
					let reframedComposedPath = [...originalEventProps.composedPath];

					if (reframedComposedPath.length === 1 && reframedComposedPath[0] === reframedShadowRoot) {
						reframedComposedPath = [iframeWindow];
					} else {
						reframedComposedPath.splice(
							// remove wfDocumentElement and everything above it
							originalEventProps.composedPath.indexOf(wfDocumentElement),
							Infinity,
							// and add the iframeDocument and iframeWindow to the list
							iframeDocument,
							iframeWindow,
						);
					}

					// patch the event
					const originalEventPrototype = Object.getPrototypeOf(event);
					const eventPatch = Object.create(originalEventPrototype, {
						currentTarget: {
							get() {
								return originalListenerTarget;
							},
						},

						composedPath: {
							value: () => {
								return reframedComposedPath;
							},
						},

						target: {
							get() {
								return originalEventProps.target === reframedShadowRoot ? iframeWindow : originalEventProps.target;
							},
						},
					});

					if (event instanceof UIEvent) {
						Object.defineProperty(eventPatch, 'view', {
							get() {
								return iframeWindow;
							},
						});
					}

					// splice the patched event object into the prototype chain, this ensures that:
					// - the instanceof checks keep on working
					// - the isTrusted property is preserved
					// - the properties need to patch get overshadowed in the prototypical lookup with our patched version
					// - unpatching the event is as simple as re-splicing the prototype chain later and removing this object
					Object.setPrototypeOf(event, eventPatch);

					try {
						appListener.call(originalListenerTarget, event);
					} finally {
						// unpatch the event
						Object.setPrototypeOf(event, originalEventPrototype);
					}
				};

				// create the proxy listener retargeting the events from the main context
				mainProxyListener = function reframedProxyListener(event) {
					if (
						event.target !== mainWindow &&
						event.target !== mainDocument &&
						event.target !== mainDocument.documentElement &&
						event.target !== mainDocument.body
					) {
						// if the event doesn't target any of the main top level EvenTargets then we can ignore it
						// it is either not relevant for us or it targets an element in the reframed DOM and we'll handle it once it trickles down there
						// TODO: Do we want to allow list a few events such as click, pointerdown, mousedown, etc. and pass those along if they target an element outside of the fragment?
						// 			 This would allow us to handle modal dialog dismissals, without full page overlays.
						return;
					}

					// capture properties of the original event
					const originalEventProps = {
						target: event.target,
						currentTarget: event.currentTarget,
					};

					// rewrite the composedPath by removing any references to the main or reframed objects
					const reframedComposedPath = event.composedPath().map(mainTargetToReframedTarget);

					// patch the event
					const originalEventPrototype = Object.getPrototypeOf(event);
					const eventPatch = Object.create(originalEventPrototype, {
						currentTarget: {
							get() {
								return originalListenerTarget;
							},
						},

						target: {
							get() {
								return mainTargetToReframedTarget(originalEventProps.target);
							},
						},

						composedPath: {
							value: () => {
								return reframedComposedPath;
							},
						},
					});

					if (event instanceof UIEvent) {
						Object.defineProperty(eventPatch, 'view', {
							get() {
								return iframeWindow;
							},
						});
					}

					// splice the patched event object into the prototype chain, this ensures that:
					// - the instanceof checks keep on working
					// - the isTrusted property is preserved
					// - the properties need to patch get overshadowed in the prototypical lookup with our patched version
					// - unpatching the event is as simple as re-splicing the prototype chain later and removing this object
					Object.setPrototypeOf(event, eventPatch);

					try {
						appListener.call(originalListenerTarget, event);
					} finally {
						// unpatch the event
						Object.setPrototypeOf(event, originalEventPrototype);
					}
				};

				appToReframedListenerMap.set(appListener, {
					reframedListener,
					mainProxyListener,
				});
			}

			// determine the actual registration target within the reframed DOM tree
			const reframedListenerTarget = iframeTargetToReframedTarget(originalListenerTarget);
			const modifiedArgumentsList = [eventName, reframedListener, options];
			Reflect.apply(originalAddEventListener, reframedListenerTarget, modifiedArgumentsList);

			if (eventName === 'DOMContentLoaded' || eventName === 'readystatechange') {
				// DOMContentLoaded and readystatechange events is special in that it doesn't require shadow listeners
				// we dispatch them ourselves on the iframe document
				return;
			}

			// and now let's register the shadow listener onto the main window
			const mainProxyListenerTarget = reframedTargetToMainTarget(reframedListenerTarget);

			// coalesce any provided signal with the one from our abort controller so that we can remove this listener when the fragment is destroyed
			const mainProxyListenerAbortSignal = AbortSignal.any(
				[fragmentAbortController.signal, options?.signal].filter((signal) => signal != null),
			);
			const mainProxyListenerOptions = {
				...options,
				signal: mainProxyListenerAbortSignal,
			} as AddEventListenerOptions;

			// register the listener on the main window, document, <html>, or <body> target
			mainProxyListenerTarget.addEventListener(eventName, mainProxyListener, mainProxyListenerOptions);
		},
	});

	const reframedRemoveEventListener = new Proxy(iframeWindow.EventTarget.prototype.removeEventListener, {
		apply(originalRemoveEventListener, originalListenerTarget, argumentsList) {
			const [eventName, appListenerOrObject, optionsOrCapture] = argumentsList as Parameters<
				typeof originalRemoveEventListener
			>;

			if (!appListenerOrObject) return;

			if (!originalListenerTarget) {
				// removeEventListener call be call unbound, in which case the target is the iframe window
				originalListenerTarget = iframeWindow;
			}

			// if the event is an iframe event, then skip everything and register the listener directly on the iframe window
			if (iframeEvents.includes(eventName) && originalListenerTarget === iframeWindow) {
				originalRemoveEventListener.call(iframeWindow, eventName, appListenerOrObject, optionsOrCapture);
				return;
			}

			const appListener =
				typeof appListenerOrObject === 'object' ? appListenerOrObject?.handleEvent : appListenerOrObject;

			if (!appListener) {
				// this is some kind of unknown listener, possibly feature detection for passive event support like the one performed by react
				// https://github.com/facebook/react/blob/4a1f29079ccc61659e026bbcf205bc8d53780927/packages/react-dom-bindings/src/events/checkPassiveEvents.js#L26-L27
				Reflect.apply(originalRemoveEventListener, originalListenerTarget, argumentsList);
				return;
			}

			const reframedListenerTarget = iframeTargetToReframedTarget(originalListenerTarget);
			const reframedListeners = appToReframedListenerMap.get(appListener);

			if (!reframedListeners) {
				// we never added this listener, so it likely isn't registered, pass it through just in case
				Reflect.apply(originalRemoveEventListener, originalListenerTarget, argumentsList);
				return;
			}
			const { reframedListener, mainProxyListener } = reframedListeners;
			const modifiedArgumentsList = [eventName, reframedListener, optionsOrCapture];

			Reflect.apply(originalRemoveEventListener, reframedListenerTarget, modifiedArgumentsList);
			mainWindow.removeEventListener(eventName, mainProxyListener, optionsOrCapture);
		},
	});

	iframeWindow.addEventListener = iframeDocument.addEventListener = reframedAddEventListener;
	iframeWindow.removeEventListener = iframeDocument.removeEventListener = reframedRemoveEventListener;

	// END: EVENT SYSTEM PATCHES
}

const reframedReferencesSymbol = Symbol('reframed:references');

function setInternalReference<T extends object>(target: T, key: keyof T) {
	(target as any)[reframedReferencesSymbol] ??= {};
	(target as any)[reframedReferencesSymbol][key] = Reflect.get(target, key);
}

export function getInternalReference<T extends object, K extends keyof T>(target: T, key: K): T[K] {
	const references = (target as any)[reframedReferencesSymbol];
	if (!references || references[key] === undefined) {
		throw new Error(`Attempted to access internal reference "${String(key)}" before it was set.`);
	}

	return references[key];
}
