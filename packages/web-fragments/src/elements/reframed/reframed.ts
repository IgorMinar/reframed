import WritableDOMStream from 'writable-dom';
import { getWebFragmentsConfig } from '../config';
import { initializeIFrameContext } from './iframe-patches';
import { initializeMainContext } from './main-patches';
import { executeScriptsInPiercedFragment } from './script-execution';
import { WebFragmentError } from './utils/web-fragment-error';

type ReframedOptions = {
	pierced: boolean;
	shadowRoot: ShadowRoot;
	wfDocumentElement: HTMLElement;
	bound: boolean;
	headers?: HeadersInit;
	name: string;
};

/**
 * Creates a new reframed context for a fragment that virtualizes the DOM and browser APIs using a monkey-patched hidden iframe.
 *
 * The fragment will be initialized by fetching the initial html from `reframedSrc` unless `options.pierced` is set to true in which case `option.shadowRoot` will be used to initialize the fragment.
 *
 * The window.location in the reframed context is always initialized to `reframedSrc`.
 *
 * @param reframedSrc source url of the reframed context
 * @param options options to configure the reframed context
 * @returns
 */
export function reframed(
	reframedSrc: string,
	options: ReframedOptions,
): {
	iframe: HTMLIFrameElement;
	ready: Promise<void>;
} {
	if (getWebFragmentsConfig().hostIsolation === 'legacy') {
		// legacy mode: patch the main context's prototypes and History API
		// (strict mode confines all interception to the fragment boundary, see initializeIFrameContext)
		initializeMainContext(options.bound);
	}

	const wfDocumentElement = options.wfDocumentElement;

	import.meta.env.DEV && console.debug('web-fragment init', { source: reframedSrc, pierced: options.pierced });

	/**
	 * Create the iframe that we'll use to load scripts into, but hide it from the viewport.
	 * It's important that we set the src of the iframe before we insert the element into the body
	 * in order to prevent loading the iframe twice when the src is changed later on.
	 */
	const iframe = document.createElement('iframe');
	iframe.hidden = true;
	iframe.src = reframedSrc;
	iframe.name = `wf:${options.name}`;
	// We can append the iframe to the main document only once the iframe[src] is set.
	// This is especially the case in Firefox where an extra history record is created for iframes
	// appended for at least one turn of the event loop (a task), which then have their src is set.
	document.body.appendChild(iframe);

	const reframeMetadata: ReframedMetadata = {
		iframeDocumentReadyState: 'loading',
		iframe,
	};

	const reframedShadowRoot = Object.assign(options.shadowRoot, {
		[reframedMetadataSymbol]: reframeMetadata,
	});

	/**
	 * Initialize a promise and resolver for monkeyPatchIFrameDocument.
	 * We need to know when monkeyPatchIFrameDocument resolves so we can return from reframe()
	 * since this happens after the iframe loads.
	 */
	let { promise: iframeReady, resolve: resolveIframeReady } = Promise.withResolvers<HTMLIFrameElement>();

	let alreadyLoaded = false;
	let pendingHardNavigationHref: string | null = null;

	iframe.addEventListener('load', () => {
		if (alreadyLoaded) {
			// iframe reload detected!
			// this means that the fragment app attempted to reload or hard navigate to a different url

			if (options.bound) {
				// Workaround for a weird Safari (v26) bug
				// - In Safari, if we hard navigate away from the host page, for example from /foo to /bar
				// - and then hit the back button
				// - the /foo host app will cause reframed iframes to be recreated (correctly) with iframe[src=/foo] however the browser makes network request for /bar and feeds the iframe with /bar
				// - this is very bizarre and there is no public mention of this issue however Safari is known to have bugs related to bfcache, so this might be related
				// - the workaround is to:
				//   - intercept the load event to know that the iframe is being reloaded
				//   - save the url we are trying to hard navigate to in pendingHardNavigationHref
				//   - restore the location of the iframe to host's location.href
				//   - catch the second load event, and update the host's location.href to pendingHardNavigationHref
				//
				// Related test location-and-history.spec.ts#hard nav and reload behavior in a bound fragment
				if (pendingHardNavigationHref) {
					location.href = pendingHardNavigationHref;
				} else {
					pendingHardNavigationHref = iframe!.contentWindow!.location.href;
					iframe.contentWindow!.location.href = location.href;
				}
			} else {
				// TODO: what to do here?
				// should we recreate the fragment with the new src?
				// the current fragment is broken because the JS code was unloaded, so we can't resurrect it any more
				// for now we just blow away the content
				console.warn('unbound fragment reload detected, clearing fragment content!');
				reframedShadowRoot.innerHTML = '';
			}
			return;
		}
		alreadyLoaded = true;

		// see web.ts, section "Handle IFrame request from reframed" for more details

		if (
			!(
				iframe.contentDocument?.title === 'Web Fragments: reframed' ||
				// TODO: remove in version 0.9 or later (but before 1.0)
				iframe.contentDocument?.title === ''
			)
		) {
			// TODO: make this a warning and only later an error
			throw new WebFragmentError(
				`Reframed IFrame init error!\n` +
					`IFrame loaded unexpected content for ${iframe.src}!\n` +
					`Expected document title to be "Web Fragments: reframed" but was "${iframe.contentDocument?.title}"\n` +
					`Ensure that the Web Fragment gateway contains a fragment registration with "routePatterns" matching path: ${new URL(iframe.src).pathname}` +
					(!iframe.contentDocument
						? '\nAdditionally, ensure that the iframe response is not delivered with the "X-Frame-Options" response header set to "deny".'
						: ''),
			);
		}

		initializeIFrameContext(iframe, reframedShadowRoot, wfDocumentElement, options.bound);
		resolveIframeReady(iframe);
	});

	let reframingDone: Promise<void>;

	if (options.pierced) {
		reframingDone = reframeFromTarget(reframedShadowRoot, iframeReady);
	} else {
		reframingDone = reframeWithFetch(reframedSrc, options, iframeReady);
	}

	const ready = reframingDone.then(async () => {
		reframedShadowRoot[reframedMetadataSymbol].iframeDocumentReadyState = 'interactive';
		wfDocumentElement.dispatchEvent(
			new Event('readystatechange', {
				bubbles: false,
				cancelable: false,
			}),
		);
		wfDocumentElement.dispatchEvent(
			new Event('DOMContentLoaded', {
				bubbles: true,
				cancelable: false,
			}),
		);

		// In order to fire window.load event we need to wait for all the images to load.
		// By now all styles and scripts have loaded, so images are the main kind of resources to wait for.
		// Other kind of resources should be rare, and we can add them as we discover them causing the event to fire too early.
		await allImagesLoaded(wfDocumentElement);

		// Wrap the event into a task so we don't execute too early in case there are no images.
		setTimeout(() => {
			reframedShadowRoot[reframedMetadataSymbol].iframeDocumentReadyState = 'complete';
			wfDocumentElement.dispatchEvent(
				new Event('readystatechange', {
					bubbles: false,
					cancelable: false,
				}),
			);
			iframe.contentWindow?.dispatchEvent(
				new Event('load', {
					bubbles: false,
					cancelable: false,
				}),
			);

			import.meta.env.DEV &&
				console.debug('web-fragment loaded', {
					source: reframedSrc,
					shadowRoot: reframedShadowRoot,
				});
		});
	});

	return {
		iframe,
		ready,
	};
}

