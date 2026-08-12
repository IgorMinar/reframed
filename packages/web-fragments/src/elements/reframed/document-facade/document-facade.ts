import { documentSurface } from './document-surface.generated';
import { documentMemberClassification } from './document-member-classification';

/**
 * A facade override for a single Document member, mirroring the shape of a property descriptor:
 * either an accessor (`get`, optionally with `set`) or a data member (`value`, typically a method).
 */
export type FacadeOverride =
	| { get: () => unknown; set?: (value: any) => void; value?: never }
	| { value: unknown; get?: never; set?: never };

export type FacadeOverrides = Record<string, FacadeOverride>;

/**
 * Members inherited by Document from these interfaces always pass through to the iframe document silently.
 * DOM tree traversal and event dispatch are virtualized at other layers (see `main-patches.ts` and the event
 * system patches in `iframe-patches.ts`).
 */
const inheritedInterfaces = new Set(['Node', 'EventTarget']);

let lazyUnauditedDocumentMembers: Set<string> | undefined;

/**
 * Returns whether the given member is a spec-defined Document member that has not been audited for reframed
 * contexts yet. Access to such members falls through to the iframe document and triggers a dev-mode diagnostic.
 *
 * The set is computed lazily and this function must only be called from dev-mode-only code paths — this keeps the
 * sizable generated WebIDL manifest tree-shakeable from production builds.
 */
function isUnauditedDocumentMember(name: string): boolean {
	lazyUnauditedDocumentMembers ??= new Set(
		Object.keys(documentSurface).filter(
			(member) => !(member in documentMemberClassification) && !inheritedInterfaces.has(documentSurface[member].from),
		),
	);
	return lazyUnauditedDocumentMembers.has(name);
}

/**
 * Installs a virtualizing facade over the given document by splicing a Proxy into its prototype chain.
 *
 * The proxy classifies every property access on the document:
 *
 * - members with an override (classified `'virtualized'`) are redirected to the override, which operates on the
 *   fragment's DOM in the main document,
 * - members classified `'native'` pass through to the iframe document's native behavior,
 * - spec-defined Document members that are not classified also pass through, but log a one-time dev-mode
 *   diagnostic so that unaudited API usage by fragments surfaces during development instead of silently
 *   misbehaving,
 * - anything else (application-defined expandos, symbols) passes through silently.
 *
 * Unlike patching individual properties, the proxy guarantees that *every* property access is observed, which
 * turns "we forgot to patch X" from a silent wrong-document bug into an actionable diagnostic.
 *
 * Only ES2015 features (Proxy, Reflect, Object.setPrototypeOf) are used, all of which are supported by all
 * evergreen browsers. Note that unlike `window` (whose prototype is immutable per the HTML spec), a Document
 * instance has an ordinary, mutable [[Prototype]] slot, so splicing is safe cross-browser. Own properties of the
 * document instance (e.g. the [LegacyUnforgeable] `location`) are unaffected by the facade.
 *
 * @param iframeDocument the fragment's iframe document to install the facade on
 * @param overrides the virtualized member implementations (see `createDocumentOverrides`)
 * @returns a function that uninstalls the facade and restores the original prototype chain
 */
export function installDocumentFacade(iframeDocument: Document, overrides: FacadeOverrides): () => void {
	const originalPrototype = Object.getPrototypeOf(iframeDocument);
	const overrideMap = new Map<string, FacadeOverride>(Object.entries(overrides));
	const warnedMembers = new Set<string>();

	if (import.meta.env.DEV) {
		for (const overriddenMember of overrideMap.keys()) {
			if (documentMemberClassification[overriddenMember] !== 'virtualized') {
				console.warn(
					`WebFragments: document facade override '${overriddenMember}' is not classified as 'virtualized' in document-member-classification.ts! Please classify it to keep the audit trail consistent.`,
				);
			}
		}
	}

	function warnIfUnaudited(propertyName: string) {
		if (isUnauditedDocumentMember(propertyName) && !warnedMembers.has(propertyName)) {
			warnedMembers.add(propertyName);
			console.warn(
				`WebFragments: a fragment accessed 'document.${propertyName}', which has not been audited for reframed fragment contexts yet and falls through to the fragment's hidden iframe document.\n` +
					`If the fragment misbehaves in a way related to this API, please report it at https://github.com/web-fragments/web-fragments/issues`,
			);
		}
	}

	const facadeProxy = new Proxy(originalPrototype, {
		get(target, property, receiver) {
			if (typeof property === 'string') {
				const override = overrideMap.get(property);
				if (override) {
					return override.get ? override.get() : override.value;
				}
				if (import.meta.env.DEV) {
					warnIfUnaudited(property);
				}
			}
			return Reflect.get(target, property, receiver);
		},

		set(target, property, value, receiver) {
			if (typeof property === 'string') {
				const override = overrideMap.get(property);
				if (override) {
					if (override.set) {
						override.set(value);
						return true;
					}
					// read-only virtualized member: fail the assignment just like an assignment to a
					// non-writable property would (throws in strict mode, silently ignored otherwise)
					return false;
				}
				if (import.meta.env.DEV) {
					warnIfUnaudited(property);
				}
			}
			return Reflect.set(target, property, value, receiver);
		},
	});

	Object.setPrototypeOf(iframeDocument, facadeProxy);

	return function uninstallDocumentFacade() {
		Object.setPrototypeOf(iframeDocument, originalPrototype);
	};
}
