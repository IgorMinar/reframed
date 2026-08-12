# RFC: Host-page isolation — confining all interception to the fragment boundary

- Status: draft
- Branch: `host-page-isolation-rfc`
- Related: the Qwik `pushState` workaround in `main-patches.ts` (`monkeyPatchHistoryAPI`), #250

## 1. Problem

Adopting Web Fragments today rewrites the host page's DOM and History prototypes. `main-patches.ts`
mutates, for the lifetime of the page:

| Global mutated                                                                                       | Purpose                                                                                                   |
| ---------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------- |
| `Node.prototype.appendChild` / `insertBefore` / `replaceChild`                                       | Detect scripts/preload-links entering a fragment's DOM; neutralize + execute in the fragment's JS context |
| `Element.prototype.append` / `prepend` / `replaceChildren` / `replaceWith` / `insertAdjacentElement` | Same, for the multi-argument insertion methods                                                            |
| `Node.prototype.ownerDocument` (getter)                                                              | Make fragment nodes report the fragment's virtualized document                                            |
| `Node.prototype.getRootNode`                                                                         | Make fragment nodes report the fragment's document as their root                                          |
| `window.history.pushState` / `replaceState` / `back` / `forward` / `go`                              | Broadcast host navigations to bound fragments (`reframed:navigate`)                                       |

This has three costs, none of which are borne by the fragment — they are borne by the **host**:

1. **Correctness risk for every script on the page.** The host framework, analytics, and third-party
   widgets all run on modified prototypes. We already carry one interop scar: the no-op `pushState`
   setter needed to keep QwikCity from crashing when it tries to monkey-patch history itself. Every
   future collision of this kind is discovered in production by someone else's code.
2. **Host-wide overhead.** Every DOM insertion anywhere on the page — including pages and routes that
   render zero fragments — pays a `getRootNode()` walk to answer "is this inside a fragment?".
   `script-execution.ts` itself carries the comment "we potentially need to run this check
   millions/billions of times".
3. **Adoption friction.** For the enterprise incremental-migration audience, "the library rewrites
   your page's DOM prototypes" is a security/stability review red flag, independent of whether it has
   ever misbehaved.

The window/document patches applied _inside_ the hidden iframe are not a problem — that realm is
wholly owned by the fragment. The problem is exclusively the mutations of the **main** realm.

## 2. Why the globals exist (the real constraint)

Fragment JS executes in the iframe realm, but the fragment's DOM nodes belong to the **main** realm.
When fragment code calls `element.appendChild(script)`, the `appendChild` it invokes resolves through
the _main_ realm's `Node.prototype` — so today the main prototype is the only place we intercept it.
Any replacement design must intercept operations **on main-realm nodes** without touching main-realm
prototypes.

A second, less obvious dependency: the client-side streaming path (`reframeWithFetch` →
`WritableDOMStream`) receives _live_ fragment HTML (scripts are only pre-neutralized by the gateway on
the pierced SSR path). Streamed scripts are neutralized and rerouted **by the global insertion
patches** as writable-dom inserts them. Removing the globals therefore requires a replacement for the
streaming path too, not just for runtime insertions.

## 3. Goals / non-goals

Goals:

- **G1 — Host purity:** after `initializeWebFragments()` and any number of fragments mounted and
  destroyed, every main-realm global and prototype is `===` its pristine value. Zero overhead on DOM
  operations outside fragment DOM.
- **G2 — Behavior parity** for fragment code, verified by the existing playground e2e suites in
  Chromium, Firefox, and WebKit.
- **G3 — Incremental rollout:** legacy behavior remains available behind a flag until parity is
  proven; strict mode becomes the default in a minor release; the globals are deleted before 1.0.

Non-goals:

- Building a full cross-realm membrane. Host code reaching into a fragment's shadow DOM and mutating
  it remains best-effort (it already is today).