async function reframeWithFetch(
	reframedSrc: string,
	options: ReframedOptions,
	iframeReady: Promise<HTMLIFrameElement>,
): Promise<void> {
	const reframedHtmlResponse = await fetch(reframedSrc, {
		headers: { accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8', ...options.headers },
	});

	const reframedHtmlStream =
		reframedHtmlResponse.status === 200
			? reframedHtmlResponse.body!
			: stringToStream(
					`error fetching ${reframedSrc} (HTTP Status = ${
						reframedHtmlResponse.status
					})<hr>${await reframedHtmlResponse.text()}`,
				);

	const { promise, resolve } = Promise.withResolvers<void>();

	iframeReady.then(() => {
		reframedHtmlStream
			.pipeThrough(new TextDecoderStream())
			.pipeTo(new WritableDOMStream(options.wfDocumentElement))
			.finally(() => {
				resolve();
			});
	});

	return promise;
}

async function reframeFromTarget(source: ShadowRoot, iframeReady: Promise<HTMLIFrameElement>): Promise<void> {
	const { promise, resolve } = Promise.withResolvers<void>();

	iframeReady.then((iframe) => {
		executeScriptsInPiercedFragment(source, iframe);
		resolve();
	});

	return promise;
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

type ReframedMetadata = {
	/**
	 * Indicates what the value the iframe's document readyState should be.
	 *
	 * Note that we can't simply monkey patch this to the main document (since the iframe needs to have its own behavior regarding this state),
	 * so we need to directly manage this state ourselves.
	 */
	iframeDocumentReadyState: DocumentReadyState;
	iframe: HTMLIFrameElement;
};

export const reframedMetadataSymbol = Symbol('reframed:metadata');

export type ReframedShadowRoot = ShadowRoot & {
	[reframedMetadataSymbol]: ReframedMetadata;
};

/**
 * Returns a promise indicated when all images in the shadow root have loaded.
 */
function allImagesLoaded(wfDocumentElement: HTMLElement): Promise<void> {
	const images = wfDocumentElement.querySelectorAll('img');
	if (images.length === 0) {
		return Promise.resolve();
	}

	const imagePromises = [...images].map((image) => {
		return new Promise<void>((resolve) => {
			if (image.complete) {
				// if the image is already loaded, resolve immediately
				resolve();
			} else {
				// otherwise register load and error listeners
				image.addEventListener('load', () => resolve());
				image.addEventListener('error', () => resolve());
			}
		});
	});

	return Promise.all(imagePromises).then(() => {});
}
