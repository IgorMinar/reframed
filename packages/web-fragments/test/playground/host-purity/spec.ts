import { test, expect } from '@playwright/test';
const { beforeEach, step } = test;
import { failOnBrowserErrors } from '../playwright.utils';

beforeEach(failOnBrowserErrors);

const HOST_ISOLATION = process.env.HOST_ISOLATION || 'legacy';

declare global {
	interface Window {
		__hostPurityStack?: string;
	}
}

interface HostState {
	appendChildNative: boolean;
	insertBeforeNative: boolean;
	replaceChildNative: boolean;
	appendNative: boolean;
	prependNative: boolean;
	replaceChildrenNative: boolean;
	replaceWithNative: boolean;
	insertAdjacentElementNative: boolean;
	getRootNodeNative: boolean;
	ownerDocumentGetterNative: boolean;
	historyHasOwnPushState: boolean;
	historyPushStateNative: boolean;
	hostCanaryRootIsDocument: boolean;
	hostCanaryOwnerDocumentIsDocument: boolean;
}

/**
 * Loads the host-purity playground app, waits for the fragment to be fully up, and captures the
 * state of every main-context prototype and global that the library could touch.
 */
async function loadAppAndCaptureHostState(page: import('@playwright/test').Page): Promise<HostState> {
	await page.goto('/host-purity/');

	await step('ensure the test harness app loaded', async () => {
		await expect(page.locator('h1')).toHaveText('WF Playground: host-purity');
	});

	await step('ensure the host-purity fragment renders and its runtime script executed', async () => {
		const fragment = page.locator('web-fragment');
		await expect(fragment.locator('h2')).toHaveText('host-purity fragment');
		await expect(fragment.locator('#fragment-script-ran-checkbox')).toBeChecked();
	});

	return page.evaluate(() => {
		const isNative = (fn: unknown) =>
			typeof fn === 'function' && Function.prototype.toString.call(fn).includes('[native code]');

		const ownerDocumentGetter = Object.getOwnPropertyDescriptor(Node.prototype, 'ownerDocument')?.get;
		const hostCanary = document.querySelector('#host-canary')!;

		return {
			appendChildNative: isNative(Node.prototype.appendChild),
			insertBeforeNative: isNative(Node.prototype.insertBefore),
			replaceChildNative: isNative(Node.prototype.replaceChild),
			appendNative: isNative(Element.prototype.append),
			prependNative: isNative(Element.prototype.prepend),
			replaceChildrenNative: isNative(Element.prototype.replaceChildren),
			replaceWithNative: isNative(Element.prototype.replaceWith),
			insertAdjacentElementNative: isNative(Element.prototype.insertAdjacentElement),
			getRootNodeNative: isNative(Node.prototype.getRootNode),
			ownerDocumentGetterNative: isNative(ownerDocumentGetter),
			historyHasOwnPushState: Object.getOwnPropertyNames(window.history).includes('pushState'),
			historyPushStateNative: isNative(window.history.pushState),
			// behavioral probes on a host element outside any fragment
			hostCanaryRootIsDocument: hostCanary.getRootNode() === document,
			hostCanaryOwnerDocumentIsDocument: hostCanary.ownerDocument === document,
		};
	});
}

/**
 * The host-purity contract of strict host-isolation mode (see rfcs/host-page-isolation.md):
 * after fragments are initialized and running, every main-context prototype and global that the
 * library could touch must be in its pristine, native state.
 */
test('strict mode leaves all main-context prototypes and globals pristine', async ({ page }) => {
	// eslint-disable-next-line playwright/no-skipped-test
	test.skip(HOST_ISOLATION !== 'strict', 'the host-purity contract only applies to strict host isolation');

	const hostState = await loadAppAndCaptureHostState(page);

	expect(hostState).toEqual({
		appendChildNative: true,
		insertBeforeNative: true,
		replaceChildNative: true,
		appendNative: true,
		prependNative: true,
		replaceChildrenNative: true,
		replaceWithNative: true,
		insertAdjacentElementNative: true,
		getRootNodeNative: true,
		ownerDocumentGetterNative: true,
		historyHasOwnPushState: false,
		historyPushStateNative: true,
		hostCanaryRootIsDocument: true,
		hostCanaryOwnerDocumentIsDocument: true,
	});

	await step('host-inserted scripts run natively with no library wrapper frames', async () => {
		const wrapperFramesDetected = await page.evaluate(() => {
			const probe = document.createElement('script');
			probe.textContent = 'window.__hostPurityStack = new Error().stack;';
			document.body.appendChild(probe);
			const stack = window.__hostPurityStack ?? '';
			delete window.__hostPurityStack;
			return /reframed|boundary|fragment/i.test(stack);
		});
		expect(wrapperFramesDetected).toBe(false);
	});
});

/**
 * The inverse canary for the test matrix: in legacy mode the documented global patches must be in
 * place. If this fails, the HOST_ISOLATION env plumbing is broken and the strict-mode run is not
 * actually exercising strict mode.
 */
test('legacy mode installs the documented global patches (matrix canary)', async ({ page }) => {
	// eslint-disable-next-line playwright/no-skipped-test
	test.skip(HOST_ISOLATION !== 'legacy', 'canary for the legacy mode of the test matrix');

	const hostState = await loadAppAndCaptureHostState(page);

	expect(hostState.appendChildNative).toBe(false);
	expect(hostState.getRootNodeNative).toBe(false);
	expect(hostState.ownerDocumentGetterNative).toBe(false);
	expect(hostState.historyHasOwnPushState).toBe(true);
	// behavioral parity holds even in legacy mode for host nodes
	expect(hostState.hostCanaryRootIsDocument).toBe(true);
	expect(hostState.hostCanaryOwnerDocumentIsDocument).toBe(true);
});
