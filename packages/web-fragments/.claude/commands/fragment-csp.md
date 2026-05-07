---
name: fragment-csp
description: Generate or audit Content Security Policy headers for a web-fragments setup — ensures the iframe isolation model is not blocked by X-Frame-Options or frame-ancestors directives.
---

Generate or audit Content Security Policy headers for a web-fragments setup. Context: $ARGUMENTS

## How web-fragments uses iframes

The gateway creates a hidden iframe with `src` pointing to the fragment URL to provide an isolated JS execution context. This means:

- The gateway origin must be allowed to frame the fragment origin (`frame-ancestors`)
- Fragment endpoints must NOT set `X-Frame-Options: DENY` or `frame-ancestors 'none'`
- The gateway detects `X-Frame-Options: DENY` and logs a warning — the fragment will silently fail

## Step 1 — Find existing CSP configuration

Search for:

- `Content-Security-Policy` headers in middleware, Worker responses, or `_headers` files
- `X-Frame-Options` headers on fragment endpoints
- `<meta http-equiv="Content-Security-Policy">` in HTML files

## Step 2 — Audit for web-fragments compatibility

For each fragment endpoint, check for:

**Blockers (break the iframe):**

- `X-Frame-Options: DENY` — change to `SAMEORIGIN` or remove
- `Content-Security-Policy: frame-ancestors 'none'` — add the gateway origin

**Required allowances:**

- `frame-ancestors 'self' <gateway-origin>` — allows the gateway to iframe the fragment
- If the fragment loads scripts from CDNs, ensure `script-src` includes those origins
- If the fragment uses inline scripts (common with SSR frameworks), ensure `script-src` includes `'unsafe-inline'` or proper nonces

**Note on `iframeHeaders`:** The `iframeHeaders` field in `registerFragment()` sets headers on the iframe _stub_ response (the tiny document returned when `sec-fetch-dest: iframe`), not on the fragment content response itself.

## Step 3 — Generate recommended headers

For the **gateway / host app shell**:

```
Content-Security-Policy:
  default-src 'self';
  script-src 'self' 'unsafe-inline';
  frame-src 'self' <fragment-origin>;
```

For each **fragment endpoint**:

```
Content-Security-Policy: frame-ancestors 'self' <gateway-origin>;
```

For **Cloudflare Pages** (`public/_headers` file):

```
/<fragment-route>/*
  Content-Security-Policy: frame-ancestors 'self' <gateway-origin>
  X-Frame-Options: ALLOWALL
```

## Step 4 — Apply fixes

Apply fixes directly using the Edit tool:

- For Node/Express: modify the response headers middleware
- For Cloudflare Workers: modify the Response constructor in the fetch handler
- For `_headers` files: edit directly

Report what changed and verify no other CSP directives were inadvertently tightened.
