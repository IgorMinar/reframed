/**
 * Born-inert scripts.
 *
 * In strict host-isolation mode, every script element created by fragment code (via the document
 * facade's `createElement`/`createElementNS`) is neutralized at creation: its `type` attribute is set
 * to `inert` before fragment code can attach content or insert it. This guarantees that no script
 * reachable by fragment code can ever execute in the main JS context, no matter how it is inserted —
 * even through code paths the boundary does not intercept synchronously (see
 * rfcs/host-page-isolation.md).
 *
 * So that fragment code doesn't observe the neutralization, the script's `type` property and its
 * `getAttribute`/`setAttribute` methods are shadowed to read and write the real type from/to the
 * `data-script-type` attribute (the same attribute the gateway uses when neutralizing SSR content).
 * The shadowing own-properties are removed before the script is activated.
 */

const nativeSetAttribute = Element.prototype.setAttribute;
const nativeGetAttribute = Element.prototype.getAttribute;
const nativeRemoveAttribute = Element.prototype.removeAttribute;

const bornInertScripts = new WeakSet<HTMLScriptElement>();

export function makeScriptBornInert(script: HTMLScriptElement): void {
	nativeSetAttribute.call(script, 'type', 'inert');
	bornInertScripts.add(script);

	Object.defineProperties(script, {
		type: {
			configurable: true,
			enumerable: true,
			get() {
				return nativeGetAttribute.call(this, 'data-script-type') ?? '';
			},
			set(value: string) {
				nativeSetAttribute.call(this, 'data-script-type', String(value));
			},
		},
		setAttribute: {
			configurable: true,
			writable: true,
			value: function setAttribute(name: string, value: string) {
				return nativeSetAttribute.call(this, String(name).toLowerCase() === 'type' ? 'data-script-type' : name, value);
			},
		},
		getAttribute: {
			configurable: true,
			writable: true,
			value: function getAttribute(name: string) {
				return nativeGetAttribute.call(this, String(name).toLowerCase() === 'type' ? 'data-script-type' : name);
			},
		},
	});
}

export function isBornInertScript(script: HTMLScriptElement): boolean {
	return bornInertScripts.has(script);
}

/**
 * Removes the type-shadowing own-properties, leaving the script in the standard inert form
 * (`type="inert"` plus the real type in `data-script-type`) that the script execution machinery
 * understands. Used on the asynchronous (boundary observer) activation path, where the script is
 * already attached to the fragment's DOM in inert form.
 */
export function removeBornInertShadowing(script: HTMLScriptElement): void {
	if (!bornInertScripts.has(script)) return;
	delete (script as any).type;
	delete (script as any).setAttribute;
	delete (script as any).getAttribute;
	bornInertScripts.delete(script);
}

/**
 * Fully reverts a born-inert script to the live form the application intended (real `type`
 * attribute, no `data-script-type`). Used on the synchronous (stamped insertion) activation path,
 * which re-neutralizes the script itself before performing the actual DOM insertion — the script is
 * never attached to the DOM in live form.
 */
export function unwrapBornInertScriptToLive(script: HTMLScriptElement): void {
	if (!bornInertScripts.has(script)) return;
	removeBornInertShadowing(script);
	const realType = nativeGetAttribute.call(script, 'data-script-type');
	nativeRemoveAttribute.call(script, 'data-script-type');
	if (realType) {
		nativeSetAttribute.call(script, 'type', realType);
	} else {
		nativeRemoveAttribute.call(script, 'type');
	}
}
