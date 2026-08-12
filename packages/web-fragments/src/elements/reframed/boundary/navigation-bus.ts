import { getWebFragmentsConfig } from '../../config';

/**
 * Host navigation detection for strict host-isolation mode.
 *
 * Fragment-initiated navigations are broadcast exactly as in legacy mode — via a synthetic popstate
 * event dispatched on the main window — because that mechanism mutates no host globals and is part of
 * the observable contract (the host application can react to fragment-driven URL changes through a
 * regular popstate listener).
 *
 * What legacy mode obtains by patching the host's History API — detecting *host-initiated*
 * `pushState`/`replaceState` calls — is replaced here by patch-free sources:
 *
 * 1. the `onHostNavigation` adapter from the library config: the host wires its router's
 *    after-navigation hook to our notify callback;
 * 2. the Navigation API's `currententrychange` event, where available. Traversals are ignored
 *    (covered natively by `popstate`), and fragment-initiated mutations are suppressed via
 *    {@link navigationBus.withFragmentNavigation} so they aren't double-reported.
 */

const hostNavigationSubscribers = new Set<() => void>();

/** True while a fragment-initiated history mutation is being applied. */
let fragmentNavigationInProgress = false;

/** True right after a host navigation was delivered, until the current microtask queue drains. */
let suppressDuplicateDetections = false;

export const navigationBus = {
	/** Subscribes to host-initiated navigations. Returns an unsubscribe function. */
	subscribe(subscriber: () => void): () => void {
		hostNavigationSubscribers.add(subscriber);
		return () => hostNavigationSubscribers.delete(subscriber);
	},

	/**
	 * Applies a fragment-initiated history mutation, suppressing the automatic host navigation
	 * sources for its (synchronous) duration so the mutation isn't re-reported as a host navigation.
	 */
	withFragmentNavigation<T>(applyNavigation: () => T): T {
		fragmentNavigationInProgress = true;
		try {
			return applyNavigation();
		} finally {
			fragmentNavigationInProgress = false;
		}
	},

	/**
	 * Reports a host-initiated navigation (from an adapter or an automatic source).
	 *
	 * The first detection is delivered to fragments synchronously (fragments must observe the new
	 * location before the host performs any follow-up history operations — delayed delivery can
	 * cancel pending history traversals in some browsers). Further detections of the same navigation
	 * by other sources — e.g. the Navigation API firing synchronously during `pushState` plus the
	 * host router calling the `onHostNavigation` notify callback right after — are swallowed until
	 * the current microtask queue drains.
	 */
	hostNavigationDetected(): void {
		if (fragmentNavigationInProgress || suppressDuplicateDetections) return;
		suppressDuplicateDetections = true;
		queueMicrotask(() => {
			suppressDuplicateDetections = false;
		});
		hostNavigationSubscribers.forEach((subscriber) => subscriber());
	},
};

let hostNavigationSourcesInstalled = false;

/** Installs the host navigation sources (idempotent). Neither source mutates any host global. */
export function ensureHostNavigationSources(): void {
	if (hostNavigationSourcesInstalled) return;
	hostNavigationSourcesInstalled = true;

	const { onHostNavigation } = getWebFragmentsConfig();
	onHostNavigation?.(() => navigationBus.hostNavigationDetected());

	const navigation = (window as any).navigation;
	if (navigation?.addEventListener) {
		navigation.addEventListener('currententrychange', (event: any) => {
			if (event?.navigationType === 'traverse') return;
			navigationBus.hostNavigationDetected();
		});
	}
}
