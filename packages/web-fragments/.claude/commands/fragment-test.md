---
name: fragment-test
description: Generate a Playwright test scenario for a web-fragment — produces index.html, fragment.html, and spec.ts following the playground test harness pattern.
---

Generate a Playwright test for a web-fragment scenario. Scenario: $ARGUMENTS

Web-fragments tests use three files per scenario under `test/playground/<scenario-name>/`:

- `index.html` — host page with `<web-fragment>`
- `fragment.html` — fragment HTML served by Vite
- `spec.ts` — Playwright test file

Generate all three. Ask for `fragmentId` and scenario name if not in $ARGUMENTS, then write to disk.

## spec.ts pattern

```ts
import { test, expect } from '@playwright/test';
import { failOnBrowserErrors, getFragmentContext } from '../playwright.utils';

const { beforeEach, describe } = test;

beforeEach(failOnBrowserErrors);

describe('<scenario-name>', () => {
	beforeEach(async ({ page }) => {
		await page.goto('/<scenario-name>/');
	});

	test('fragment renders', async ({ page }) => {
		const fragment = page.locator('web-fragment[fragment-id="<fragmentId>"]');
		await expect(fragment).toBeVisible();
		await expect(fragment.getByRole('heading')).toHaveText('<expected heading>');
	});

	test('DOM is isolated from host', async ({ page }) => {
		await expect(page.locator('#host-element')).not.toHaveCSS('color', 'rgb(255, 0, 0)');
	});

	test('JS runs in isolated context', async ({ page }) => {
		const fragmentHost = page.locator('web-fragment[fragment-id="<fragmentId>"] web-fragment-host');
		// getFragmentContext returns the Playwright Frame for the reframed iframe execution context
		const ctx = await getFragmentContext(fragmentHost);
		expect(await ctx.evaluate(() => document.title)).toBe('<fragmentId> fragment');
	});
});

// Piercing tests — only run when PIERCING env var is not 'false'
process.env.PIERCING !== 'false' &&
	describe('piercing', () => {
		test('fragment host is pre-pierced on hard navigation', async ({ page }) => {
			await expect(page.locator('web-fragment-host[data-piercing="true"]')).toBeAttached();
		});

		test('styles are preserved after portaling', async ({ page }) => {
			const fragmentHost = page.locator('web-fragment-host');
			await page.locator('button#portal-fragment').click();
			await expect(fragmentHost.locator('h2')).toBeVisible();
		});
	});
```

## index.html pattern

```html
<!doctype html>
<html>
	<head>
		<meta charset="UTF-8" />
		<title>Host App</title>
	</head>
	<body>
		<div id="host-element">Host content</div>
		<web-fragment fragment-id="<fragmentId>" src="/<scenario-name>/fragment.html"></web-fragment>
		<script type="module">
			import { initializeWebFragments } from '/src/elements/index.ts';
			initializeWebFragments();
		</script>
	</body>
</html>
```

## fragment.html pattern

```html
<!doctype html>
<html>
	<head>
		<meta charset="UTF-8" />
		<title><fragmentId> fragment</title>
	</head>
	<body>
		<div data-testid="fragment-inner"><h2>Fragment heading</h2></div>
		<script type="module">
			console.log('fragment loaded');
		</script>
	</body>
</html>
```

## Rules

- `failOnBrowserErrors` in `beforeEach` is required — it surfaces console errors that are otherwise swallowed.
- `getFragmentContext(hostLocator)` returns a Playwright `Frame` for `evaluate()` inside the reframed JS context.
- Scope locators to `fragment.locator(...)` to reach inside the shadow root rather than `page.locator(...)`.
- Prefer `toHaveText`, `toBeVisible`, `toHaveCSS` over `evaluate` — they auto-retry.
- `PIERCING` env var is set by `test:playground:pierced` / `test:playground:nonpierced` npm scripts.
