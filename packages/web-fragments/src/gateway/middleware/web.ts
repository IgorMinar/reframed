/**
 * The middleware provides support for Web request-response handling using fetch-like behavior, and for Node.js native http request and responses object, including using Connect framework, via the imported adaptor.
 */

import { FragmentGateway, FragmentMiddlewareOptions, FragmentConfig, FragmentGatewayConfig } from '../fragment-gateway';
import { HTMLRewriter } from 'htmlrewriter';

const isNativeHtmlRewriter = HTMLRewriter.toString().endsWith('{ [native code] }');

/**
 * Creates middleware for handling web-based fragment rendering.
 * @param {FragmentGateway} gateway - The fragment gateway instance.
 * @param {FragmentMiddlewareOptions} [options={}] - Optional middleware settings.
 * @returns {Function} - A middleware function for processing web requests.
 */
export function getWebMiddleware(
	gateway: FragmentGateway,
	options: FragmentMiddlewareOptions = {},
): (request: Request, next: () => Promise<Response>) => Promise<Response> {
	const { additionalHeaders = {}, mode = 'development' }: FragmentMiddlewareOptions = options;

	return async (request: Request, next: () => Promise<Response>): Promise<Response> => {
		const { pathname, search = '' } = new URL(request.url);
		const requestFragmentId = request.headers.get('x-web-fragment-id') ?? undefined;
		const matchedFragment = gateway.matchRequestToFragment(`${pathname}${search}`, requestFragmentId);

		/**
		 * Handle app shell (legacy app) requests
		 * --------------------------------------
		 *
		 * If this request doesn't match any fragment routes, then send it to the legacy app by calling the next() middleware function.
		 */
		if (!matchedFragment) {
			// Fetch the app shell response from the origin and clone it so we can modify it
			const originalNextResponse = await next();
			const appShellResponse = new Response(originalNextResponse.body, originalNextResponse);
			appShellResponse.headers.append('x-web-fragment-id', '<app-shell>');
			return appShellResponse;
		}

		const requestSecFetchDest = request.headers.get('sec-fetch-dest');
		// Service workers lose the Fetch-Metadata header when cloning navigate requests; fallback to Request.destination.
		const requestDestination = (request as Request & { destination?: string }).destination;

		/**
		 * Handle IFrame request from reframed
		 * ----------------------------
		 *
		 * If this request was initiated by an iframe (via reframed), return a stub document.
		 *
		 * Reframed has to set the iframe's `src` to the fragment URL to have its `document.location` reflect the correct value (and also avoid same-origin policy restrictions).
		 *
		 * However, we don't want the iframe's document to actually contain the fragment's content; we're only using it as an isolated execution context. Returning a stub document here is our workaround to that problem.
		 */
		// TODO: SW-WORKAROUND - Service Workers strip sec-fetch-dest when cloning navigate requests with mode:'cors'.
		// We first fall back to Request.destination (available in modern Chrome/Firefox/Safari); legacy SW wrapper still
		// supplies x-wf-fetch-dest as a final safety net. Drop this once browsers retain Fetch-Metadata for SW clones.
		const xwfFetchDest = request.headers.get('x-wf-fetch-dest');
		const effectiveFetchDest = requestSecFetchDest || requestDestination || xwfFetchDest;

		if (effectiveFetchDest === 'iframe') {
			// The title below is used be reframed to detect gateway misconfiguration. See reframed.ts
			return new Response('<!doctype html><title>Web Fragments: reframed</title>', {
				// !!! Important: the header name must be Camel-Cased for overriding via the iframesHeaders to work !!!
				headers: {
					'Content-Type': 'text/html;charset=UTF-8',
					Vary: 'sec-fetch-dest',
					'X-Web-Fragment-Id': matchedFragment.fragmentId,
					// cache the response for 1 hour and then revalidate in the background just in case we need to make some changes to the served content in the future
					'Cache-Control': 'max-age=3600, public, stale-while-revalidate=31536000',
					...matchedFragment.iframeHeaders,
				},
			});
		}

		// Forward the request to the fragment endpoint
		const fragmentResponsePromise =
			// but only if we are about to pierce, or are proxying the request to the fragment endpoint
			matchedFragment.piercing || effectiveFetchDest !== 'document'
				? fetchFragment(request, matchedFragment, additionalHeaders, mode)
				: undefined; //Promise.reject('Unexpected fragment request');

		/**
		 * Handle SSR request from a hard navigation
		 * ----------------------------
		 *
		 * For hard navigations we need to combine the appShell response with fragment response.
		 */
		if (effectiveFetchDest === 'document') {
			// Fetch the app shell response from the origin and clone it so we can modify it
			const originalNextResponse = await next();
			const appShellResponse = new Response(originalNextResponse.body, originalNextResponse);

			const isHTMLResponse = appShellResponse.headers.get('content-type')?.startsWith('text/html');

			// If the app shell response is an error or not HTML or we are not piercing, pass it through to the client
			if (!appShellResponse.ok || !isHTMLResponse || !matchedFragment.piercing) {
				appShellResponse.headers.append('vary', 'sec-fetch-dest');
				appShellResponse.headers.append('x-web-fragment-id', '<app-shell>');
				return appShellResponse;
			}

			// Combine the html responses from the fragment and app shell
			return fragmentResponsePromise!
				.then(function rejectErrorResponses(response: Response) {
					if (response.ok) return response;
					throw response;
				})
				.catch(handleFetchErrors)
				.then(stripDoctype)
				.then(prefixHtmlHeadBody)
				.then(neutralizeScriptAndLinkTags)
				.then((fragmentResponse) => {
					return embedFragmentIntoShellApp({
						appShellResponse,
						fragmentResponse,
						fragmentConfig: matchedFragment,
						gateway: gateway,
					});
				})
				.then((combinedResponse) => {
					// Append Vary header to prevent BFCache issues
					combinedResponse.headers.append('vary', 'sec-fetch-dest');
					// Append X-Web-Fragment-Id for debugging purposes
					combinedResponse.headers.append('x-web-fragment-id', matchedFragment.fragmentId);
					return attachForwardedHeaders(Promise.resolve(combinedResponse), matchedFragment)(combinedResponse);
				})
				.catch((error) => {
					console.error('[Web] ERROR in piercing flow:', error);
					return renderErrorResponse(error);
				});
		}

		const fragmentResponse = await fragmentResponsePromise!;

		/**
		 * Handle SSR request from a soft navigation
		 * ----------------------------
		 *
		 * Simply pass through the fragment response but append the vary header to prevent BFCache issues.
		 */
		if (requestSecFetchDest === 'empty') {
			const fragmentSoftNavResponse = new Response(fragmentResponse.body, fragmentResponse);
			fragmentSoftNavResponse.headers.append('vary', 'sec-fetch-dest');
			fragmentSoftNavResponse.headers.append('x-web-fragment-id', matchedFragment.fragmentId);

			return prefixHtmlHeadBody(fragmentSoftNavResponse);
		}

		/**
		 * Handle Asset or Data request
		 * ----------------------------
		 *
		 * Simply pass through the fragment response.
		 */
		const fragmentAssetResponse = new Response(fragmentResponse.body, fragmentResponse);
		fragmentAssetResponse.headers.append('x-web-fragment-id', matchedFragment.fragmentId);

		if (mode === 'development' && ['gzip', 'br'].includes(fragmentAssetResponse.headers.get('content-encoding')!)) {
			// Due to a bug in miniflare which doesn't pass through compressed responses correctly,
			// we need to set the content-encoding to identity in development mode which somehow makes
			// miniflare pass this responses via chunked encoding which prevents the content-length from being
			// mismatched and the response being cut off abruptly.
			//  https://github.com/cloudflare/workers-sdk/issues/6577
			//  https://github.com/cloudflare/workers-sdk/issues/8004
			//  https://github.com/opennextjs/opennextjs-aws/pull/718/files#diff-1102925bd511dd8915dbfd18689c1a3351c17ceef436f0027a3caa0548edbc74R56-R61
			//  https://github.com/wakujs/waku/issues/1237
			fragmentAssetResponse.headers.set('Content-Encoding', 'identity');
		}

		return fragmentAssetResponse;

		async function handleFetchErrors(fragmentResponseOrError: Response | Error) {
			const { endpoint, onSsrFetchError = defaultOnSsrFetchError } = matchedFragment!;

			let onSsrFetchErrorResponse;
			try {
				onSsrFetchErrorResponse = await onSsrFetchError(request, fragmentResponseOrError);
			} catch (error) {
				console.error('onSsrFetchError failed! Using defaultOnSsrFetchError handler instead', { cause: error });
				onSsrFetchErrorResponse = await defaultOnSsrFetchError(request, fragmentResponseOrError);
			}
			const { response, overrideResponse } = onSsrFetchErrorResponse;

			if (overrideResponse) throw response;
			return response;
		}

		async function defaultOnSsrFetchError(fragmentRequest: Request, fragmentResponseOrError: Response | Error) {
			const fetchError = fragmentResponseOrError instanceof Response;
			return {
				response: new Response(
					mode === 'development'
						? `<p>Failed to fetch fragment!<br>
										Endpoint: ${matchedFragment!.endpoint}<br>
										Request: ${fragmentRequest.method} ${fragmentRequest.url}<br>
										${
											fetchError
												? `Response: HTTP ${fragmentResponseOrError.status} ${fragmentResponseOrError.statusText}${
														fragmentResponseOrError.status >= 300 &&
														fragmentResponseOrError.status < 400 &&
														fragmentResponseOrError.headers.has('location')
															? `<br> Location: ${fragmentResponseOrError.headers.get('location')}`
															: ''
													}<br>${await fragmentResponseOrError.text()}`
												: `Internal exception: ${fragmentResponseOrError}<br>
										 		Stack: <br>${fragmentResponseOrError.stack}`
										}</p>`
						: '<p>There was a problem fulfilling your request.</p>',
					{ status: 500, headers: [['content-type', 'text/html']] },
				),
				overrideResponse: false,
			};
		}
	};

	/**
	 * Fetches a fragment from a specified endpoint.
	 *
	 * @param {Request} originalRequest - The original request object.
	 * @param {FragmentConfig} fragmentConfig - Configuration containing the fragment endpoint.
	 * @param {Record<string, string>} additionalHeaders - Additional headers to include in the request.
	 * @param {string} mode - The environment mode (e.g., 'development').
	 * @returns {Promise<Response>} - The fetched fragment response.
	 */
	async function fetchFragment(
		originalRequest: Request,
		fragmentConfig: FragmentConfig,
		additionalHeaders: HeadersInit = {},
		mode: string = 'development',
	): Promise<Response> {
		const { endpoint } = fragmentConfig;
		const requestUrl = new URL(originalRequest.url);

		// if the endpoint is a fetcher function we'll use it
		// otherwise we'll use the endpoint as a URL and fetch it
		const [fragmentReqUrl, fragmentFetch] =
			typeof endpoint === 'function'
				? [requestUrl, endpoint]
				: [new URL(`${requestUrl.pathname}${requestUrl.search}`, endpoint), globalThis.fetch];

		const originalRequestDestination = (originalRequest as Request & { destination?: string }).destination;
		const fetchingToPierce =
			(originalRequest.headers.get('sec-fetch-dest') || originalRequestDestination) === 'document';

		const fragmentReq = new Request(fragmentReqUrl, originalRequest);

		// if we are about to pierce a fragment, drop headers that apply only to the overall document request
		if (fetchingToPierce) {
			fragmentReq.headers.delete('if-none-match');
			fragmentReq.headers.delete('if-modified-since');
		}

		// TODO: add timeout handling
		//const abortController = new AbortController();
		//const timeoutTimer = abortIfSlow && setTimeout(() => abortController.abort(), 1_500);

		// forward the original protocol and host info to the fragment endpoint
		fragmentReq.headers.set(
			'x-forwarded-proto',
			originalRequest.headers.get('x-forwarded-proto') || requestUrl.protocol.slice(0, -1),
		);
		fragmentReq.headers.set('x-forwarded-host', originalRequest.headers.get('x-forwarded-host') || requestUrl.host);

		// attach additionalHeaders to fragment request
		Object.entries(additionalHeaders).forEach(([name, value]) => {
			fragmentReq.headers.set(name, value);
		});

		// Note: we don't want to forward the sec-fetch-dest since we usually need
		//       custom logic so that we avoid returning full htmls if the header is
		//       not set to 'document'
		fragmentReq.headers.set('sec-fetch-dest', 'empty');

		// Add a header for signaling embedded mode
		fragmentReq.headers.set('x-fragment-mode', 'embedded');

		if (mode === 'development' && fragmentReq.headers.get('accept-encoding')?.includes('zstd')) {
			// zstd is not currently supported during local development (with miniflare)
			// https://github.com/cloudflare/workers-sdk/issues/9522
			// so we set the accept-encoding to gzip and brotli
			fragmentReq.headers.set('Accept-Encoding', 'gzip, br');
		}

		// make the request and ensure we don't follow redirects
		// redirects should be sent all the way to the client, which can then decide to follow them or not
		// this ensures that window.location is updated in the reframed iframe if the fragment returns a redirect
		// TODO: SW-WORKAROUND - In Service Workers, redirect:'manual' with mode:'cors' is not allowed
		// Use 'follow' in SW context (detected via isServiceWorker option)
		const redirectMode = options.isServiceWorker ? 'follow' : 'manual';
		return fragmentFetch(fragmentReq, { redirect: redirectMode });

		// TODO: add timeout handling
		// return fetch(fragmentReq, { signal: abortController.signal }).finally(
		// 	() => timeoutTimer && clearTimeout(timeoutTimer),
		// );
	}

	/**
	 * Embeds a fetched fragment into the host HTML document.
	 * @param {Response} hostResponse - The response object of the host HTML.
	 * @param {FragmentConfig} fragmentConfig - Configuration object for the fragment.
	 * @returns {Function} - A function that processes and integrates the fragment response.
	 */
	async function embedFragmentIntoShellApp({
		appShellResponse,
		fragmentResponse,
		fragmentConfig,
		gateway,
	}: {
		appShellResponse: Response;
		fragmentResponse: Response;
		fragmentConfig: FragmentConfig;
		gateway: FragmentGatewayConfig;
	}) {
		const { fragmentId, piercingClassNames = [] } = fragmentConfig;

		// Native HTMLRewriter now supports appending/merging of streams directly, so we don't need to block the rewriting
		// until we have the full fragment content. This improves performance.
		// See: https://github.com/web-fragments/web-fragments/pull/104
		//
		// Since the wasm HTMLRewriter doesn't have this feature yet, so we need to split the implementation into two for now.
		if (isNativeHtmlRewriter) {
			let fragmentPierced = false;
			const fragmentStream = asReadableStream`
			<web-fragment-host class="${piercingClassNames.join(' ')}" fragment-id="${fragmentId}" data-piercing="true">
				<template shadowrootmode="open"><style>wf-document, wf-html, wf-body { display: block; }wf-head { display: none;}</style><wf-document>${fragmentResponse.body ?? ''}</wf-document></template>
			</web-fragment-host>`;

			return new HTMLRewriter()
				.on('head', {
					element(element) {
						element.prepend(
							// prettier-ignore
							'<style>web-fragment, web-fragment-host { display: block; }</style>',
							{ html: true },
						);
						element.append(gateway.piercingStyles ?? '', { html: true });
					},
				})
				.on('web-fragment', {
					element(element) {
						if (element.getAttribute('fragment-id') !== fragmentId) return;
						element.append('<template shadowrootmode="open">', { html: true });

						(element.append as any as (content: ReadableStream, options: { html: boolean }) => void)(fragmentStream, {
							html: true,
						});
						element.append('</template>', { html: true });
						fragmentPierced = true;
					},
				})
				.on('body', {
					async element(element) {
						element.onEndTag((endTag) => {
							if (fragmentPierced) return;

							(endTag.before as any as (content: ReadableStream, options: { html: boolean }) => void)(fragmentStream, {
								html: true,
							});
						});
					},
				})
				.transform(appShellResponse);
		} else {
			const fragmentContent = await fragmentResponse.text();
			let fragmentPierced = false;

			return new HTMLRewriter()
				.on('head', {
					element(element) {
						element.prepend(
							// Inject WF stylesheet
							// Since fragments will most likely contain other block elements, WF related elements should be blocks themselves by default
							// prettier-ignore
							'<style>web-fragment, web-fragment-host { display: block; }</style>',
							{ html: true },
						);
						element.append(gateway.piercingStyles ?? '', { html: true });
					},
				})
				.on('web-fragment', {
					element(element) {
						if (element.getAttribute('fragment-id') !== fragmentId) return;

						element.append(
							`<template shadowrootmode="open"><web-fragment-host class="${piercingClassNames.join(' ')}" fragment-id="${fragmentId}" data-piercing="true"><template shadowrootmode="open"><style>wf-document, wf-html, wf-body { display: block; }wf-head { display: none;}</style><wf-document>${fragmentContent}</wf-document></template></web-fragment-host></template>`,
							{ html: true },
						);
						fragmentPierced = true;
					},
				})
				.on('body', {
					element(element) {
						element.onEndTag((endTag) => {
							if (fragmentPierced) return;

							endTag.before(
								`<web-fragment-host class="${piercingClassNames.join(' ')}" fragment-id="${fragmentId}" data-piercing="true"><template shadowrootmode="open"><style>wf-document, wf-html, wf-body { display: block; }wf-head { display: none;}</style><wf-document>${fragmentContent}</wf-document></template></web-fragment-host>`,
								{ html: true },
							);
						});
					},
				})
				.transform(appShellResponse);
		}
	}
}

