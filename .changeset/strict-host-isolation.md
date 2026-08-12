---
'web-fragments': minor
---

Add opt-in strict host-isolation mode: `initializeWebFragments({ hostIsolation: 'strict' })` confines all interception to the fragment boundary — per-fragment prototype stamping of fragment DOM nodes, born-inert scripts with a shadow-root-scoped MutationObserver activation safety net, and patch-free host navigation detection (`onHostNavigation` adapter and/or the Navigation API) — so no main-context prototype or global is ever modified. The default remains the legacy behavior for now.

Also fixes two pre-existing wrong-context script execution bugs affecting both modes: scripts inside inserted DocumentFragments (e.g. cloned template contents) and multiple scripts inserted via a single `append()`/`prepend()`/`replaceChildren()`/`replaceWith()` call executed in the main JavaScript context instead of the fragment's context.
