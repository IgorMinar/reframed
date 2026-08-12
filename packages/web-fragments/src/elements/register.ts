import { WebFragment } from './web-fragment';
import { WebFragmentHost } from './web-fragment-host';
import { WebFragmentsOptions, setWebFragmentsConfig } from './config';

/**
 * Register the web fragment elements and configure the library.
 *
 * Safe to call more than once: subsequent calls update the configuration without attempting to
 * re-register the custom elements.
 *
 * @param options library configuration, see {@link WebFragmentsOptions}
 */
export function initializeWebFragments(options?: WebFragmentsOptions) {
	setWebFragmentsConfig(options);

	if (!window.customElements.get('web-fragment')) {
		window.customElements.define('web-fragment', WebFragment);
		window.customElements.define('web-fragment-host', WebFragmentHost);
	}
}
