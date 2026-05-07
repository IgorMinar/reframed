---
name: debug-fragment
description: Diagnose a web-fragments issue — covers invisible fragments, broken piercing, FOUC, JS isolation failures, and CSP/iframe blocks.
---

Diagnose a web-fragments issue. The user's description (if any): $ARGUMENTS

Work through each category below. For each check, inspect actual project files — do not guess. Skip categories the user's problem clearly does not relate to.

---

## 1. Fragment does not appear at all

**Gateway routing:**

- Does the request URL match any `routePatterns`? Patterns use path-to-regexp v6. A common mistake: `/products` does NOT match `/products/123` — use `/products/:_*` to match sub-paths.
- Is `matchRequestToFragment` being reached? Add `console.log` to the middleware to verify.
- Is the middleware placed before static file serving? If Express/Connect serves `index.html` before the fragment middleware runs, the gateway never sees the request.

**Fragment endpoint reachability:**

- Is the `endpoint` URL accessible from the gateway? In local dev, check the port is running.
- Does the fragment endpoint return a 200 for the route? A 404 or 500 triggers `onSsrFetchError` (or a default error response if that handler is missing).
- Does the endpoint set `X-Frame-Options: DENY`? This blocks the hidden iframe the gateway uses for isolated JS execution. The gateway detects this but the fragment will silently fail to load.

**Client-side initialization:**

- Is `initializeWebFragments()` called before any `<web-fragment>` element connects to the DOM?
- Is the `fragment-id` attribute on `<web-fragment>` an exact case-sensitive match to the `fragmentId` in `registerFragment()`?

---

## 2. Piercing not activating (fragment loads but SSR content is missing on first paint)

- Is `piercing: true` set in `registerFragment()`? It defaults to true, but check for an explicit `false`.
- Is the request a hard navigation (`sec-fetch-dest: document`)? Piercing only fires on full-page loads, not fetch/XHR.
- Is HTMLRewriter available? On Node.js, the WASM HTMLRewriter from the `htmlrewriter` package is used. Check it is importable and not throwing.
- Does the app shell HTML contain a `<web-fragment fragment-id="...">` placeholder on the matching route? Without it, the gateway appends the `<web-fragment-host>` at the end of `<body>` as a fallback — piercing still works but layout may shift.
- Does the fragment's `endpoint` return HTML with a proper `content-type: text/html` header?

---

## 3. Flash of unstyled content (FOUC) during portaling

- Are `piercingClassNames` defined in `registerFragment()` AND do the corresponding CSS rules exist in `piercingStyles`?
- The `piercingStyles` selector should target `web-fragment-host[data-piercing="true"]` — this applies before portaling. After portaling, the shadow root takes over.
- Are external stylesheets loading asynchronously in the fragment? The portaling process preserves `<style>` elements but external `<link rel="stylesheet">` sheets inserted before portaling may not survive in all browsers (known Safari limitation).
- Is there a visible layout shift because the `<web-fragment>` container has no min-height set? Add a min-height matching the expected fragment height.

---

## 4. Fragment JavaScript not executing / broken behavior

**Reframed context issues:**

- Is the fragment's entry script a `<script type="module">`? Module scripts are correctly deferred and execute in the reframed iframe context.
- Is the fragment reading `window.location` and getting the wrong origin? In the reframed context, `window.location` reflects the fragment URL, which is correct. If the fragment is comparing against `window.parent`, that is unexpected — fragments should be self-contained.
- Is the fragment using `document.querySelector` and finding nothing? Within the reframed iframe context, `document` refers to the iframe document. DOM elements are actually in the main frame's shadow root. Use `window.document` consistently rather than global `document` — the reframed context patches them to be equivalent, but third-party libraries may cache a direct reference.
- Is a third-party script failing with a `crossOrigin` or `instanceof` error? The reframed context patches global constructors, but some libraries perform identity checks that bypass the patch. This is a known limitation — report it at https://github.com/web-fragments/web-fragments/issues.

**History / navigation:**

- Is `window.history.pushState` in the fragment navigating only the fragment, not the full page? This is correct behavior — history is shared with the main frame. If the main frame is not responding to the navigation, check that the host SPA's router listens to `popstate` events.

---

## 5. CSP / X-Frame-Options blocking the iframe

- Check the fragment endpoint's response headers for `X-Frame-Options: DENY` or a CSP `frame-ancestors` directive that excludes the gateway origin.
- The gateway creates a hidden iframe with `src` pointing to the fragment URL. The fragment server must allow framing from the gateway's origin.
- For `frame-ancestors`, allow `'self'` or the specific gateway origin.
- The gateway detects `X-Frame-Options: DENY` and logs a warning — check the browser console.

---

## Output

For each failing check, show:

1. What you found (with file path and line number if applicable)
2. The specific fix
3. Whether the fix can be applied automatically (and apply it if yes)

If you cannot determine the root cause from files alone, list the minimal set of `console.log` statements to add to narrow down the problem, and show exactly where to add them.
