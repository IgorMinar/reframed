---
name: init-fragment
description: Scaffold a new web-fragment end-to-end — generates gateway registration, app shell placeholder, and fragment HTML stub.
---

Scaffold a new web-fragment end-to-end. Work through the following steps:

1. Ask the user (or infer from $ARGUMENTS) for:

   - `fragmentId` — a short kebab-case identifier, e.g. `user-profile`
   - `routePatterns` — one or more path-to-regexp patterns, e.g. `/profile/:userId`, `/profile/:_*`
   - Deployment target: `cloudflare` (Cloudflare Workers / Pages) or `node` (Express / Connect)
   - Whether SSR piercing should be enabled (default: yes)
   - `endpoint` — the fragment's origin URL, e.g. `http://localhost:3001`
   - `piercingClassNames` — optional CSS class names for pre-piercing styling

2. Generate the **gateway registration** block to add to the user's gateway setup file:

For Cloudflare Workers (`web-middleware`):

```ts
import { FragmentGateway } from 'web-fragments/gateway';
import { getWebMiddleware } from 'web-fragments/gateway';

const gateway = new FragmentGateway({
	piercingStyles: `
    <style>
      web-fragment-host[data-piercing="true"] {
        position: absolute;
        z-index: 9999;
      }
    </style>
  `,
});

gateway.registerFragment({
	fragmentId: '<fragmentId>',
	routePatterns: ['<routePattern>'],
	endpoint: '<endpoint>',
	piercing: true,
	piercingClassNames: ['<fragmentId>'],
	onSsrFetchError: () => ({
		response: new Response('<p><fragmentId> is unavailable.</p>', {
			headers: { 'content-type': 'text/html' },
		}),
	}),
});

export default {
	fetch(request, env, ctx) {
		return getWebMiddleware(gateway, { mode: 'production' })(request, () => env.ASSETS.fetch(request));
	},
};
```

For Node / Express:

```ts
import { FragmentGateway } from 'web-fragments/gateway';
import { getNodeMiddleware } from 'web-fragments/gateway/node';

const gateway = new FragmentGateway({ piercingStyles: '' });

gateway.registerFragment({
	fragmentId: '<fragmentId>',
	routePatterns: ['<routePattern>'],
	endpoint: '<endpoint>',
	piercing: true,
	onSsrFetchError: () => ({
		response: new Response('<p><fragmentId> is unavailable.</p>', {
			headers: { 'content-type': 'text/html' },
		}),
	}),
});

app.use(getNodeMiddleware(gateway, { mode: 'development' }));
```

3. Generate the **app shell HTML** placeholder — the `<web-fragment>` element the host app must include on the routes where this fragment appears:

```html
<web-fragment fragment-id="<fragmentId>" src="/<route>"></web-fragment>
```

Remind the user that `initializeWebFragments()` from `web-fragments` must be called once in the app shell's client-side entry point:

```ts
import { initializeWebFragments } from 'web-fragments';
initializeWebFragments();
```

4. Generate a **fragment HTML stub** that the fragment server should return. Emphasize that for piercing to work correctly, `<html>`, `<head>`, and `<body>` tags are preserved (the gateway rewrites them to `<wf-html>`, `<wf-head>`, `<wf-body>` automatically):

```html
<!doctype html>
<html>
	<head>
		<meta charset="UTF-8" />
		<title><fragmentId> fragment</title>
	</head>
	<body>
		<div id="app">
			<!-- <fragmentId> renders here -->
		</div>
		<script type="module" src="/entry.js"></script>
	</body>
</html>
```

5. Remind the user of key caveats:
   - The gateway middleware must be placed **before** static file serving in the middleware chain.
   - The fragment endpoint must NOT set `X-Frame-Options: DENY` — the gateway uses a hidden iframe as the isolated JS execution context.
   - Route patterns follow path-to-regexp v6 syntax. Use `/:_*` to match all sub-paths.
   - `endpoint` can also be a `fetch`-compatible function for custom routing logic.

Output each generated file as a separate fenced code block labelled with where it belongs. If the user has an existing gateway file open or mentioned, insert the `registerFragment` call into it directly using the Edit tool.
