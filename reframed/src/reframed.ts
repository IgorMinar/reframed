import WritableDOMStream from "writable-dom";

/**
 *
 * @param reframedSrc url of an http endpoint that will generate html stream to be reframed.
 * @param containerTagName tag name of the HTMLElement that will be created and used as the target container.
 *    The default is [`article`](https://developer.mozilla.org/en-US/docs/Web/HTML/Element/article).
 * @returns
 */
export function reframed(reframedSrc: string, options: {container?: HTMLElement, containerTagName: string} = { containerTagName: "article"}): HTMLElement {
  // create the reframed container
  const reframedContainer = options.container ?? document.createElement(options.containerTagName);
  reframedContainer.setAttribute('reframed-src', reframedSrc)

  // kick off reframing but don't wait for it
  reframe(reframedSrc, reframedContainer);

  return reframedContainer;
}

async function reframe(reframedSrc: string, reframedContainer: HTMLElement) {
  console.debug("reframing!", { source: reframedSrc, targetContainer: reframedContainer.outerHTML });

  const reframedHtmlResponse = await fetch(reframedSrc);
  const reframedHtmlStream =
    reframedHtmlResponse.status === 200
      ? await reframedHtmlResponse.body!
      : stringToStream(
          `error fetching ${reframedSrc} (HTTP Status = ${
            reframedHtmlResponse.status
          })<hr>${await reframedHtmlResponse.text()}`
        );

  // create shadow root to isolate styles
  const shadowRoot = reframedContainer.attachShadow({ mode: 'open' });
  // create a hidden iframe and use it isolate JavaScript scripts
  const iframe = document.createElement("iframe");
  iframe.name = reframedSrc;
  iframe.hidden = true;
  iframe.src = reframedSrc;

  const { promise, resolve } = Promise.withResolvers();

  iframe.addEventListener("load", () => {
    const iframeDocument = iframe.contentDocument;
    assert(iframeDocument !== null, "iframe.contentDocument is defined");

    monkeyPatchIFrameDocument(iframeDocument, shadowRoot);

    reframedHtmlStream
      .pipeThrough(new TextDecoderStream())
      .pipeTo(new WritableDOMStream(shadowRoot, { scriptLoadingDocument: iframeDocument }))
      .finally(() => {
        console.log("reframing done!", {
          source: reframedSrc,
          targetContainer: reframedContainer,
          title: iframeDocument.defaultView!.document.title,
        });
        resolve(undefined);
      });
  });

  // append iframe to the document to activate loading it
  document.body.insertAdjacentElement("beforeend", iframe);

  return promise;
}

/**
 * Apply monkey-patches to the source iframe so that we trick code running in it to behave as if it
 * was running in the main frame.
 */