/**
 * Strips <!doctype> from the response body.
 *
 * Nested doctype tags might cause some browsers to complain or choke (e.g. Firefox in some cases).
 *
 * Browsers don't materialize this tag in the DOM anyway so it should be ok to strip them (if it's nested within other elements).
 *
 * HTMLRewriter doesn't support modifying the doctype tag, so we strip it manually here.
 *
 * @param fragmentResponse
 * @returns
 */
export function stripDoctype(fragmentResponse: Response): Response {
	let firstChunk = true;

	const rewrittenBody = fragmentResponse.body
		?.pipeThrough(new TextDecoderStream())
		.pipeThrough(
			new TransformStream({
				transform(chunk, controller) {
					// it's highly unlikely that the first chunk won't contain the full doctype
					// so we don't need to bother buffering the chunks and instead can just check the first one
					if (firstChunk) {
						firstChunk = false;
						chunk = chunk.replace(/<!doctype[^>]*>/i, '');
					}

					controller.enqueue(chunk);
				},
			}),
		)
		.pipeThrough(new TextEncoderStream());
	return new Response(rewrittenBody, fragmentResponse);
}

/**
 * Rewrites html so that any <html>, <head>, and <body> tags are replaced with <wf-html>, <wf-head>, and <wf-body> tags.
 *
 * DOM doesn't allow duplicates of these three elements in the document, and the main document already contains them.
 *
 * We need to replace these tags, to prevent the DOM from silently dropping them when the content is added to the main document.
 *
 * @param {Response} fragmentResponse response to rewrite
 * @returns {Response} rewritten response
 */
