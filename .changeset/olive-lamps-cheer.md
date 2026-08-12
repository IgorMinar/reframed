---
'web-fragments': patch
---

Virtualize the Document API surface via a WebIDL-classified proxy facade instead of ad-hoc per-property patches.

The reframed iframe document's prototype chain now contains a Proxy that classifies every property access:

- audited members that require virtualization are redirected to the fragment's DOM in the main document (same behavior as the previous per-property patches),
- audited members whose native iframe behavior is correct pass through untouched,
- spec-defined Document members that have not been audited yet (per a generated manifest derived from the browser specs' WebIDL via @webref/idl) pass through natively but log a one-time dev-mode diagnostic, turning silently-wrong-document bugs into actionable warnings.

The facade only uses ES2015 features (Proxy, Reflect, Object.setPrototypeOf) supported by all evergreen browsers, and the diagnostics (including the generated WebIDL manifest) are fully tree-shaken from production builds.
