---
name: fragment-perf
description: Audit a web-fragments setup for performance issues — checks piercing config, streaming, caching, route pattern specificity, and production mode.
---

Audit this web-fragments setup for performance issues. Context: $ARGUMENTS

Read the gateway configuration and fragment endpoint code, then check each category.

## 1. Piercing

Piercing embeds fragment HTML into the app shell response server-side, eliminating the client-side round-trip on first load. It is the primary performance feature.

- [ ] Is `piercing: true` set (or defaulted) for high-traffic entry-point routes? If any has `piercing: false`, explain the cost.
- [ ] Does the app shell HTML include `<web-fragment fragment-id="...">` on matching routes? Without the placeholder, the gateway appends the fragment at end of `<body>` — piercing still works but the fragment may appear out of place.
- [ ] Is `piercingStyles` set with positioning rules for `web-fragment-host[data-piercing="true"]`? Without it, the pre-pierced fragment may appear in the wrong position, causing layout shift (CLS).

## 2. Streaming

- [ ] Is the gateway running on Cloudflare Workers with native HTMLRewriter? Native HTMLRewriter streams the combined response before the fragment fetch completes. The WASM HTMLRewriter (Node.js) must buffer the entire fragment first — flag this as a latency limitation.
- [ ] Does the fragment endpoint stream its response? Frameworks like Remix and Qwik City support streaming SSR. Confirm the fragment is not buffering before sending.

## 3. Caching

- [ ] Does the fragment endpoint set `Cache-Control` headers? Without caching, every hard navigation fetches the fragment fresh.
- [ ] Are fragment cache headers forwarded to the combined response via `forwardFragmentHeaders: ['cache-control']`? Without this, the host's cache headers are used instead.
- [ ] The gateway sets `Vary: sec-fetch-dest` on all responses to prevent BFCache issues — verify no proxy is stripping this header.
- [ ] The iframe stub is cached for 1 hour by default (`max-age=3600, stale-while-revalidate=31536000`). Only flag if `iframeHeaders` is overriding it with a shorter TTL.

## 4. Route pattern specificity

- [ ] Are any `routePatterns` overly broad (e.g. `/:_*` catching everything)? This causes the gateway to attempt fragment fetches for routes that should fall through to the app shell.
- [ ] If multiple fragments are registered, do their patterns overlap? The gateway matches the first pattern found. More specific patterns should be listed first. (This is a known TODO in `fragment-gateway.ts`.)

## 5. Production mode

- [ ] Is `mode` set to `'production'` in deployed environments? Development mode disables compression passthrough for Miniflare compatibility (cloudflare/workers-sdk#6577) and emits verbose error responses — both are wrong for production.

## Output

For each issue:

1. Severity: **High** (user-visible regression) / **Medium** (latency increase) / **Low** (optimization opportunity)
2. What was found (with file path and line number)
3. The specific fix

Apply low-risk fixes automatically (wrong `mode`, missing `forwardFragmentHeaders`). Ask before structural changes.