- Security sandboxing (#257). This RFC is about _not touching the host_, not about containing a
  hostile fragment.

## 4. Design overview

Three mechanisms replace the five global patches. The unifying idea is the same one used by the
document proxy facade (see the `document-proxy-facade` branch): **splice behavior into the prototype
chain of objects that belong to the fragment, at the fragment boundary — never into shared
prototypes.**

```
                    main realm (untouched prototypes)
   ┌────────────────────────────────────────────────────────────┐
   │  host app, analytics, 3rd-party scripts                    │
   │                                                            │
   │   <web-fragment-host>                                      │
   │    #shadow-root  ←── (B) boundary observer (safety net)    │
   │      <wf-document>  ←── (A) stamped nodes (sync intercept) │
   │        …fragment DOM, every node stamped…                  │
   │                                                            │
   └────────────────────────────────────────────────────────────┘
        (C) host-navigation adapters — no history patch
```

- **(A) Boundary stamping.** Every node inside a fragment's DOM gets a per-fragment spliced prototype
  that overrides the insertion methods plus `ownerDocument`, `getRootNode`, `cloneNode`, `innerHTML`,
  and `insertAdjacentHTML`. Stamping is applied synchronously at every point where nodes enter the
  fragment world, and stamped entry points propagate the stamp to whatever they create or insert.
- **(B) Born-inert scripts + boundary observer.** Every script the fragment can obtain is inert from
  birth, so a script that reaches the DOM through an unstamped path _cannot_ execute in the main
  realm. A `MutationObserver` scoped to the fragment's shadow root activates inert scripts (in the
  iframe realm) that slipped past synchronous interception, and doubles as the dev-mode diagnostic
  channel.
- **(C) Host-navigation adapters.** Bound fragments keep their existing iframe-side `history` proxy
  (already fragment-scoped). Detection of _host-initiated_ navigations moves from patching
  `window.history` to a tiered adapter: Navigation API where available, an explicit host-router
  integration hook, and an opt-in fallback. The Qwik workaround disappears with the patch.

The load-bearing property of this design is the **two-tier split between correctness and latency**:

- _Correctness_ (a fragment script must never execute in the main realm) is guaranteed by
  born-inertness alone — it holds even when interception is bypassed entirely.
