---
title: 'Elements'
layout: '~/layouts/MarkdownLayout.astro'
updateDate: 2025-03-17
---

Web Fragments uses `custom elements` as an implementation detail to embed applications in an existing user-interface. By using custom elements keep the implementation lightweight and benefit from using `shadowRoot` for style encapsulation.

Additionally, all scripts of the fragment application execute in an isolated JavaScript context.

## Custom elements registration

Before using the Web Fragments on the client-side of an application, the library needs to be initialized via exported `initializeWebFragments()` function:

```javascript
import { initializeWebFragments } from 'web-fragments';

initializeWebFragments();
```

This initialization should occur as early as possible during the bootstrap of a the existing application.

Please notice that different frameworks may require additional utilities to work with `custom elements`. For example `Angular` needs `CUSTOM_ELEMENTS_SCHEMA` to be provided.

### Host isolation mode

By default (`hostIsolation: 'legacy'`), the library monkey-patches a few of the host page's DOM prototypes and its History API to virtualize DOM and navigation operations for fragments.

The opt-in strict mode confines all interception to the fragment boundary instead — no main-context global or prototype is ever modified, so the host application, analytics, and third-party scripts all run on pristine prototypes:

```javascript
import { initializeWebFragments } from 'web-fragments';

initializeWebFragments({
	hostIsolation: 'strict',
	// optional: lets bound fragments react to navigations performed by the host app's router.
	// Where the Navigation API is available, host navigations are also detected automatically,
	// and back/forward navigations are always detected natively.
	onHostNavigation: (notify) => myRouter.afterEach(() => notify()),
});
```

In strict mode:

- nodes inside a fragment's DOM are virtualized via per-fragment prototypes, so DOM interception is scoped to fragments and host-page DOM operations run at native speed;
- scripts created by fragment code are inert from birth and can only ever execute in the fragment's JavaScript context;
- host navigations are observed via the `onHostNavigation` adapter and/or the Navigation API instead of History API patches.

Strict mode is expected to become the default in a future release.

## The `<web-fragment>` element

`<web-fragment>` is a custom element responsible for marking the location in the existing application where a Web Fragment should be nested.

`<web-fragment>` have a `fragment-id` attribute to uniquely identify the fragment.

```html
<web-fragment fragment-id="some-id"></web-fragment>
```

By default, `<web-fragment>` will create a bound fragment, which shares (binds) `window.location` and navigation history with the existing application that contains the fragment.
The `window.location` in a bound fragment is initialized to the current `window.location` of the top level application.
Navigation initialized from the existing application or a web fragment will be reflected in both contexts.

Optionally, a fragment can be created with the `src` attribute, which specifies the url from which the fragment should be initialized.
This will cause a creation of an "unbound" fragments, which has its own `window.location` and history, both of which are independent of that of the rest of the application or other fragments.

Both bound and unbound fragments run in a dedicated JavaScript context through [reframing](/documentation/reframing) — a virtualization technique unique to Web Fragments.

## Server-side piercing

Server-side piercing refers to he process through which the legacy app shell is combined with the server-side rendered HTML stream of a fragment.

It allows the eager display and initialization of a fragment at the moment of bootstrapping the shell application.

[piercing-styles](/documentation/glossary#piercing-eager-rendering) configured during fragment registration, help positioning the fragment in the correct slot.

![web fragments middleware](../../assets/images/wf-middleware.drawio.png)

## Routing of fragment's requests

All requests initiated from DOM or JavaScript of a fragment are intercepted by the fragment gateway middleware.
This middleware sits in front of the legacy application, identifies requests originating from the fragment via the `routePattern` in the fragment registration configuration, and reroutes all assets requests to the right fragment endpoint.

Learn more about middleware in the [gateway](/documentation/gateway) section.

---

#### Authors

<ul class="authors">
    <li class="author"><a href="https://github.com/anfibiacreativa">anfibiacreativa</a></li>
    <li class="author"><a href="https://github.com/igorminar">IgorMinar</a></li>
</ul>
