import { describe, expect, it, afterEach } from 'vitest';
import { getWebFragmentsConfig, setWebFragmentsConfig } from './config';

afterEach(() => {
	setWebFragmentsConfig({ hostIsolation: 'legacy' });
});

describe('web fragments config', () => {
	it('should default to legacy host isolation', () => {
		expect(getWebFragmentsConfig().hostIsolation).toBe('legacy');
	});

	it('should apply provided options and keep existing values for omitted ones', () => {
		const onHostNavigation = () => {};
		setWebFragmentsConfig({ hostIsolation: 'strict', onHostNavigation });
		expect(getWebFragmentsConfig().hostIsolation).toBe('strict');
		expect(getWebFragmentsConfig().onHostNavigation).toBe(onHostNavigation);

		// a subsequent call without options must not reset previously configured values
		setWebFragmentsConfig();
		expect(getWebFragmentsConfig().hostIsolation).toBe('strict');
		expect(getWebFragmentsConfig().onHostNavigation).toBe(onHostNavigation);
	});
});
