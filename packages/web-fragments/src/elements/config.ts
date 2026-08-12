/**
 * Library-wide configuration for Web Fragments elements, set via `initializeWebFragments(options)`.
 */

/**
 * Controls how Web Fragments integrates with the host page.
 *
 * - `'legacy'` — the original integration mode: the library monkey-patches the host page's
 *   `Node`/`Element` prototypes and the History API to detect DOM insertions into fragments and host
 *   navigations. All scripts on the page run on the modified prototypes.
 *
 * - `'strict'` — host-page isolation mode: the library never mutates any main-realm global or
 *   prototype. All interception is confined to the fragment boundary (see rfcs/host-page-isolation.md):
 *   nodes inside a fragment's DOM carry per-fragment spliced prototypes, scripts created by fragment
 *   code are inert from birth, a MutationObserver scoped to each fragment's shadow root acts as an
 *   activation safety net, and host navigations are observed via adapters instead of history patches.
 */
export type HostIsolationMode = 'strict' | 'legacy';

export interface WebFragmentsOptions {
	/**
	 * Host-page integration mode. Defaults to `'legacy'` until strict mode has proven parity
	 * (see rfcs/host-page-isolation.md for the rollout plan).
	 */
	hostIsolation?: HostIsolationMode;

	/**
	 * Host navigation adapter used in `'strict'` mode.
	 *
	 * Bound fragments need to know when the host application navigates (e.g. the host router calls
	 * `history.pushState`). In `'legacy'` mode this is detected by patching the host's History API.
	 * In `'strict'` mode, wire your router's after-navigation hook to the provided `notify` callback:
	 *
	 * ```ts
	 * initializeWebFragments({
	 *   hostIsolation: 'strict',
	 *   onHostNavigation: (notify) => router.afterEach(() => notify()),
	 * });
	 * ```
	 *
	 * Where the Navigation API is available, host navigations are additionally observed automatically.
	 * Back/forward navigations (`popstate`) are always observed natively and need no adapter.
	 */
	onHostNavigation?: (notify: () => void) => void;
}

interface ResolvedWebFragmentsConfig {
	hostIsolation: HostIsolationMode;
	onHostNavigation?: (notify: () => void) => void;
}

const config: ResolvedWebFragmentsConfig = {
	hostIsolation: 'legacy',
};

export function setWebFragmentsConfig(options: WebFragmentsOptions = {}): void {
	if (options.hostIsolation) {
		config.hostIsolation = options.hostIsolation;
	}
	if (options.onHostNavigation) {
		config.onHostNavigation = options.onHostNavigation;
	}
}

export function getWebFragmentsConfig(): Readonly<ResolvedWebFragmentsConfig> {
	return config;
}
