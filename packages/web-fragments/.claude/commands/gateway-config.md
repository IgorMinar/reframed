---
name: gateway-config
description: Review or generate a FragmentGateway configuration — flags deprecated fields, missing error handlers, and middleware ordering issues.
---

Review or generate the FragmentGateway configuration for this project. Arguments: $ARGUMENTS

## What to do

Search the project for existing gateway configuration:

- Look for `new FragmentGateway(` calls
- Look for `registerFragment(` calls
- Look for `getWebMiddleware(` or `getNodeMiddleware(` calls
- Look for Cloudflare Workers entry points (`export default { fetch`) or Express/Connect server files

If no gateway exists, generate one (ask the user which deployment target: Cloudflare Workers/Pages or Node/Express).

## Configuration review checklist

For each registered fragment, check and flag:

**Required fields:**

- [ ] `fragmentId` is present and unique across all registrations
- [ ] `routePatterns` is non-empty and uses valid path-to-regexp v6 syntax (e.g. `/path/:param`, `/path/:_*` for catch-all)
- [ ] `endpoint` is set (not the deprecated `upstream`)

**Deprecated fields (warn and suggest migration):**

- `upstream` → rename to `endpoint`
- `prePiercingClassNames` → rename to `piercingClassNames`
- `prePiercingStyles` on `FragmentGatewayConfig` → rename to `piercingStyles`

**Header forwarding:**

- [ ] If the fragment sets response headers that the host app needs (e.g. `Cache-Control`, custom fragment headers, `Set-Cookie`), they must be listed in `forwardFragmentHeaders`
- [ ] `iframeHeaders` is only needed for custom auth or tracing headers on the iframe stub request

**SSR error handling:**

- [ ] `onSsrFetchError` is present — without it, a fragment fetch failure returns a generic 500 to the end user
- [ ] The returned `response` has `content-type: text/html`
- [ ] If `overrideResponse: true` is used, the error response replaces the entire page (useful for auth redirects)

**Middleware placement:**

- [ ] For Express/Connect: `app.use(getNodeMiddleware(...))` must come BEFORE static file middleware and route handlers
- [ ] For Cloudflare Workers: `getWebMiddleware` wraps the `ASSETS.fetch` call
- [ ] `mode` is set to `'production'` for deployed environments (disables miniflare workarounds and verbose error responses)

**Piercing styles:**

- [ ] `piercingStyles` string is valid CSS
- [ ] The selector targets `web-fragment-host[data-piercing="true"]` for pre-piercing layout (positioning, z-index) so the fragment appears in the correct place before portaling completes
- [ ] Styles are scoped enough not to affect non-fragment elements

## Output

Report findings as a prioritized list:

1. **Errors** — things that will definitely break (missing required fields, deprecated fields still in use)
2. **Warnings** — things that may cause subtle issues (missing `onSsrFetchError`, unscoped piercing styles)
3. **Suggestions** — optional improvements (adding `forwardFragmentHeaders`, tightening route patterns)

If the user asked to fix issues, apply them directly with the Edit tool. Show a diff summary of what changed.
