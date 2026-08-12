import { test, expect } from '@playwright/test';
const { beforeEach, step } = test;
import { failOnBrowserErrors, getFragmentContext } from '../playwright.utils';

beforeEach(failOnBrowserErrors);

const HOST_ISOLATION = process.env.HOST_ISOLATION || 'legacy';

declare global {
	interface Window {
		__syncMarker?: number;
		__externalMarker?: string;
		__innerHTMLMarker?: boolean;
		__templateMarker?: number;
		__parsedTemplateMarker?: boolean;
		__nestedMarker?: boolean;
		__multiFirst?: number;
		__multiSecond?: number;
		__bypassMarker?: string;
	}
}

/**
 * Verifies that scripts inserted into a fragment's DOM at runtime — through every supported vector —
 * execute in the fragment's JS context and never in the main JS context, in both legacy and strict
 * host-isolation modes (see rfcs/host-page-isolation.md).
 */
test('runtime script insertion in fragments', async ({ page }) => {
	await page.goto('/runtime-script-insertion/');

	await step('ensure the test harness app loaded', async () => {
		await expect(page.locator('h1')).toHaveText('WF Playground: runtime-script-insertion');
	});

	const fragment = page.locator('web-fragment');

	await step('ensure the fragment renders', async () => {
		await expect(fragment.locator('h2')).toHaveText('runtime-script-insertion fragment');
	});

	await step('all insertion vectors execute (or stay inert) as expected within the fragment', async () => {
		await expect(fragment.locator('#sync-inline-checkbox')).toBeChecked();
		await expect(fragment.locator('#src-script-checkbox')).toBeChecked();
		await expect(fragment.locator('#innerhtml-checkbox')).toBeChecked();
		await expect(fragment.locator('#template-clone-checkbox')).toBeChecked();
		await expect(fragment.locator('#nested-subtree-checkbox')).toBeChecked();
		await expect(fragment.locator('#multi-append-checkbox')).toBeChecked();
	});

	await step('all scripts executed in the fragment JS context', async () => {
		const fragmentContext = await getFragmentContext(fragment);
		const fragmentMarkers = await fragmentContext.evaluate(() => ({
			sync: window.__syncMarker,
			external: window.__externalMarker,
			template: window.__templateMarker,
			nested: window.__nestedMarker,
			multiSecond: window.__multiSecond,
		}));
		expect(fragmentMarkers).toEqual({
			sync: 42,
			external: 'loaded',
			template: 1,
			nested: true,
			multiSecond: 2,
		});
	});

	await step('no fragment script leaked into the main JS context', async () => {
		const mainContextLeaks = await page.evaluate(() =>
			[
				'__syncMarker',
				'__externalMarker',
				'__innerHTMLMarker',
				'__templateMarker',
				'__parsedTemplateMarker',
				'__nestedMarker',
				'__multiFirst',
				'__multiSecond',
			].filter((marker) => marker in window),
		);
		expect(mainContextLeaks).toEqual([]);
	});
});

/**
 * Strict mode's activation safety net: an inert script inserted through code paths the fragment
 * boundary doesn't intercept synchronously (e.g. captured native DOM functions) is activated by the
 * boundary observer — in the fragment's JS context, never in the main one.
 */
test('strict mode activates inert scripts inserted via unstamped native methods', async ({ page }) => {
	// eslint-disable-next-line playwright/no-skipped-test
	test.skip(HOST_ISOLATION !== 'strict', 'the boundary observer only exists in strict host isolation');

	await page.goto('/runtime-script-insertion/');
	const fragment = page.locator('web-fragment');
	await expect(fragment.locator('h2')).toHaveText('runtime-script-insertion fragment');

	await page.evaluate(() => {
		const outerShadowRoot = document.querySelector('web-fragment')?.shadowRoot;
		const host = outerShadowRoot?.querySelector('web-fragment-host');
		const wfDocument = (host?.shadowRoot ?? outerShadowRoot)?.querySelector('wf-document');
		if (!wfDocument) throw new Error('could not find wf-document');

		const inertScript = document.createElement('script');
		inertScript.setAttribute('type', 'inert');
		inertScript.textContent = 'window.__bypassMarker = "activated";';
		// bypass any stamped methods by using the pristine prototype function directly
		Node.prototype.appendChild.call(wfDocument, inertScript);
	});

	const fragmentContext = await getFragmentContext(fragment);
	await expect.poll(() => fragmentContext.evaluate(() => window.__bypassMarker)).toBe('activated');

	expect(await page.evaluate(() => '__bypassMarker' in window)).toBe(false);
});
