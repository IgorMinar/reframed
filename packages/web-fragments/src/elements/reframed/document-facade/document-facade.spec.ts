import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { documentSurface } from './document-surface.generated';
import { documentMemberClassification } from './document-member-classification';
import { installDocumentFacade } from './document-facade';
import { createDocumentOverrides, DocumentOverridesContext } from './document-overrides';

function createStubContext(): DocumentOverridesContext {
	return {
		iframeDocument: {} as Document,
		mainDocument: {} as Document,
		wfDocumentElement: {} as HTMLElement,
		reframedShadowRoot: {} as ShadowRoot,
		boundNavigation: false,
		getIframeDocumentReadyState: () => 'complete',
		getCurrentScript: () => undefined,
	};
}

describe('document member classification', () => {
	it('should only classify members that exist in the spec-defined Document surface', () => {
		const unknownMembers = Object.keys(documentMemberClassification).filter((member) => !(member in documentSurface));

		expect(
			unknownMembers,
			`all classified members must be spec-defined Document members (did a member get renamed or removed ` +
				`from the browser specs? try re-running \`pnpm generate:document-surface\`)`,
		).toEqual([]);
	});

	it('should classify exactly the members implemented by the document overrides as virtualized', () => {
		const classifiedVirtualized = Object.keys(documentMemberClassification)
			.filter((member) => documentMemberClassification[member] === 'virtualized')
			.sort();

		const implementedOverrides = Object.keys(createDocumentOverrides(createStubContext())).sort();

		expect(implementedOverrides).toEqual(classifiedVirtualized);
	});
});

describe('installDocumentFacade', () => {
	let warnSpy: ReturnType<typeof vi.spyOn>;

	beforeEach(() => {
		warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
	});

	afterEach(() => {
		warnSpy.mockRestore();
	});

	function createDocumentWithFacade() {
		const nativePrototype = {
			get title() {
				return 'native title';
			},
			// `write` is a spec-defined Document member that is intentionally not classified
			write() {
				return 'native write';
			},
			// `cookie` is classified as 'native'
			cookie: 'native cookie',
			// `appendChild` is inherited from Node and must pass through silently
			appendChild() {
				return 'native appendChild';
			},
		};

		const doc: any = Object.create(nativePrototype);

		let assignedTitle: string | undefined;
		const uninstall = installDocumentFacade(doc as Document, {
			title: {
				get: () => 'virtual title',
				set: (newTitle: string) => {
					assignedTitle = newTitle;
				},
			},
			querySelector: { value: () => 'virtual querySelector' },
		});

		return { doc, uninstall, getAssignedTitle: () => assignedTitle };
	}

	it('should redirect virtualized members to their overrides', () => {
		const { doc, getAssignedTitle } = createDocumentWithFacade();

		expect(doc.title).toBe('virtual title');
		expect(doc.querySelector()).toBe('virtual querySelector');

		doc.title = 'new title';
		expect(getAssignedTitle()).toBe('new title');
		expect(warnSpy).not.toHaveBeenCalled();
	});

	it('should fail assignments to read-only virtualized members like assignments to non-writable properties', () => {
		const { doc } = createDocumentWithFacade();

		expect(() => {
			'use strict';
			doc.querySelector = () => 'hijacked';
		}).toThrow(TypeError);
		expect(doc.querySelector()).toBe('virtual querySelector');
	});

	it('should pass through unaudited spec-defined members and log a one-time dev diagnostic', () => {
		const { doc } = createDocumentWithFacade();

		expect(doc.write()).toBe('native write');
		expect(doc.write()).toBe('native write');

		expect(warnSpy).toHaveBeenCalledTimes(1);
		expect(warnSpy.mock.calls[0][0]).toContain(`'document.write'`);
	});

	it('should pass through members classified as native without a diagnostic', () => {
		const { doc } = createDocumentWithFacade();

		expect(doc.cookie).toBe('native cookie');
		expect(warnSpy).not.toHaveBeenCalled();
	});

	it('should pass through members inherited from Node and EventTarget without a diagnostic', () => {
		const { doc } = createDocumentWithFacade();

		expect(doc.appendChild()).toBe('native appendChild');
		expect(warnSpy).not.toHaveBeenCalled();
	});

	it('should pass through application-defined expando properties without a diagnostic', () => {
		const { doc } = createDocumentWithFacade();

		doc.myAppState = { answer: 42 };
		expect(doc.myAppState).toEqual({ answer: 42 });
		expect(doc.nonExistentProperty).toBeUndefined();
		expect(warnSpy).not.toHaveBeenCalled();
	});

	it('should warn about facade overrides that are not classified as virtualized', () => {
		const doc: any = Object.create({});
		installDocumentFacade(doc as Document, {
			write: { value: () => 'not classified as virtualized' },
		});

		expect(warnSpy).toHaveBeenCalledTimes(1);
		expect(warnSpy.mock.calls[0][0]).toContain(`'write'`);
	});

	it('should restore the original prototype chain when uninstalled', () => {
		const { doc, uninstall } = createDocumentWithFacade();

		expect(doc.title).toBe('virtual title');
		uninstall();
		expect(doc.title).toBe('native title');
	});
});
