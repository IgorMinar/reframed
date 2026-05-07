---
name: migrate-to-fragments
description: Analyze an existing app and produce a phased web-fragments migration plan — identifies fragment candidates, gateway placement, and shared state risks.
---

Analyze this project and produce a web-fragments migration plan. Context: $ARGUMENTS

## Step 1 — Understand the current architecture

Read the project files to determine:

- Is this a monolithic SSR app, a SPA, or a mix?
- What server framework is in use (Express, Fastify, Cloudflare Workers, Next.js, Remix, etc.)?
- What frontend framework is in use (React, Vue, Angular, vanilla, etc.)?
- Are there distinct "sections" that could be independently deployed (admin panel, user profile, checkout)?
- What is the current routing structure?

## Step 2 — Identify fragment candidates

A good fragment candidate:

- Has distinct ownership (different team, different release cadence)
- Has a bounded URL namespace (e.g. `/account/`, `/checkout/`, `/admin/`)
- Does NOT share mutable client-side state with other sections (read-only shared state like user identity is fine)
- Can be independently built and deployed

List each candidate with:

- Proposed `fragmentId`
- Proposed `routePatterns` (path-to-regexp v6 syntax, e.g. `/account/:_*`)
- Current location in the monolith
- Extraction complexity: low / medium / high
- Key dependencies to untangle

## Step 3 — Propose gateway placement

Determine where the `FragmentGateway` middleware should live:

- **Cloudflare Workers/Pages**: a `functions/_middleware.ts` or dedicated Worker
- **Express/Connect**: middleware added before static file serving
- **Next.js / Remix**: a separate gateway proxy in front of the app

Gateway stub for **Express**:

```ts
import { FragmentGateway } from 'web-fragments/gateway';
import { getNodeMiddleware } from 'web-fragments/gateway/node';

const gateway = new FragmentGateway({ piercingStyles: '' });
// gateway.registerFragment(...) calls go here

app.use(getNodeMiddleware(gateway, { mode: 'development' }));
// static file serving must come AFTER this middleware
```

Gateway stub for **Cloudflare Workers**:

```ts
import { FragmentGateway } from 'web-fragments/gateway';
import { getWebMiddleware } from 'web-fragments/gateway';

const gateway = new FragmentGateway({ piercingStyles: '' });

export default {
	fetch(request, env, ctx) {
		return getWebMiddleware(gateway, { mode: 'production' })(request, () => env.ASSETS.fetch(request));
	},
};
```

## Step 4 — Phased migration plan

Order fragments by extraction complexity (low first). For each fragment:

1. Register route patterns in the gateway pointing to the current monolith (no isolation yet)
2. Add `<web-fragment fragment-id="...">` placeholder to the host app shell on matching routes
3. Call `initializeWebFragments()` in the host app's client entry point
4. Extract the fragment to its own deployable unit
5. Update `endpoint` in gateway registration to point to the new service
6. Enable piercing and add `piercingStyles` for layout continuity
7. Write Playwright tests using the `/fragment-test` skill

## Step 5 — Shared state risks

List any global client-side state (Redux, Zustand, `window.*` globals, global CSS variables) currently shared across sections being extracted. For each, explain the risk and suggest a replacement: URL params, custom events, shared API calls, or pub/sub between fragments.

## Output

Produce a markdown document with:

- Architecture summary (2-3 sentences)
- Fragment candidate table: fragmentId | routePatterns | complexity | owner
- Gateway placement recommendation with code
- Phased plan as a numbered checklist
- Shared state risks section

Do not modify any files unless the user explicitly asks to apply a specific step.
