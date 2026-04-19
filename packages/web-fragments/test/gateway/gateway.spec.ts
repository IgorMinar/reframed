// @ts-nocheck
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { FragmentGateway } from '../../src/gateway/fragment-gateway';
import { getNodeMiddleware } from '../../src/gateway/middleware/node';
import { getWebMiddleware } from '../../src/gateway/middleware/web';
import { getServiceWorkerMiddleware } from '../../src/gateway/middleware/service-worker';
import connect from 'connect';
import express from 'express';
import http from 'node:http';
import stream from 'node:stream';
import streamWeb from 'node:stream/web';

// comment out some environments if you want to focus on testing just one or a few
const environments = [];
environments.push('web');
environments.push('connect');
environments.push('express');
environments.push('service-worker');

for (const environment of environments) {
	describe(`${environment} middleware`, () => {
		/**
		 * @param request A request to test
		 * @param hostResponse A response that should be served as if it came from the legacy host
		 */
		let testRequest: (request: Request, hostResponse?: Response) => Promise<Response>;
		let customFragmentBarOnSsrFetchError:
			| ((req: Request, responseOrError: Response | Error) => Promise<{ response: Response }>)
			| null = null;

		describe(`app shell requests`, () => {
			it(`should serve requests from the app shell when no fragments matched`, async () => {
				mockShellAppResponse(new Response('<p>hello world</p>'));

				const response = await testRequest(new Request('http://localhost/'));

				expect(response.status).toBe(200);
				expect(await response.text()).toBe('<p>hello world</p>');
				expect(response.headers.get('x-web-fragment-id')).toBe('<app-shell>');

				// make one more request to a different non-fragment path
				mockShellAppResponse(new Response('<p>hello moon</p>'));

				const response2 = await testRequest(new Request('http://localhost/not-a-fragment-path'));

				expect(response2.status).toBe(200);
				expect(await response2.text()).toBe('<p>hello moon</p>');
				expect(response2.headers.get('x-web-fragment-id')).toBe('<app-shell>');
			});

			it('should serve an error response from the app shell as is', async () => {
				mockShellAppResponse(
					new Response('<html><body>app shell no bueno 😢</body></html>', { status: 500, statusText: 'no bueno' }),
				);

				const response = await testRequest(new Request('http://localhost/'));

				expect(response.status).toBe(500);
				expect(response.statusText).toBe('no bueno');
				expect(await response.text()).toBe('<html><body>app shell no bueno 😢</body></html>');

				// make one more request to a different non-fragment path
				mockShellAppResponse(new Response('<html><body>does not exist here! 👻</body></html>', { status: 404 }));

				const response404 = await testRequest(new Request('http://localhost/not-here'));

				expect(response404.status).toBe(404);
				expect(await response404.text()).toBe('<html><body>does not exist here! 👻</body></html>');
			});

			it('should serve a redirect response from the app shell as is', async () => {
				mockShellAppResponse(new Response(null, { status: 302, statusText: 'Found', headers: { location: '/foo' } }));

				const response = await testRequest(new Request('http://localhost/'));

				expect(response.status).toBe(302);
				expect(response.statusText).toBe('Found');
				expect(response.headers.get('location')).toBe('/foo');

				// make one more request to a different non-fragment path
				mockShellAppResponse(new Response(null, { status: 301, statusText: 'Found', headers: { location: '/bar' } }));

				const response404 = await testRequest(new Request('http://localhost/not-here'));

				expect(response404.status).toBe(301);
				expect(response404.statusText).toBe('Found');
				expect(response404.headers.get('location')).toBe('/bar');
			});
		});

		describe(`pierced fragment requests`, () => {
			it(`should match a fragment and return html that combines the CSR-ed app shell and fragment payloads`, async () => {
				mockShellAppResponse(
					new Response('<html><body>legacy host content</body></html>', { headers: { 'content-type': 'text/html' } }),
				);
				mockFragmentFooResponse('/foo', new Response('<p>foo fragment</p>'));

				const response = await testRequest(
					new Request('http://localhost/foo', { headers: { 'sec-fetch-dest': 'document' } }),
				);

				expect(response.status).toBe(200);
				expect(await response.text()).toBe(
					`<html><body>legacy host content<web-fragment-host class="foo" fragment-id="fragmentFoo" data-piercing="true"><template shadowrootmode="open"><style>wf-document, wf-html, wf-body { display: block; }wf-head { display: none;}</style><wf-document><p>foo fragment</p></wf-document></template></web-fragment-host></body></html>`,
				);
				expect(response.headers.get('content-type')).toBe('text/html');
				expect(response.headers.get('vary')).toBe('sec-fetch-dest');
				expect(response.headers.get('x-web-fragment-id')).toBe('fragmentFoo');

				// make one more request to the second fragment path
				mockShellAppResponse(
					new Response(`<html><body>legacy host content</body></html>`, { headers: { 'content-type': 'text/html' } }),
				);
				mockFragmentBarResponse('/bar', new Response('<p>bar fragment</p>'));

				const response2 = await testRequest(
					new Request('http://localhost/bar', { headers: { 'sec-fetch-dest': 'document' } }),
				);

				expect(response2.status).toBe(200);
				expect(await response2.text()).toBe(
					`<html><body>legacy host content<web-fragment-host class="bar" fragment-id="fragmentBar" data-piercing="true"><template shadowrootmode="open"><style>wf-document, wf-html, wf-body { display: block; }wf-head { display: none;}</style><wf-document><p>bar fragment</p></wf-document></template></web-fragment-host></body></html>`,
				);
				expect(response2.headers.get('x-web-fragment-id')).toBe('fragmentBar');

				// make one last request, but this time pull the fragment request from a fetcher function
				mockShellAppResponse(
					new Response(`<html><body>legacy host content</body></html>`, { headers: { 'content-type': 'text/html' } }),
				);
				const response3 = await testRequest(
					new Request('http://localhost/baz', { headers: { 'sec-fetch-dest': 'document' } }),
				);

				expect(response3.status).toBe(200);
				expect(await response3.text()).toBe(
					`<html><body>legacy host content<web-fragment-host class="baz" fragment-id="fragmentBazFetcher" data-piercing="true"><template shadowrootmode="open"><style>wf-document, wf-html, wf-body { display: block; }wf-head { display: none;}</style><wf-document>baz fetcher response to (GET /baz)</wf-document></template></web-fragment-host></body></html>`,
				);
				expect(response3.headers.get('x-web-fragment-id')).toBe('fragmentBazFetcher');
			});

			it(`should match a fragment and return html that combines the SSR-ed app shell and fragment payloads`, async () => {
				mockShellAppResponse(
					new Response(
						'<html><body>legacy host content<web-fragment fragment-id="fragmentFoo"></web-fragment></body></html>',
						{ headers: { 'content-type': 'text/html' } },
					),
				);
				mockFragmentFooResponse('/foo', new Response('<p>foo fragment</p>'));

				const response = await testRequest(
					new Request('http://localhost/foo', { headers: { 'sec-fetch-dest': 'document' } }),
				);

				expect(response.status).toBe(200);
				expect(await response.text()).toBe(
					`<html><body>legacy host content<web-fragment fragment-id="fragmentFoo"><template shadowrootmode="open"><web-fragment-host class="foo" fragment-id="fragmentFoo" data-piercing="true"><template shadowrootmode="open"><style>wf-document, wf-html, wf-body { display: block; }wf-head { display: none;}</style><wf-document><p>foo fragment</p></wf-document></template></web-fragment-host></template></web-fragment></body></html>`,
				);
				expect(response.headers.get('content-type')).toBe('text/html');
				expect(response.headers.get('vary')).toBe('sec-fetch-dest');
				expect(response.headers.get('x-web-fragment-id')).toBe('fragmentFoo');
			});

			it(`should return the original app shell response but with vary header if the fragment's config disabled piercing`, async () => {
				mockShellAppResponse(
					new Response('<html><body>legacy host content</body></html>', { headers: { 'content-type': 'text/html' } }),
				);

				const response = await testRequest(
					new Request('http://localhost/unpierced', { headers: { 'sec-fetch-dest': 'document' } }),
				);

				expect(response.status).toBe(200);
				expect(await response.text()).toBe(`<html><body>legacy host content</body></html>`);
				expect(response.headers.get('content-type')).toBe('text/html');
				expect(response.headers.get('vary')).toBe('sec-fetch-dest');
				expect(response.headers.get('x-web-fragment-id')).toBe('<app-shell>');
			});

			it(`should strip doctype from html`, async () => {
				// browsers don't create DOM nodes for nested doctype and it could cause problems for some browsers

				mockShellAppResponse(
					new Response('<html><body>legacy host content</body></html>', { headers: { 'content-type': 'text/html' } }),
				);
				mockFragmentFooResponse(
					'/foo',
					new Response('<!doctype html><html><head><title>test</title></head><body>hello</body></html>'),
				);

				const response = await testRequest(
					new Request('http://localhost/foo', { headers: { 'sec-fetch-dest': 'document' } }),
				);

				expect(response.status).toBe(200);
				expect(await response.text()).toBe(
					`<html><body>legacy host content<web-fragment-host class="foo" fragment-id="fragmentFoo" data-piercing="true"><template shadowrootmode="open"><style>wf-document, wf-html, wf-body { display: block; }wf-head { display: none;}</style><wf-document><wf-html><wf-head><title>test</title></wf-head><wf-body>hello</wf-body></wf-html></wf-document></template></web-fragment-host></body></html>`,
				);
				expect(response.headers.get('content-type')).toBe('text/html');
				expect(response.headers.get('vary')).toBe('sec-fetch-dest');
			});

			it(`should rewrite <html>, <head>, and <body> tags in fragment's html`, async () => {
				// we want to rewrite the <html>, <head>, and <body> tags in the fragment's html because browser will otherwise strip them out

				mockShellAppResponse(
					new Response('<html><body>legacy host content</body></html>', { headers: { 'content-type': 'text/html' } }),
				);
				mockFragmentFooResponse(
					'/foo',
					new Response(
						'<html lang="en-US"><head data-foo="bar"><meta>some head content</meta></head><body class="foo"><p>foo fragment</p></body></html>',
					),
				);

				const response = await testRequest(
					new Request('http://localhost/foo', { headers: { 'sec-fetch-dest': 'document' } }),
				);

				expect(response.status).toBe(200);
				expect(await response.text()).toBe(
					`<html><body>legacy host content<web-fragment-host class="foo" fragment-id="fragmentFoo" data-piercing="true"><template shadowrootmode="open"><style>wf-document, wf-html, wf-body { display: block; }wf-head { display: none;}</style><wf-document><wf-html lang="en-US"><wf-head data-foo="bar"><meta>some head content</meta></wf-head><wf-body class="foo"><p>foo fragment</p></wf-body></wf-html></wf-document></template></web-fragment-host></body></html>`,
				);
				expect(response.headers.get('content-type')).toBe('text/html');
				expect(response.headers.get('vary')).toBe('sec-fetch-dest');
			});

			it(`should strip if-none-match and if-modified-since headers from the pierced fragment request`, async () => {
				fetchMock.doMockIf((request) => {
					if (request.url.toString() === 'http://foo.test:1234/foo') {
						expect(request.headers.has('if-none-match')).toBe(false);
						expect(request.headers.has('if-modified-since')).toBe(false);
						return true;
					}
					return false;
				}, new Response('<p>foo fragment</p>'));

				mockShellAppResponse(
					new Response('<html><body>legacy host content</body></html>', { headers: { 'content-type': 'text/html' } }),
				);

				const response = await testRequest(
					new Request('http://localhost/foo', {
						headers: {
							// must be 'document' since we are emulating piercing
							'sec-fetch-dest': 'document',
							'if-modified-since': 'Mon, 10 Mar 2025 23:55:13 GMT',
							'if-none-match': 'W/"a2fd-195827be9b2"',
						},
					}),
				);

				expect(response.status).toBe(200);
				expect(await response.text()).toBe(
					`<html><body>legacy host content<web-fragment-host class="foo" fragment-id="fragmentFoo" data-piercing="true"><template shadowrootmode="open"><style>wf-document, wf-html, wf-body { display: block; }wf-head { display: none;}</style><wf-document><p>foo fragment</p></wf-document></template></web-fragment-host></body></html>`,
				);
			});

			it(`should append additional headers to the SSR request for the fragment`, async () => {
				fetchMock.doMockIf((request) => {
					if (request.url.toString() === 'http://foo.test:1234/foo') {
						expect(request.headers.get('accept-language')).toBe('sk-SK');
						expect(request.headers.get('x-color-mode')).toBe('dark');
						return true;
					}
					return false;
				}, new Response('<p>foo fragment</p>'));

				const response = await testRequest(
					new Request('http://localhost/foo', { headers: { 'sec-fetch-dest': 'empty' } }),
				);

				expect(response.status).toBe(200);
				expect(await response.text()).toBe('<p>foo fragment</p>');
			});

			it(`should append x-forwarded-host and x-forwarded-proto headers to the SSR request for the fragment`, async () => {
				fetchMock.doMockIf((request) => {
					if (request.url.toString() === 'http://foo.test:1234/foo') {
						expect(request.headers.get('x-forwarded-host')).toBe(
							`localhost${server ? ':' + server.address()!.port : ''}`,
						);
						expect(request.headers.get('x-forwarded-proto')).toBe('http');
						return true;
					}
					return false;
				}, new Response('<p>foo fragment</p>'));

				const response = await testRequest(
					new Request('http://localhost/foo', { headers: { 'sec-fetch-dest': 'empty' } }),
				);

				expect(response.status).toBe(200);
				expect(await response.text()).toBe('<p>foo fragment</p>');
			});

			it('should preserve all headers from the app shell response in the final combined response', async () => {
				mockShellAppResponse(
					new Response('<html><body>app shell</body></html>', {
						status: 200,
						// create a response with duplicate set-cookie headers
						headers: new Headers([
							['content-type', 'text/html'],
							['x-custom-header', 'goat'],
							['set-cookie', 'c1=val1; httpOnly'],
							['set-cookie', 'c2=val2'],
							['set-cookie', 'c3=val3'],
						]),
					}),
				);
				mockFragmentFooResponse('/foo', new Response('<p>foo fragment</p>'));

				const response = await testRequest(
					new Request('http://localhost/foo', { headers: { 'sec-fetch-dest': 'document' } }),
				);

				expect(response.status).toBe(200);
				expect(await response.text()).toBe(
					`<html><body>app shell<web-fragment-host class="foo" fragment-id="fragmentFoo" data-piercing="true"><template shadowrootmode="open"><style>wf-document, wf-html, wf-body { display: block; }wf-head { display: none;}</style><wf-document><p>foo fragment</p></wf-document></template></web-fragment-host></body></html>`,
				);
				expect(response.headers.get('set-cookie')?.replace(/\s/g, '')).toBe('c1=val1;httpOnly,c2=val2,c3=val3');
			});

			it(`should make all script tags and preload links in pierced fragment's shadow root inert`, async () => {
				mockShellAppResponse(
					new Response('<html><body>legacy host content</body></html>', { headers: { 'content-type': 'text/html' } }),
				);
				mockFragmentFooResponse(
					'/foo',
					new Response(
						'<link rel="preload" href="_fragments/foo/preload.js" as="script">' +
							'<link rel="prefetch" href="_fragments/foo/prefetch.js" as="script">' +
							'<link rel="modulepreload" href="_fragments/foo/modulepreload.js" as="script">' +
							'<script>console.log("regular inline script")</script>' +
							'<script async>console.log("async inline script")</script>' +
							'<script deferred>console.log("deferred inline script")</script>' +
							'<script type="module">console.log("regular inline module script")</script>' +
							'<script src="_fragments/foo/test.js"></script>' +
							'<script type="module" src="_fragments/foo/test.js"></script>',
					),
				);

				const response = await testRequest(
					new Request('http://localhost/foo', { headers: { 'sec-fetch-dest': 'document' } }),
				);

				expect(response.status).toBe(200);
				expect(await response.text()).toBe(
					`<html><body>legacy host content<web-fragment-host class="foo" fragment-id="fragmentFoo" data-piercing="true"><template shadowrootmode="open"><style>wf-document, wf-html, wf-body { display: block; }wf-head { display: none;}</style><wf-document>${
						'<link rel="inert-preload" href="_fragments/foo/preload.js" as="script">' +
						'<link rel="inert-prefetch" href="_fragments/foo/prefetch.js" as="script">' +
						'<link rel="inert-modulepreload" href="_fragments/foo/modulepreload.js" as="script">' +
						'<script type="inert">console.log("regular inline script")</script>' +
						'<script async type="inert">console.log("async inline script")</script>' +
						'<script deferred type="inert">console.log("deferred inline script")</script>' +
						'<script type="inert" data-script-type="module">console.log("regular inline module script")</script>' +
						'<script src="_fragments/foo/test.js" type="inert"></script>' +
						'<script type="inert" src="_fragments/foo/test.js" data-script-type="module"></script>'
					}</wf-document></template></web-fragment-host></body></html>`,
				);
			});

			describe('error handling', () => {
				// TODO: should this be configurable? By default we hard fail, but if we want the fragments to be resilient against app shell failures we should allow the shell to fail and fragment to still pierce.
				it('should serve the app shell server error page without a fragment when server-side app shell error occurs', async () => {
					mockShellAppResponse(
						new Response('<html><body>app shell error 😢</body></html>', {
							status: 500,
							headers: { 'content-type': 'text/html' },
						}),
					);
					mockFragmentFooResponse('/foo', new Response('<p>foo fragment</p>'));

					const response = await testRequest(
						new Request('http://localhost/foo', { headers: { 'sec-fetch-dest': 'document' } }),
					);

					expect(response.status).toBe(500);
					expect(await response.text()).toBe(`<html><body>app shell error 😢</body></html>`);
				});

				it('should serve the app shell with the default fragment SSR fetch error message when fragment endpoint errors', async () => {
					mockShellAppResponse(
						new Response('<html><body>app shell 🙂</body></html>', {
							status: 200,
							headers: { 'content-type': 'text/html' },
						}),
					);
					mockFragmentFooResponse('/foo', new Response('fragment failed to render 🙈', { status: 500 }));

					const response = await testRequest(
						new Request('http://localhost/foo', { headers: { 'sec-fetch-dest': 'document' } }),
					);

					expect(response.status).toBe(200);
					expect(stripMultipleSpaces(await response.text())).toBe(
						stripMultipleSpaces(`<html><body>app shell 🙂<web-fragment-host class="foo" fragment-id="fragmentFoo" data-piercing="true"><template shadowrootmode="open"><style>wf-document, wf-html, wf-body { display: block; }wf-head { display: none;}</style><wf-document><p>Failed to fetch fragment!<br>
								Endpoint: http://foo.test:1234<br>
								Request: GET http://localhost${server ? ':' + server.address()!.port : ''}/foo<br>
								Response: HTTP 500 <br>fragment failed to render 🙈</p></wf-document></template></web-fragment-host></body></html>`),
					);
				});

				it('should serve the app shell with the default fragment SSR fetch error message when fragment endpoint returns a redirect response', async () => {
					/**
					 * We can't follow redirects when piercing because the location.href would get out of sync between the fragment's server-side and client-side.
					 *
					 * For this reason, we need to treat redirects as errors.
					 */

					mockShellAppResponse(
						new Response('<html><body>app shell 🙂</body></html>', {
							status: 200,
							headers: { 'content-type': 'text/html' },
						}),
					);
					mockFragmentFooResponse('/foo', new Response(null, { status: 302, headers: { location: '/foo/bar' } }));

					const response = await testRequest(
						new Request('http://localhost/foo', { headers: { 'sec-fetch-dest': 'document' } }),
					);

					expect(response.status).toBe(200);
					expect(stripMultipleSpaces(await response.text())).toBe(
						stripMultipleSpaces(`<html><body>app shell 🙂<web-fragment-host class="foo" fragment-id="fragmentFoo" data-piercing="true"><template shadowrootmode="open"><style>wf-document, wf-html, wf-body { display: block; }wf-head { display: none;}</style><wf-document><p>Failed to fetch fragment!<br>
								Endpoint: http://foo.test:1234<br>
								Request: GET http://localhost${server ? ':' + server.address()!.port : ''}/foo<br>
								Response: HTTP 302 <br>
								Location: /foo/bar<br></p></wf-document></template></web-fragment-host></body></html>`),
					);
				});

				it('should serve the app shell with a fragment-specific fetch error message when fragment endpoint errors', async () => {
					mockShellAppResponse(
						new Response('<html><body>app shell 🙂</body></html>', {
							status: 200,
							headers: { 'content-type': 'text/html' },
						}),
					);
					mockFragmentBarResponse('/bar', new Response('fragment failed to render 🙈', { status: 500 }));

					customFragmentBarOnSsrFetchError = async (req, responseOrError) => {
						return {
							response: new Response(
								`<p>custom error: Fetching Bar fragment failed!<br>url: ${req.url}<br>error: ${responseOrError instanceof Response ? await responseOrError.text() : responseOrError}</p>`,
								{
									status: 500,
									headers: { 'content-type': 'text/html' },
								},
							),
						};
					};

					const response = await testRequest(
						new Request('http://localhost/bar', { headers: { 'sec-fetch-dest': 'document' } }),
					);

					// the overall response should be 200
					expect(response.status).toBe(200);
					// but the response should contain a custom error message from the fragment gateway
					expect(stripMultipleSpaces(await response.text())).toBe(
						stripMultipleSpaces(
							`<html><body>app shell 🙂<web-fragment-host class="bar" fragment-id="fragmentBar" data-piercing="true"><template shadowrootmode="open"><style>wf-document, wf-html, wf-body { display: block; }wf-head { display: none;}</style><wf-document><p>custom error: Fetching Bar fragment failed!<br>url: http://localhost${server ? ':' + server.address()!.port : ''}/bar<br>error: fragment failed to render 🙈</p></wf-document></template></web-fragment-host></body></html>`,
						),
					);
				});

				it('should support serving the fragment-specific fetch error directly when fragment endpoint errors', async () => {
					mockShellAppResponse(
						new Response('<html><body>app shell 🙂</body></html>', {
							status: 200,
							headers: { 'content-type': 'text/html' },
						}),
					);

					mockFragmentBarResponse('/bar', new Response('session expired', { status: 401 }));

					customFragmentBarOnSsrFetchError = async (req, responseOrError) => {
						if (responseOrError instanceof Response && responseOrError.status === 401) {
							return { response: Response.redirect('http://sso.test/login', 302), overrideResponse: true };
						}
						throw new Error('unexpected request');
					};

					const response = await testRequest(
						new Request('http://localhost/bar', { headers: { 'sec-fetch-dest': 'document' }, redirect: 'manual' }),
					);

					expect(response.status).toBe(302);
					expect(response.headers.get('location')).toBe('http://sso.test/login');
					expect(await response.text()).toBe('');
				});
			});

			describe(`web fragment styles`, () => {
				it(`should inject default WF styles into the pierced response`, async () => {
					mockShellAppResponse(
						new Response(
							'<html><head><style>.appStyle { color: red }</style></head><body>legacy host content</body></html>',
							{
								headers: { 'content-type': 'text/html' },
							},
						),
					);
					mockFragmentFooResponse('/foo', new Response('<p>foo fragment</p>'));

					const response = await testRequest(
						new Request('http://localhost/foo', { headers: { 'sec-fetch-dest': 'document' } }),
					);

					expect(response.status).toBe(200);
					expect(await response.text()).toBe(
						`<html><head><style>web-fragment, web-fragment-host { display: block; }</style><style>.appStyle { color: red }</style></head><body>legacy host content<web-fragment-host class="foo" fragment-id="fragmentFoo" data-piercing="true"><template shadowrootmode="open"><style>wf-document, wf-html, wf-body { display: block; }wf-head { display: none;}</style><wf-document><p>foo fragment</p></wf-document></template></web-fragment-host></body></html>`,
					);
				});
			});
		});

		describe(`fragment iframe requests`, () => {
			it(`should serve a blank html document if a request is made by the iframe[src] element`, async () => {
				mockFragmentFooResponse('/foo', new Response('<p>foo fragment</p>'));

				const response = await testRequest(
					new Request('http://localhost/foo', { headers: { 'sec-fetch-dest': 'iframe' } }),
				);

				expect(response.status).toBe(200);
				expect(await response.text()).toBe(`<!doctype html><title>Web Fragments: reframed</title>`);
				expect(Object.fromEntries(response.headers.entries())).toMatchObject({
					'content-type': 'text/html;charset=UTF-8',
					vary: 'sec-fetch-dest',
					'x-web-fragment-id': 'fragmentFoo',
					'cache-control': 'max-age=3600, public, stale-while-revalidate=31536000',
				});

				// make one more request to the second fragment path
				mockShellAppResponse(
					new Response('<html><body>legacy host content</body></html>', { headers: { 'content-type': 'text/html' } }),
				);
				mockFragmentBarResponse('/bar', new Response('<p>bar fragment</p>'));

				const response2 = await testRequest(
					new Request('http://localhost/bar', { headers: { 'sec-fetch-dest': 'iframe' } }),
				);

				expect(response2.status).toBe(200);
				expect(await response2.text()).toBe(`<!doctype html><title>Web Fragments: reframed</title>`);
				expect(Object.fromEntries(response2.headers.entries())).toMatchObject({
					'content-type': 'text/html;charset=UTF-8',
					vary: 'sec-fetch-dest',
					'x-web-fragment-id': 'fragmentBar',
					'cache-control': 'max-age=3600, public, stale-while-revalidate=31536000',
				});
			});

			it('should support adding additional response headers to the iframe response', async () => {
				mockFragmentFooResponse('/baz', new Response('<p>baz fragment</p>'));

				const response = await testRequest(
					new Request('http://localhost/baz', { headers: { 'sec-fetch-dest': 'iframe' } }),
				);

				expect(response.status).toBe(200);
				expect(await response.text()).toBe(`<!doctype html><title>Web Fragments: reframed</title>`);
				expect(Object.fromEntries(response.headers.entries())).toMatchObject({
					// over-written by the fragment config
					'content-type': 'application/xhtml+xml',
					vary: 'sec-fetch-dest',
					'x-web-fragment-id': 'fragmentBazFetcher',
					'cache-control': 'max-age=3600, public, stale-while-revalidate=31536000',
					// added by the fragment config
					'custom-header-1': 'value-1',
					'custom-header-2': 'value-2',
					'content-security-policy': "'default-src 'self'; img-src 'self' example.com'",
				});
			});
		});

		describe(`fragment soft navigation html requests`, () => {
			it(`should serve a fragment soft navigation request`, async () => {
				mockFragmentFooResponse(
					'/foo/some/path',
					new Response('<p>hello foo world!</p>', {
						headers: { 'content-type': 'text/html', 'cache-control': 'max-age=333', 'custom-header': 'my value' },
					}),
				);

				const softNavResponse = await testRequest(
					new Request('http://localhost/foo/some/path', { headers: { 'sec-fetch-dest': 'empty' } }),
				);

				expect(softNavResponse.status).toBe(200);
				expect(await softNavResponse.text()).toBe(`<p>hello foo world!</p>`);
				expect(softNavResponse.headers.get('content-type')).toBe('text/html');
				expect(softNavResponse.headers.get('vary')).toBe('sec-fetch-dest');
				expect(softNavResponse.headers.get('x-web-fragment-id')).toBe('fragmentFoo');
				// pass through all custom headers
				expect(softNavResponse.headers.get('cache-control')).toBe('max-age=333');
				expect(softNavResponse.headers.get('custom-header')).toBe('my value');

				// let's make one more request to the same path but this time with sec-fetch-dest=document to simulate hard navigation
				mockFragmentFooResponse(
					'/foo/some/path',
					new Response('<p>hello foo world!</p>', { headers: { 'content-type': 'text/html' } }),
				);
				mockShellAppResponse(
					new Response('<html><body>legacy host content</body></html>', { headers: { 'content-type': 'text/html' } }),
				);

				const hardNavResponse = await testRequest(
					new Request('http://localhost/foo/some/path', { headers: { 'sec-fetch-dest': 'document' } }),
				);

				expect(hardNavResponse.status).toBe(200);
				expect(await hardNavResponse.text()).toBe(
					`<html><body>legacy host content<web-fragment-host class="foo" fragment-id="fragmentFoo" data-piercing="true"><template shadowrootmode="open"><style>wf-document, wf-html, wf-body { display: block; }wf-head { display: none;}</style><wf-document><p>hello foo world!</p></wf-document></template></web-fragment-host></body></html>`,
				);
				expect(hardNavResponse.headers.get('content-type')).toBe('text/html');
				expect(hardNavResponse.headers.get('vary')).toBe('sec-fetch-dest');
				expect(hardNavResponse.headers.get('x-web-fragment-id')).toBe('fragmentFoo');
			});

			it(`should serve a redirect response as is for a fragment soft navigation request`, async () => {
				/**
				 * The client should receive a 302 without it being obscured by automatic follow on the server side.
				 *
				 * TODO: client should gracefully handle these redirects https://github.com/web-fragments/web-fragments/issues/245
				 */

				mockFragmentFooResponse(
					'/foo/some/path',
					new Response(null, {
						status: 302,
						headers: { location: '/foo/some/other/path' },
					}),
				);

				const softNavResponse = await testRequest(
					new Request('http://localhost/foo/some/path', { headers: { 'sec-fetch-dest': 'empty' } }),
				);

				expect(softNavResponse.status).toBe(302);
				expect(await softNavResponse.text()).toBe('');
				expect(softNavResponse.headers.get('location')).toBe('/foo/some/other/path');
				expect(softNavResponse.headers.get('content-type')).toBeNull();
				expect(softNavResponse.headers.get('vary')).toBe('sec-fetch-dest');
				expect(softNavResponse.headers.get('x-web-fragment-id')).toBe('fragmentFoo');
			});

			it(`should disambiguate and serve a fragment soft navigation request`, async () => {
				// vitest-fetch-mock does not support mocking out multiple backends,
				// so this is a very clumsy workaround.
				fetchMock.doMockIf(
					() => true,
					(request) => {
						switch (request.url.toString()) {
							case 'http://dupe-a.test:1234/dupe/':
								return new Response('<p>Dupe A!</p>', { headers: { 'content-type': 'text/html' } });
							case 'http://dupe-b.test:1234/dupe/':
								return new Response('<p>Dupe B!</p>', { headers: { 'content-type': 'text/html' } });
							default:
								throw new Error(`Unexpected request to ${request.url}`);
						}
					},
				);

				const softNavResponse = await testRequest(
					new Request('http://localhost/dupe/', {
						headers: { 'sec-fetch-dest': 'empty' },
					}),
				);

				// if ambiguous default to the first registered fragment
				expect(await softNavResponse.text()).toBe(`<p>Dupe A!</p>`);
				expect(softNavResponse.headers.get('x-web-fragment-id')).toBe('dupeFragmentA');

				// if requested return dupeB
				const softNavResponseB = await testRequest(
					new Request('http://localhost/dupe/', {
						headers: { 'sec-fetch-dest': 'empty', 'x-web-fragment-id': 'dupeFragmentB' },
					}),
				);

				expect(await softNavResponseB.text()).toBe(`<p>Dupe B!</p>`);
				expect(softNavResponseB.headers.get('x-web-fragment-id')).toBe('dupeFragmentB');

				// if requested return dupeA
				const softNavResponseA = await testRequest(
					new Request('http://localhost/dupe/', {
						headers: { 'sec-fetch-dest': 'empty', 'x-web-fragment-id': 'dupeFragmentA' },
					}),
				);

				expect(await softNavResponseA.text()).toBe(`<p>Dupe A!</p>`);
				expect(softNavResponseA.headers.get('x-web-fragment-id')).toBe('dupeFragmentA');
			});

			it(`should rewrite any <html>, <head>, or <body> tags in the served a fragment soft navigation response`, async () => {
				mockFragmentFooResponse(
					'/foo/some/path',
					new Response(
						'<html lang="en-US"><head data-foo="bar"><meta>some head content</meta></head><body class="foo"><p>hello foo world!</p></body></html>',
						{ headers: { 'content-type': 'text/html' } },
					),
				);

				const softNavResponse = await testRequest(
					new Request('http://localhost/foo/some/path', { headers: { 'sec-fetch-dest': 'empty' } }),
				);

				expect(softNavResponse.status).toBe(200);
				expect(await softNavResponse.text()).toBe(
					'<wf-html lang="en-US"><wf-head data-foo="bar"><meta>some head content</meta></wf-head><wf-body class="foo"><p>hello foo world!</p></wf-body></wf-html>',
				);
				expect(softNavResponse.headers.get('content-type')).toBe('text/html');
				expect(softNavResponse.headers.get('vary')).toBe('sec-fetch-dest');

				// let's make one more request to the same path but this time with sec-fetch-dest=document to simulate hard navigation
				mockFragmentFooResponse(
					'/foo/some/path',
					new Response('<p>hello foo world!</p>', { headers: { 'content-type': 'text/html' } }),
				);
				mockShellAppResponse(
					new Response('<html><body>legacy host content</body></html>', { headers: { 'content-type': 'text/html' } }),
				);

				const hardNavResponse = await testRequest(
					new Request('http://localhost/foo/some/path', { headers: { 'sec-fetch-dest': 'document' } }),
				);

				expect(hardNavResponse.status).toBe(200);
				expect(await hardNavResponse.text()).toBe(
					`<html><body>legacy host content<web-fragment-host class="foo" fragment-id="fragmentFoo" data-piercing="true"><template shadowrootmode="open"><style>wf-document, wf-html, wf-body { display: block; }wf-head { display: none;}</style><wf-document><p>hello foo world!</p></wf-document></template></web-fragment-host></body></html>`,
				);
				expect(hardNavResponse.headers.get('content-type')).toBe('text/html');
				expect(hardNavResponse.headers.get('vary')).toBe('sec-fetch-dest');
			});

			it(`should append x-forwarded-host and x-forwarded-proto headers to the SSR request`, async () => {
				fetchMock.doMockIf(
					(request) => {
						if (request.url.toString() === 'http://foo.test:1234/foo/some/path') {
							expect(request.headers.get('x-forwarded-host')).toBe(
								`localhost${server ? ':' + server.address()!.port : ''}`,
							);
							expect(request.headers.get('x-forwarded-proto')).toBe('http');
							return true;
						}
						return false;
					},
					new Response('<p>hello foo world!</p>', { headers: { 'content-type': 'text/html' } }),
				);

				const softNavResponse = await testRequest(
					new Request('http://localhost/foo/some/path', { headers: { 'sec-fetch-dest': 'empty' } }),
				);

				expect(softNavResponse.status).toBe(200);
			});

			it(`should not make script tags in the response inert - reframed makes them inert on the client-side`, async () => {
				mockFragmentFooResponse(
					'/foo',
					new Response(
						'<script>console.log("regular inline script")</script>' +
							'<script async>console.log("async inline script")</script>' +
							'<script deferred>console.log("deferred inline script")</script>' +
							'<script type="module">console.log("regular inline module script")</script>' +
							'<script src="_fragments/foo/test.js"></script>' +
							'<script type="module" src="_fragments/foo/test.js"></script>',
					),
				);

				const response = await testRequest(
					new Request('http://localhost/foo', { headers: { 'sec-fetch-dest': 'empty' } }),
				);

				expect(response.status).toBe(200);
				expect(await response.text()).toBe(
					'<script>console.log("regular inline script")</script>' +
						'<script async>console.log("async inline script")</script>' +
						'<script deferred>console.log("deferred inline script")</script>' +
						'<script type="module">console.log("regular inline module script")</script>' +
						'<script src="_fragments/foo/test.js"></script>' +
						'<script type="module" src="_fragments/foo/test.js"></script>',
				);
			});
		});

		describe(`fragment asset requests`, () => {
			it(`should serve a fragment asset`, async () => {
				// fetch an image from the fooFragment
				mockFragmentFooResponse(
					'/_fragment/foo/image.jpg',
					new Response('lol cat img', {
						headers: { 'content-type': 'image/jpeg', 'cache-control': 'max-age=333', 'custom-header': 'my value' },
					}),
				);

				const imgResponse = await testRequest(new Request('http://localhost/_fragment/foo/image.jpg'));

				expect(imgResponse.status).toBe(200);
				expect(await imgResponse.text()).toBe(`lol cat img`);
				expect(imgResponse.headers.get('content-type')).toBe('image/jpeg');
				// pass through all custom headers
				expect(imgResponse.headers.get('cache-control')).toBe('max-age=333');

				expect(imgResponse.headers.get('custom-header')).toBe('my value');

				// fetch a js file from the fooFragment
				mockFragmentFooResponse(
					'/_fragment/foo/jquery.js',
					new Response('globalThis.$ = () => {};', { headers: { 'content-type': 'text/javascript' } }),
				);

				const jsResponse = await testRequest(
					new Request('http://localhost/_fragment/foo/jquery.js', {
						// let's also set the sec-fetch-dest as the browser would
						headers: { 'sec-fetch-dest': 'script' },
					}),
				);
				expect(jsResponse.status).toBe(200);
				expect(await jsResponse.text()).toBe(`globalThis.$ = () => {};`);
				expect(jsResponse.headers.get('content-type')).toBe('text/javascript');
				expect(jsResponse.headers.get('x-web-fragment-id')).toBe('fragmentFoo');

				// fetch a barFragment path
				mockFragmentBarResponse(
					'/_fragment/bar/image.jpg',
					new Response('bar cat img', { headers: { 'content-type': 'image/jpeg' } }),
				);

				const barImgResponse = await testRequest(
					new Request('http://localhost/_fragment/bar/image.jpg', {
						// let's also set the sec-fetch-dest as the browser would
						headers: { 'sec-fetch-dest': 'image' },
					}),
				);

				expect(barImgResponse.status).toBe(200);
				expect(await barImgResponse.text()).toBe(`bar cat img`);
				expect(barImgResponse.headers.get('content-type')).toBe('image/jpeg');
				expect(barImgResponse.headers.get('x-web-fragment-id')).toBe('fragmentBar');
			});

			it(`should serve unmodified redirect responses`, async () => {
				// fetch an image from the fooFragment
				mockFragmentFooResponse(
					'/_fragment/foo/image.jpg',
					new Response(null, {
						status: 302,
						headers: {
							Location: '/_fragment/foo/image2.jpg',
						},
					}),
				);

				const imgResponse = await testRequest(new Request('http://localhost/_fragment/foo/image.jpg'));

				expect(imgResponse.status).toBe(302);
				expect(imgResponse.headers.get('location')).toBe('/_fragment/foo/image2.jpg');
				// node.js always returns a body equal to an empty string rather than null, is this a bug in the adapter?
				expect(imgResponse.body === null || (await imgResponse.text()) === '').toBe(true);
			});

			it(`should handle 304 responses`, async () => {
				// fetch an image from the fooFragment
				mockFragmentFooResponse('/_fragment/foo/image.jpg', new Response(null, { status: 304 }));

				const imgResponse = await testRequest(
					new Request('http://localhost/_fragment/foo/image.jpg', {
						headers: {
							'if-modified-since': 'Mon, 10 Mar 2025 23:55:13 GMT',
							'if-none-match': 'W/"a2fd-195827be9b2"',
						},
					}),
				);

				expect(imgResponse.status).toBe(304);
				expect(imgResponse.body).toBeNull();
			});

			it(`should append x-forwarded-host and x-forwarded-proto headers to the asset request`, async () => {
				fetchMock.doMockIf(
					(request) => {
						if (request.url.toString() === 'http://foo.test:1234/_fragment/foo/image.jpg') {
							expect(request.headers.get('x-forwarded-host')).toBe(
								`localhost${server ? ':' + server.address()!.port : ''}`,
							);
							expect(request.headers.get('x-forwarded-proto')).toBe('http');
							return true;
						}
						return false;
					},
					new Response('lol cat img', { headers: { 'content-type': 'image/jpeg' } }),
				);

				const imgResponse = await testRequest(new Request('http://localhost/_fragment/foo/image.jpg'));

				expect(imgResponse.status).toBe(200);
			});
		});

		let server: http.Server;

		beforeEach(async () => {
			const fragmentGateway = new FragmentGateway();

			fragmentGateway.registerFragment({
				fragmentId: 'fragmentFoo',
				piercingClassNames: ['foo'],
				routePatterns: ['/foo/:_*', '/_fragment/foo/:_*'],
				endpoint: 'http://foo.test:1234',
				upstream: 'http://foo.test:1234',
			});

			fragmentGateway.registerFragment({
				fragmentId: 'fragmentBar',
				piercingClassNames: ['bar'],
				routePatterns: ['/bar/:_*', '/_fragment/bar/:_*'],
				endpoint: 'http://bar.test:4321',
				upstream: 'http://bar.test:4321',
				onSsrFetchError: async (...args) => {
					if (!customFragmentBarOnSsrFetchError) {
						return {
							response: new Response(
								`customFragmentBarOnSsrFetchError not defined! Error url: ${args[0].url}\n${args[1] instanceof Response ? await args[1].text() : args[1]}`,
								{ status: 500 },
							),
						};
					}
					return customFragmentBarOnSsrFetchError(...args);
				},
			});

			fragmentGateway.registerFragment({
				fragmentId: 'fragmentBazFetcher',
				piercingClassNames: ['baz'],
				routePatterns: ['/baz/:_*', '/_fragment/baz/:_*'],
				endpoint: async function bazFetcher(request: Request) {
					return new Response(`baz fetcher response to (${request.method} ${new URL(request.url).pathname})`, {
						status: 200,
					});
				} as typeof fetch,
				iframeHeaders: {
					'Content-Security-Policy': "'default-src 'self'; img-src 'self' example.com'",
					'content-type': 'application/xhtml+xml',
					'custom-header-1': 'value-1',
					'custom-header-2': 'value-2',
				},
			});

			fragmentGateway.registerFragment({
				fragmentId: 'unpiercedFragment',
				piercing: false,
				piercingClassNames: [],
				routePatterns: ['/unpierced/:_*', '/_fragment/unpierced/:_*'],
				endpoint: 'http://unpierced.test:1234',
				upstream: 'http://unpierced.test:1234',
			});

			fragmentGateway.registerFragment({
				fragmentId: 'dupeFragmentA',
				routePatterns: ['/dupe/'],
				endpoint: 'http://dupe-a.test:1234',
			});

			fragmentGateway.registerFragment({
				fragmentId: 'dupeFragmentB',
				routePatterns: ['/dupe/'],
				endpoint: 'http://dupe-b.test:1234',
			});

			switch (environment) {
				case 'web': {
					const webMiddleware = getWebMiddleware(fragmentGateway, {
						additionalHeaders: {
							'accept-language': 'sk-SK',
							'x-color-mode': 'dark',
						},
					});

					// The web case is simple and doesn't even require an HTTP server.
					// We simply pass around Requests and Responses.
					testRequest = function webTestRequest(request: Request): Promise<Response> {
						return webMiddleware(request, function nextFn() {
							const appShellResponse = mockShellAppResponse.getResponse();
							if (!appShellResponse) {
								throw new Error('No app shell response provided, use mockShellAppResponse to set it');
							}
							return Promise.resolve(appShellResponse);
						});
					};

					break;
				}
				case 'service-worker': {
					const serviceWorkerMiddleware = getServiceWorkerMiddleware(fragmentGateway, {
						additionalHeaders: {
							'accept-language': 'sk-SK',
							'x-color-mode': 'dark',
						},
					});

					testRequest = function serviceWorkerTestRequest(request: Request): Promise<Response> {
						let swRequest = request;

						if (request.headers.get('sec-fetch-dest') === 'document') {
							swRequest = request.clone();
							Object.defineProperties(swRequest, {
								mode: { value: 'navigate', configurable: true },
								redirect: { value: 'manual', configurable: true },
							});
						}

						return serviceWorkerMiddleware(swRequest, function nextFn() {
							const appShellResponse = mockShellAppResponse.getResponse();
							if (!appShellResponse) {
								throw new Error('No app shell response provided, use mockShellAppResponse to set it');
							}
							return Promise.resolve(appShellResponse);
						});
					};

					break;
				}
				case 'connect':
				case 'express': {
					// We use an actual connect server here with an ephemeral port
					const app = environment === 'connect' ? connect() : express();

					// fragment gateway middleware
					app.use(
						getNodeMiddleware(fragmentGateway, {
							additionalHeaders: {
								'accept-language': 'sk-SK',
								'x-color-mode': 'dark',
							},
						}),
					);

					// fallback middleware to serve the app shell
					app.use(async (req, resp, next) => {
						let appShellResponse = mockShellAppResponse.getResponse();

						if (!appShellResponse) {
							throw new Error('No app shell response provided, use mockShellAppResponse to set it');
						}

						appShellResponse.headers.forEach((value, name) => {
							resp.appendHeader(name, value);
						});
						// resp.statusCode = appShellResponse.status;
						// resp.statusMessage = appShellResponse.statusText;
						// resp.flushHeaders();
						resp.writeHead(appShellResponse.status, appShellResponse.statusText);

						if (appShellResponse.body) {
							stream.Readable.fromWeb(appShellResponse.body as streamWeb.ReadableStream<any>).pipe(resp);
						} else {
							resp.end();
						}
					});

					// Start server
					server = http.createServer(app);

					let serverStarted = new Promise((resolve) => {
						server.listen(() => {
							console.debug(`Server running at http://localhost:${server.address()!.port}`);
							resolve(void 0);
						});
					});

					await serverStarted;

					testRequest = async function nodeTestRequest(request: Request): Promise<Response> {
						const newUrl = new URL(new URL(request.url).pathname, `http://localhost:${server.address()!.port}`);

						const newRequest = new Request(newUrl, {
							method: request.method,
							headers: request.headers,
							body: request.body,
							mode: request.mode,
							credentials: request.credentials,
							cache: request.cache,
							redirect: request.redirect,
							referrer: request.referrer,
							integrity: request.integrity,
						});

						// TODO: why not working?
						// fetchMock.dontMockOnce();
						// fetch(newRequest);
						return fetch.unpatchedFetch(newRequest, { redirect: 'manual' });
					};

					break;
				}
			}
		});

		afterEach(() => {
			if (server) {
				server.close();
			}
			fetchMock.resetMocks();
			vi.resetModules();
			mockShellAppResponse.response = null;
			customFragmentBarOnSsrFetchError = null;
		});
	});
}

function mockFragmentFooResponse(pathname: string, response: Response) {
	fetchMock.doMockIf('http://foo.test:1234' + pathname, response);
}

function mockFragmentBarResponse(pathname: string, response: Response) {
	fetchMock.doMockIf('http://bar.test:4321' + pathname, response);
}

async function mockShellAppResponse(response: Response) {
	mockShellAppResponse.response = response;
}

mockShellAppResponse.getResponse = function (): Response | null {
	const r = mockShellAppResponse.response;
	mockShellAppResponse.response = null;
	return r;
};

function stripMultipleSpaces(str: string) {
	return str.replace(/\s+/g, ' ');
}