- _Latency_ (scripts should activate synchronously, matching today's semantics) is provided by
  stamping on the hot paths, with the observer as an asynchronous (microtask-delayed) fallback for
  cold paths.

This means every hole in stamping coverage degrades to "activation happens a microtask later", never
to "script ran in the wrong realm".

## 5. Mechanism details

### 5.1 (A) Boundary stamping

For each fragment, lazily build one spliced prototype per element class encountered:

```ts
stampedProto(HTMLDivElement.prototype) = Object.create(HTMLDivElement.prototype, fragmentBoundaryOverrides);
Object.setPrototypeOf(node, stampedProto(Object.getPrototypeOf(node)));
```

Properties of this approach:

- `instanceof` and all untouched members keep working (the native prototype remains in the chain).
- One `setPrototypeOf` per node instead of ~14 own-property definitions; method identity is shared
  across same-class nodes in the same fragment (`divA.appendChild === divB.appendChild`).
- No own-property pollution visible to `getOwnPropertyNames`/`hasOwnProperty`.
- Un-stamping (fragment destruction, portaling out) is a single prototype restore.
- Uses only ES2015 `Object.create`/`setPrototypeOf` — supported everywhere the library already runs.
- Fallback: if per-node `setPrototypeOf` shows pathological deopts in a target engine (§9), the same
  installer interface can stamp own properties instead; the choice is an implementation detail behind
  `stampNode(node)`.

The override set and what each does:

| Override                                                                                                                      | Behavior                                                                                                                                                  |
| ----------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `appendChild`, `insertBefore`, `replaceChild`, `append`, `prepend`, `replaceChildren`, `replaceWith`, `insertAdjacentElement` | Current `reframedDomInsertion` logic (neutralize scripts → insert → activate in iframe realm), **plus** recursively stamp the inserted subtree            |
| `innerHTML` (set), `insertAdjacentHTML`, `outerHTML` (set)                                                                    | Call native setter, then synchronously stamp the newly parsed descendants (parser-created scripts are non-executable by spec, so only stamping is needed) |
| `cloneNode`                                                                                                                   | Call native, stamp the clone subtree synchronously (inert script attributes copy with the clone, preserving born-inertness)                               |
| `ownerDocument` (getter)                                                                                                      | Return the fragment's virtualized document                                                                                                                |
| `getRootNode`                                                                                                                 | Return the fragment's virtualized document (current `main-patches` semantics)                                                                             |

Stamping entry points (all synchronous):

1. **Fragment creation:** the shadow root instance itself (own-property stamp — `ShadowRoot` has no
   per-fragment prototype concern), `<wf-document>`, and the initial pierced DOM (one tree walk).
2. **Streaming:** nodes inserted by writable-dom arrive through the stamped `<wf-document>`/descendant
   insertion methods, which stamp recursively — the streamed tree is stamped as it grows. (§5.3)
3. **The document facade:** `createElement`, `createElementNS`, `importNode`, `createDocumentFragment`
   etc. stamp what they return. Nodes created by fragment code are stamped _before_ fragment code can
   touch them.
4. **Propagation:** stamped `cloneNode`/`innerHTML`/insertion methods stamp everything they
   create or admit, so the stamped set is closed under the operations fragment code can perform on it.

Coverage analysis — how main-realm nodes can enter fragment code's hands:

| Vector                                                              | Covered by                                                                              |
| ------------------------------------------------------------------- | --------------------------------------------------------------------------------------- |
| `document.createElement/NS`, `createDocumentFragment`, `importNode` | facade stamps at creation (3)                                                           |
| `cloneNode` of a stamped node (incl. `template.content` cloning)    | stamped `cloneNode` (4)                                                                 |
| `innerHTML` / `insertAdjacentHTML` parsing                          | stamped setter walk (4); parsed scripts inert by spec                                   |
| initial SSR/pierced DOM, streamed DOM                               | (1) and (2)                                                                             |
| DOM query results                                                   | already-stamped nodes (queries don't create nodes)                                      |
| host-created node handed to fragment code                           | **not stamped** — insertion still safe via born-inertness + observer (§5.2); dev-warned |

### 5.2 (B) Born-inert scripts + boundary observer

**Born-inert:** the facade's `createElement('script')` (and `createElementNS`, `importNode`) returns
the script pre-neutralized (`type="inert"`, original type shadowed exactly as the gateway does for
SSR content) and registers it for activation. Scripts arriving via HTML parsing (`innerHTML`,
`insertAdjacentHTML`) are non-executable per spec; scripts arriving via the stream or piercing are
neutralized by writable-dom/the gateway; clones inherit the inert attributes. Consequence: **no
script reachable by fragment code can execute in the main realm**, regardless of how it is inserted.

**Activation:** stamped insertion methods activate inert scripts synchronously (today's semantics).
The per-fragment `MutationObserver` (`subtree: true` on the shadow root) is the safety net:

- activates inert scripts (and inert preload links) that were inserted through unstamped paths —
  e.g. host code, or a framework that captured `Node.prototype.appendChild` before stamping and calls
  it uncurried (`nativeAppend.call(el, script)`); activation is then delayed by one microtask;
- stamps subtrees that entered unstamped (closing the stamp set behind such bypasses);
- in dev mode, logs a diagnostic naming the bypass (same philosophy as the document facade's
  unaudited-member warnings): _"a node entered fragment X's DOM through an unstamped path"_ — turning
  silent semantic drift into an actionable report.

Semantics delta vs. today: an inline script inserted through an _unstamped_ path used to execute
synchronously during insertion (courtesy of the global patch) and now executes a microtask later. On
stamped paths — which include every path fragment code normally exercises — semantics are unchanged.
The dev diagnostic tells us empirically which apps hit the cold path, before the default flips.

### 5.3 writable-dom integration

writable-dom (already maintained as a `web-fragments/writable-dom` fork) creates elements via the
target's `ownerDocument` and inserts them incrementally into the connected target. With a stamped
`<wf-document>` as the sink, insertions flow through stamped methods and the growing tree stays
stamped. Two audit items on the fork:

1. Confirm every insertion goes through a method on the (stamped) parent rather than a captured
   native (if not: add an explicit `onNodeInserted` hook to the fork — it is our fork precisely so
   the sink can cooperate with the boundary).
2. Script handling: writable-dom already defers/neutralizes scripts for its own streaming purposes;
   align it with born-inertness so streamed scripts are activated by the same single code path as
   runtime scripts.

### 5.4 (C) Host navigation without patching `window.history`

What the global patch actually provides: _bound fragments need to know when the host app navigates_
(host router `pushState`/`replaceState`), because `popstate` alone only covers back/forward.

Replacement, tiered by what the host can offer:

1. **Navigation API** (`window.navigation`, `currententrychange`/`navigate` events): observation
   without mutation. Feature-detected at fragment init; requires no host cooperation. Coverage is
   evergreen-Chromium today and expanding; it is an enhancement tier, not the baseline.
2. **Host adapter (the documented, supported path):**
   `initializeWebFragments({ onHostNavigation: (subscribe) => … })` — or the imperative dual,
   `notifyHostNavigation()`, called from the host router's existing after-navigate hook (every
   enterprise router — Angular Router, React Router, Next, custom — has one). One line of explicit
   integration replaces silent prototype mutation; for the target audience this is a feature, not a
   cost: the integration is visible, greppable, and reviewable.
3. **`popstate` + focus/visibility-edge resync (always on):** back/forward and tab-switch cases are
   covered natively; bound fragments already resync location on these events.
4. **Legacy patch (opt-in):** `hostIsolation: 'legacy'` keeps today's global history patch for hosts
   that cannot integrate; carries the Qwik workaround with it. Deleted at 1.0.

Bound fragments' _outbound_ navigation (fragment calls `history.pushState`) already goes through the
iframe-side `history` proxy — fragment-scoped, unchanged. The `reframed:navigate` CustomEvent channel
is replaced by a library-internal emitter (no more meaningful host-visible events on `window`).

`SyntheticPopStateEvent` re-dispatch on the main window (used today so _other_ fragments observe a
fragment's navigation) moves to the same internal emitter: fragment→fragment notification never
needed the host's prototypes.

## 6. Modes and rollout

```ts
initializeWebFragments({
	// 'strict'  = no main-realm globals touched (target default)
	// 'legacy'  = current behavior (global patches)
	hostIsolation?: 'strict' | 'legacy',
	onHostNavigation?: (notify: () => void) => void,
});
```

- Phase A (minor release): `strict` ships, default `legacy`. Dev-mode boundary diagnostics on in both
  modes. Playground e2e matrix runs `PIERCING × HOST_ISOLATION` (4 configurations).
- Phase B (next minor): default flips to `strict` after the playground matrix and at least one
  production adopter (the Cloudflare dashboard team) run clean. `legacy` logs a deprecation notice.
- Phase C (pre-1.0): `legacy` and `main-patches.ts` are deleted. #250 (double-init errors) becomes
  moot: `initializeWebFragments` no longer has global side effects to guard.

**Host-purity acceptance test** (the contract, enforced in CI): a playground spec snapshots
`Node.prototype`/`Element.prototype`/`History.prototype`/`window.history` descriptors from a pristine
same-origin iframe, mounts/destroys multiple fragments in strict mode, and asserts every descriptor
and function identity on the main realm still matches the pristine snapshot — plus a behavioral
probe: a host-inserted inline script outside fragments executes with zero library code on the stack
(no wrapper frames), and host `getRootNode`/`ownerDocument` return native values for host nodes.

## 7. Performance analysis

| Surface                                     | Today                                                      | Strict mode                                                              |
| ------------------------------------------- | ---------------------------------------------------------- | ------------------------------------------------------------------------ |
| Host DOM insertions (no fragments involved) | `getRootNode` walk + wrapper on every insertion, page-wide | **zero** — native fast path                                              |
| Host property reads (`ownerDocument`)       | patched getter, page-wide                                  | **zero**                                                                 |
| Fragment DOM insertions                     | wrapper + walk                                             | wrapper via stamped proto (no walk — membership is intrinsic)            |
| Fragment node creation                      | native                                                     | + one `setPrototypeOf` per node (amortized in creation/streaming)        |
| Fragment memory                             | —                                                          | one spliced proto per (fragment × element class); nodes share them       |
| Observer                                    | —                                                          | one `MutationObserver` per fragment; records only for fragment mutations |

The stamping cost scales with _fragment_ DOM size and is paid by the party that benefits. Benchmark
gates before flipping the default: streaming throughput of a large fragment (writable-dom insertion
rate with stamping on/off) and a hydration-heavy fragment (React playground app), each within an
agreed budget (target: <5% regression fragment-side, hard 0% host-side by construction).

## 8. Interaction with the document proxy facade

This RFC assumes the `document-proxy-facade` branch as its substrate: born-inert creation and
creation-time stamping hook into the facade's `virtualized` overrides (`createElement`, `importNode`,
…), and `ownerDocument`/`getRootNode` stamping completes, from the node side, the same illusion the
facade provides from the document side. Sequencing: land the facade first; this work extends
`document-overrides.ts` rather than re-patching. (It can be rebased onto `main` without the facade —
the hooks then attach to the existing `defineProperties` patches — but the facade's classification
and diagnostics infrastructure is where this design's dev-warnings belong.)

## 9. Risks and open questions

1. **Per-node `setPrototypeOf` engine behavior.** Historically flagged as a deopt; modern engines
   tolerate it far better, and the objects affected are fragment-only. Mitigation: benchmark early
   (Phase 0); the stamping installer abstracts the strategy so own-property stamping is a drop-in
   fallback. Worst case, hybrid: proto-swap for elements, own-props for text/comment nodes (which
   don't need most overrides).
2. **Uncurried natives** (`const ap = Node.prototype.appendChild; ap.call(fragEl, …)`). Bypasses
   stamping; correctness held by born-inertness; activation degrades to microtask latency; dev
   diagnostic reports it. Accepted residual.
3. **Synchronous-inline-script expectations on unstamped paths.** Quantified via diagnostics during
   Phase A before the default flips (§5.2). Accepted residual with escape hatch (`legacy`).
4. **Navigation API coverage.** Treated strictly as an enhancement tier; the adapter is the
   documented contract. No behavior depends on Navigation API availability.
5. **Portaling** (`portalHost`, `moveBefore`): stamped prototypes travel with the nodes (prototype is
   per-node state), so piercing adoption keeps stamps; verify `moveBefore` path in the matrix suite.
6. **Text/comment nodes** don't need insertion overrides but do need `ownerDocument`/`getRootNode`
   virtualization for parity — measure whether stamping them is worth it or whether facade-side
   answers suffice (today's global getter covers them; parity call to be made with a playground spec).
7. **Third-party code inside the fragment** that mutates fragment DOM via its own captured natives —
   same as (2), same safety net.

## 10. Test plan

- **New playground apps:** `runtime-script-insertion` (inline-sync expectation, `src` scripts, nested
  subtrees, `template.content` clone-and-insert, `innerHTML` + facade-created script); `stamping`
  (propagation through cloneNode/innerHTML/insertAdjacentHTML, un-stamp on destroy);
  `host-purity` (§6); `navigation-adapters` (adapter, popstate, Navigation-API-mocked).
- **Matrix:** all playground suites × `PIERCING={true,false}` × `HOST_ISOLATION={strict,legacy}` ×
  {Chromium, Firefox, WebKit}.
- **Unit:** stamping installer (proto identity sharing, un-stamp restore, override completeness
  cross-checked against the classification file, same pattern as the facade spec).
- **Benchmarks (Phase 0 + gate):** streaming insert rate, hydration time, host-insertion overhead
  (must be exactly zero — assert no wrapper frames via `Error.stack` probe in the purity spec).

## 11. Phased implementation

| Phase | Deliverable                                                                                                                                                       | Size (rough) |
| ----- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------ |
| 0     | Characterization tests for every current global-patch dependency (esp. streaming path); `setPrototypeOf` benchmark; writable-dom fork audit                       | S            |
| 1     | Stamping installer + shadow-root observer + born-inert creation in the facade; dev diagnostics; everything **behind `hostIsolation: 'strict'`, default `legacy`** | M            |
| 2     | Migrate script/preload activation off global insertion patches; writable-dom alignment; `runtime-script-insertion` + `stamping` suites green in strict            | M–L          |
| 3     | `ownerDocument`/`getRootNode` via stamping; text/comment-node parity decision (§9.6)                                                                              | S–M          |
| 4     | Navigation adapters; internal emitter replaces `reframed:navigate`; delete Qwik workaround in strict; `navigation-adapters` suite                                 | M            |
| 5     | Bake: matrix in CI, adopter validation, benchmark gates; flip default to `strict`; deprecate then delete `main-patches.ts`                                        | S + calendar |

Phases 1–4 each land independently shippable behind the flag, per the project's incremental-release
practice.
