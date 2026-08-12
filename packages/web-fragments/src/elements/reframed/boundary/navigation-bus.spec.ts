import { describe, expect, it, vi, afterEach } from 'vitest';
import { navigationBus } from './navigation-bus';
import { setWebFragmentsConfig } from '../../config';

const microtask = () => Promise.resolve();

afterEach(() => {
	setWebFragmentsConfig({ hostIsolation: 'legacy' });
});

describe('navigationBus', () => {
	it('should notify subscribers of host navigations synchronously and support unsubscribing', async () => {
		const subscriber = vi.fn();
		const unsubscribe = navigationBus.subscribe(subscriber);

		navigationBus.hostNavigationDetected();
		expect(subscriber).toHaveBeenCalledTimes(1);

		unsubscribe();
		await microtask();
		navigationBus.hostNavigationDetected();
		expect(subscriber).toHaveBeenCalledTimes(1);
	});

	it('should deliver a navigation detected by multiple sources exactly once', async () => {
		const subscriber = vi.fn();
		const unsubscribe = navigationBus.subscribe(subscriber);

		// e.g. the Navigation API and the onHostNavigation adapter both reporting the same pushState:
		// the first detection is delivered synchronously, duplicates are swallowed
		navigationBus.hostNavigationDetected();
		navigationBus.hostNavigationDetected();
		expect(subscriber).toHaveBeenCalledTimes(1);

		// a later navigation is delivered again
		await microtask();
		navigationBus.hostNavigationDetected();
		expect(subscriber).toHaveBeenCalledTimes(2);

		unsubscribe();
	});

	it('should suppress host navigation detection while a fragment navigation is being applied', async () => {
		const subscriber = vi.fn();
		const unsubscribe = navigationBus.subscribe(subscriber);

		const result = navigationBus.withFragmentNavigation(() => {
			// a Navigation API currententrychange event fired synchronously by the history mutation
			// must not be reported as a host navigation
			navigationBus.hostNavigationDetected();
			return 'applied';
		});

		expect(result).toBe('applied');
		expect(subscriber).not.toHaveBeenCalled();

		// detection resumes after the fragment navigation completes
		navigationBus.hostNavigationDetected();
		expect(subscriber).toHaveBeenCalledTimes(1);

		unsubscribe();
	});

	it('should clear the suppression flag even when the navigation throws', () => {
		const subscriber = vi.fn();
		const unsubscribe = navigationBus.subscribe(subscriber);

		expect(() =>
			navigationBus.withFragmentNavigation(() => {
				throw new Error('boom');
			}),
		).toThrow('boom');

		navigationBus.hostNavigationDetected();
		expect(subscriber).toHaveBeenCalledTimes(1);

		unsubscribe();
	});
});