export function prefixHtmlHeadBody(fragmentResponse: Response): Response {
	return new HTMLRewriter()
		.on('html', {
			element(element: any) {
				element.tagName = 'wf-html';
			},
		})
		.on('head', {
			element(element: any) {
				element.tagName = 'wf-head';
			},
		})
		.on('body', {
			element(element: any) {
				element.tagName = 'wf-body';
			},
		})
		.transform(fragmentResponse);
}

/**
 * Rewrites html so that any script tags and script preload/prefetch links become inert and don't execute.
 *
 * @param {Response} fragmentResponse response to rewrite
 * @returns {Response} rewritten response
 */
export function neutralizeScriptAndLinkTags(fragmentResponse: Response): Response {
	return new HTMLRewriter()
		.on('link', {
			element(element: any) {
				const linkType = element.getAttribute('rel');
				if (linkType && (linkType === 'preload' || linkType === 'prefetch' || linkType === 'modulepreload')) {
					element.setAttribute('rel', 'inert-' + linkType);
				}
			},
		})
		.on('script', {
			element(element: any) {
				const scriptType = element.getAttribute('type');
				if (scriptType) {
					element.setAttribute('data-script-type', scriptType);
				}
				element.setAttribute('type', 'inert');
			},
		})
		.transform(new Response(fragmentResponse.body, fragmentResponse));
}

