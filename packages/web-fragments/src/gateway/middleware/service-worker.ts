/**
 * The middleware provides support for Service Worker-based fragment rendering using fetch event handling.
 * Service Workers run in a separate context and intercept network requests, making them ideal for
 * implementing gateway logic at the edge.
 */

import { FragmentGateway, FragmentMiddlewareOptions } from '../fragment-gateway';
import { getWebMiddleware } from './web';

type ServiceWorkerMiddlewareOptions = FragmentMiddlewareOptions & {
	initializeHtmlRewriter?: () => Promise<void>;
};

let htmlRewriterInitPromise: Promise<void> | null = null;

async function ensureHtmlRewriter(initializer?: () => Promise<void>): Promise<void> {
	if (typeof (globalThis as { HTMLRewriter?: unknown }).HTMLRewriter !== 'undefined') {
		return;
	}

	if (!initializer) {
		throw new Error(
			'HTMLRewriter is not available in this Service Worker context. Provide initializeHtmlRewriter when calling getServiceWorkerMiddleware.',
		);
	}

	if (!htmlRewriterInitPromise) {
		htmlRewriterInitPromise = initializer().catch((error) => {
			htmlRewriterInitPromise = null;
			throw error;
		});
	}

	await htmlRewriterInitPromise;

	if (typeof (globalThis as { HTMLRewriter?: unknown }).HTMLRewriter === 'undefined') {
		throw new Error('HTMLRewriter initialization completed, but the constructor is still undefined.');
	}
}

/**
 * Minimal type definition for Service Worker FetchEvent to avoid requiring WebWorker lib.
 * When using this middleware, ensure your service worker file includes /// <reference lib="WebWorker" />
 */
export interface ServiceWorkerFetchEvent {
	request: Request;
	respondWith(response: Promise<Response> | Response): void;
}

/**
 * Creates middleware for handling service worker-based fragment rendering.
 * @param { FragmentGateway } gateway - The fragment gateway instance.
 * @param { FragmentMiddlewareOptions } [options={}] - Optional middleware settings.
 * @returns { Function } - A middleware function for processing service worker fetch events.
 */
export function getServiceWorkerMiddleware(
	gateway: FragmentGateway,
	options: FragmentMiddlewareOptions = {},
): (request: Request, next: () => Promise<Response>) => Promise<Response> {
	const swOptions = options as ServiceWorkerMiddlewareOptions;

	// Get the web middleware variant that is hardened for Service Worker environments
	const webMiddleware = getWebMiddleware(gateway, { ...options, isServiceWorker: true });

	// Wrap to create a service worker-safe request
	// otherwise this needs to be recreated in user-land every time
	return async (request: Request, next: () => Promise<Response>): Promise<Response> => {
		await ensureHtmlRewriter(swOptions.initializeHtmlRewriter);

		// Clone the request with properties that the Request() constructor accepts in workers; see
		// https://developer.mozilla.org/docs/Web/API/Request/Request for the mode/redirect coercions
		// (e.g. mode 'navigate' throws, redirect 'manual' downgrades to 'follow').

		// Determine the proper mode: use 'cors' for navigate mode
		const safeMode = request.mode === 'navigate' ? 'cors' : request.mode;

		// TODO: SW-WORKAROUND - Browser strips sec-fetch-dest when creating Request with mode:'cors' in SW context.
		// Preserve original sec-fetch-dest in custom header x-wf-fetch-dest so web.ts can detect iframe requests.
		// This enables the reframed stub document pattern to work in Service Workers.
		const secFetchDest = request.headers.get('sec-fetch-dest');
		const requestDestination = (request as Request & { destination?: string }).destination;
		const headers = new Headers(request.headers);
		if (secFetchDest) {
			headers.set('x-wf-fetch-dest', secFetchDest);
		} else if (requestDestination) {
			headers.set('x-wf-fetch-dest', requestDestination);
		}

		// TODO: SW-WORKAROUND - Use same-origin credentials to avoid CORS issues with wildcard headers
		// Original navigation requests have credentials:'include' but fragment fetches are cross-origin
		const safeRequest = new Request(request.url, {
			method: request.method,
			headers,
			body: request.body,
			referrer: request.referrer,
			referrerPolicy: request.referrerPolicy,
			mode: safeMode,
			credentials: 'same-origin',
			cache: request.cache,
			redirect: request.redirect === 'manual' ? 'follow' : request.redirect,
			integrity: request.integrity,
		});
		return webMiddleware(safeRequest, next);
	};
}