function monkeyPatchIFrameDocument(iframeDocument: Document, shadowRoot: ShadowRoot): void {
  const iframeDocumentPrototype = Object.getPrototypeOf(Object.getPrototypeOf(iframeDocument));
  const mainDocument = shadowRoot.ownerDocument;
  const mainDocumentPrototype = Object.getPrototypeOf(Object.getPrototypeOf(mainDocument));
  const mainWindow = mainDocument.defaultView!;
  const iframeWindow = iframeDocument.defaultView!;
  let updatedIframeTitle: string | undefined = undefined;

  const unpatchedIframeDocumentPrototypeProps = Object.getOwnPropertyDescriptors(iframeDocumentPrototype);
  const unpatchedIframeBody = iframeDocument.body;

  Object.defineProperties(iframeDocumentPrototype, {
    title: {
      get: function () {
        return (
          updatedIframeTitle ??
          // https://html.spec.whatwg.org/multipage/dom.html#document.title
          shadowRoot.querySelector("title")?.textContent?.trim() ??
          "[reframed document]"
        );
      },
      set: function (newTitle: string) {
        updatedIframeTitle = newTitle;
      },
    },

    // redirect getElementById to be a scoped reframedContainer.querySelector query
    getElementById: {
      value(id: string) {
        return shadowRoot.querySelector(`#${id}`);
      },
    },

    // redirect getElementsByName to be a scoped reframedContainer.querySelector query
    getElementsByName: {
      value(name: string) {
        return shadowRoot.querySelector(`[name="${name}"]`);
      },
    },

    // redirect querySelector to be a scoped reframedContainer.querySelector query
    querySelector: {
      value(selector: string) {
        return shadowRoot.querySelector(selector);
      },
    },

    // redirect to mainDocument
    activeElement: {
      get: () => {
        // TODO: we see event.target during dispatchEvent to be set to null, it's likely due to this patch... investigate why!
        return mainDocument.activeElement;
      },
    },

    // redirect to mainDocument
    head: {
      get: () => {
        // TODO should we enforce that there is a HEAD-like element under reframedContainer?
        return shadowRoot;
      },
    },

    body: {
      get: () => {
        // TODO should we enforce that there is a BODY-like element under reframedContainer?
        return shadowRoot.firstElementChild;
      }
    },

    // TODO: hack
    unreframedBody: {
      get: () => {
        return unpatchedIframeBody;
      }
    },

    stylesheets: {
      get: () => {
        return shadowRoot.styleSheets;
      },
    },

    dispatchEvent: {
      value(event: Event) {
        return shadowRoot.dispatchEvent(event);
      }
    },

    childElementCount: {
      get() {
        return shadowRoot.childElementCount;
      }
    },

    hasChildNodes: {
      value(id: string) {
        return shadowRoot.hasChildNodes();
      },
    },

    children: {
      get() {
        return shadowRoot.children;
      }
    },

    firstElementChild: {
      get() {
        return shadowRoot.firstElementChild;
      }
    },

    firstChild: {
      get() {
        return shadowRoot.firstChild;
      }
    },

    lastElementChild: {
      get() {
        return shadowRoot.lastElementChild;
      }
    },

    lastChild: {
      get() {
        return shadowRoot.lastChild;
      }
    },

    rootElement: {
      get() {
        return shadowRoot.firstChild;
      }
    },
  } satisfies Record<keyof Document, any>);

  const domCreateProperties: (keyof Pick<Document,
    "createAttributeNS" |
    "createCDATASection" |
     "createComment" |
    "createDocumentFragment" |
     "createElement" |
    "createElementNS" |
    "createEvent" |
    "createExpression" |
    "createNSResolver" |
    "createNodeIterator" |
    "createProcessingInstruction"|
    "createRange"|
    "createTextNode"|
    "createTreeWalker"
    >)[] = [
    "createAttributeNS",
    "createCDATASection",
     "createComment",
    "createDocumentFragment",
     "createElement",
    "createElementNS",
    "createEvent",
    "createExpression",
    "createNSResolver",
    "createNodeIterator",
    "createProcessingInstruction",
    "createRange",
    "createTextNode",
    "createTreeWalker",
  ];
  for (const createProperty of domCreateProperties) {
    Object.defineProperty(iframeDocumentPrototype, createProperty, {
      value: function reframedCreateFn() {
        // @ts-expect-error WTD?!?
        return (mainDocument[createProperty]).apply(mainDocument, arguments);
      }
    });
  }

  // methods to query for elements that can be retargeted into the reframedContainer
  const domQueryProperties: (keyof Pick<Document,
    "querySelector" |
    "querySelectorAll" |
     "getElementsByClassName" |
    "getElementsByTagName" |
     "getElementsByTagNameNS"
    >)[] = [
    "querySelector",
    "querySelectorAll",
    "getElementsByClassName",
    "getElementsByTagName",
    "getElementsByTagNameNS",
  ];
  for (const queryProperty of domQueryProperties) {
    Object.defineProperty(iframeDocumentPrototype, queryProperty, {
      value: function reframedCreateFn() {
        // @ts-expect-error WTD?!?
        return (shadowRoot[queryProperty]).apply(shadowRoot, arguments);
      }
    });
  }

  // methods to manage document listeners
  const domListenerProperties: (keyof Pick<Document,
    "addEventListener" |
    "removeEventListener"
    >)[] = ["addEventListener", "removeEventListener"];
  for (const listenerProperty of domListenerProperties) {
    const originalDocumentFn = document[listenerProperty];
    Object.defineProperty(iframeDocumentPrototype, listenerProperty, {
      value: function reframedListenerFn(eventName: string) {
        if (eventName === "DOMContentLoaded") {
          // @ts-expect-error WTD?!?
          return originalDocumentFn.apply(document, arguments);
        }

        return shadowRoot[listenerProperty].apply(
          shadowRoot,
          // @ts-expect-error WTD?!?
          arguments
        );
      }
    });



// window.location is read-only and non-configurable, so we can't patch it
//
// additionally in a browsing context with one or more iframes, the history
// all frames contribute to the joint history: https://www.w3.org/TR/2011/WD-html5-20110525/history.html#joint-session-history
// this means that we need to be careful not to add duplicate entries to the
// history stack via pushState within the iframe as that would double the
// number of history entries that back/forward button would have to work through
//
// therefore we do the following:
// - intercept all history.pushState history.replaceState calls and replay
//   them in the main window
// - update the window.location within the iframe via history.replaceState
// - intercept window.addEventListener('popstate', ...) registration and forward it onto the main window
const originalHistoryFns = new Map();
["back", "forward", "go", "pushState", "replaceState"].forEach((prop) => {
  originalHistoryFns.set(prop, iframeWindow.history.__proto__[prop]);
  Object.defineProperty(iframeWindow.history.__proto__, prop, {
    get: () => {
      return function reframedHistoryGetter() {
        console.log(
          prop,
          "history length",
          mainWindow.history.length,
          iframeWindow.history.length
        );

        switch (prop) {
          case "pushState": {
            Reflect.apply(
              originalHistoryFns.get("replaceState"),
              iframeWindow.history,
              arguments
            );
            mainWindow.history.pushState(...arguments);
            break;
          }
          case "replaceState": {
            Reflect.apply(
              originalHistoryFns.get("replaceState"),
              iframeWindow.history,
              arguments
            );
            mainWindow.history.replaceState(...arguments);
            break;
          }
          default: {
            Reflect.apply(
              mainWindow.history[prop],
              mainWindow.history,
              arguments
            );
          }
        }
      };
    },
  });
});

// keep window.location and history.state in sync with the ones in the parent window
mainWindow.addEventListener("popstate", () => {
  Reflect.apply(originalHistoryFns.get("replaceState"), iframeWindow.history.__proto__, [
    mainWindow.history.state,
    null,
    mainWindow.location.href,
  ]);
});

["length", "scrollRestoration", "state"].forEach((prop) => {
  Object.defineProperty(iframeWindow.history.__proto__, prop, {
    get: () => {
      return Reflect.get(mainWindow.history, prop);
    },
  });
});
  }
}

/**
 * Utility to convert a string to a ReadableStream.
 */
const stringToStream = (str: string): ReadableStream => {
  return new ReadableStream({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(str));
      controller.close();
    },
  });
};

/**
 * A generic assertion function.
 *
 * Typescript doesn't seem to consider `console.assert` to be an assertion function so we have this wrapper
 * https://www.typescriptlang.org/docs/handbook/release-notes/typescript-3-7.html#assertion-functions
 */
function assert(value: boolean, message: string): asserts value {
  console.assert(value, message);
}