/**
 * Attaches forwarded headers to a response.
 * @param {Promise<Response>} fragmentResponse - The response object of the fragment.
 * @param {FragmentConfig} fragmentConfig - Configuration object for the fragment.
 * @returns {Function} - A function that processes and integrates the fragment response.
 */
function attachForwardedHeaders(fragmentResponse: Promise<Response>, fragmentConfig: FragmentConfig) {
	return async (response: Response) => {
		const fragmentHeaders = (await fragmentResponse).headers;
		const { forwardFragmentHeaders = [] } = fragmentConfig;

		for (const header of forwardFragmentHeaders) {
			response.headers.append(header, fragmentHeaders.get(header) || '');
		}

		return response;
	};
}

/**
 * Renders an error response with a status of 500.
 *
 * @param {Response | Error} err - The error to handle.
 * @returns {Response} - The error response.
 */
function renderErrorResponse(err: Response | Error): Response {
	if (err instanceof Response) return err;
	console.error('WF Gateway Internal Server Error\n', err);
	return new Response('WF Gateway Internal Server Error', {
		status: 500,
		headers: { 'Content-Type': 'text/html' },
	});
}

/**
 * A tagged template that produces a ReadableStream of its content.
 * It supports interpolating other ReadableStreams, which allows you
 * to easily wrap streams with text or combine multiple streams, etc.
 *
 * @example
 * const wrappedBody = asReadableStream`<template>${response.body}</template>`;
 * const combinedStream = asReadableStream`${stream1}${stream2}`;
 */
export function asReadableStream(strings: TemplateStringsArray, ...values: Array<string | number | ReadableStream>) {
	return new ReadableStream({
		async start(controller) {
			try {
				for (let i = 0; i < strings.length; i++) {
					if (strings[i]) {
						controller.enqueue(new TextEncoder().encode(strings[i]));
					}

					if (i < values.length) {
						const value = values[i];

						if (value instanceof ReadableStream) {
							const reader = value.getReader();

							while (true) {
								const { done, value: chunk } = await reader.read();
								if (done) break;
								controller.enqueue(chunk);
							}
						} else {
							const stringValue = String(value);
							if (stringValue) {
								controller.enqueue(new TextEncoder().encode(stringValue));
							}
						}
					}
				}
			} catch (error) {
				controller.error(error);
			}
			controller.close();
		},
	});
}
