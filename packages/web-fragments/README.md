<!-- prettier-ignore -->
<div align="center">

<img src="./docs/src/assets/favicons/favicon.svg" alt="web-fragments-logo" align="center" height="64" />

# Web Fragments: A radically new architecture to build micro-frontends

[![Official documentation](https://img.shields.io/badge/Official%20Docs-8A2BE2?style=flat-square)](https://web-fragments.dev/)
[![Our blog](https://img.shields.io/badge/Blog%20post-F28021?style=flat-square&logo=cloudflare&logoColor=white)](https://blog.cloudflare.com/better-micro-frontends)
[![New to micro-frontends?](https://img.shields.io/badge/Microfrontend.dev-2F80ED?style=flat-square)](https://microfrontend.dev)
[![Build Status](https://img.shields.io/github/actions/workflow/status/web-fragments/web-fragments/release.yml?style=flat-square&label=Release%20Status)](https://github.com/web-fragments/web-fragments/actions)
![Node version](https://img.shields.io/badge/Node.js->=20-3c873a?style=flat-square)
[![TypeScript](https://img.shields.io/badge/TypeScript-blue?style=flat-square&logo=typescript&logoColor=white)](https://www.typescriptlang.org)
[![License](https://img.shields.io/badge/License-MIT-white?style=flat-square)](LICENSE)

[Overview](#overview) | [The Goal](#the-goal) | [Getting started](#getting-started) | [More Resources](#more-resources)

</div>

## Overview

Web Fragments are a radically new approach to Web micro-frontends which is framework, tooling, and platform agnostic.

New to micro-frontends? Check out https://microfrontend.dev

> [!NOTE] The project is in beta, but is already being used in production by teams at [Cloudflare](https://www.cloudflare.com/).
> We are looking for teams and companies interested in providing early feedback that can help us shape the feature set and APIs.

## The goal

The main goal of Web Fragments is to enable teams operating enterprise web frontends so they can:

1. Modernize and re-platform their apps using an incremental migration approach that is low risk and allows product owners to prioritize the most valuable parts of the frontend.
2. Scale large web frontends via decentralization and decomposition of monolithic web frontends into independently developed and released micro-frontends, that still form a cohesive user experience.

## What's radically different about Web Fragments?

Unlike other micro-frontend technologies, Web Fragments focuses on isolating individual micro-frontends from each other by executing their client-side JavaScript in separate JavaScript context, while enabling them to share the same DOM document, browser navigation and history.

Just like Docker enables containerization of applications, Web Fragments enable containerization of web frontends on the client-side, and by extension also on the server-side.

This JavaScript execution context isolation and low-overhead virtualization enables large monolithic web frontends to be broken up into smaller, independently developed and released web applications, that in production are composed into a single cohesive UI.
In this way Web Fragments enable scaling and incremental modernization of the frontend tech stack.

## Getting started

The best way to learn more is going to [our official documentation](https://web-fragments.dev/documentation/getting-started/).

You can also check out the [demos present in this repository](./e2e/) where you can find examples [e2e/pierced-react/README.md](./e2e/pierced-react/README.md) for platforms supporting [Web Fetch API](https://developer.mozilla.org/docs/Web/API/Fetch_API) like Cloudflare or Netlify, or [e2e/node-servers/README.md](./e2e/node-servers/README.md) for platforms supporting Node.js runtimes.

## Claude Code skills

If you use [Claude Code](https://claude.ai/code), installing this package automatically links a set of slash commands into your project's `.claude/commands/web-fragments/` directory via a postinstall script.

| Command                               | What it does                                                                                                    |
| ------------------------------------- | --------------------------------------------------------------------------------------------------------------- |
| `/web-fragments:init-fragment`        | Scaffolds gateway registration, app shell placeholder, and fragment HTML for a new fragment                     |
| `/web-fragments:gateway-config`       | Reviews or generates your `FragmentGateway` configuration and flags deprecated fields or missing error handlers |
| `/web-fragments:debug-fragment`       | Systematic diagnostic for invisible fragments, broken piercing, FOUC, and CSP/iframe blocks                     |
| `/web-fragments:fragment-test`        | Generates a Playwright test scenario (`index.html` + `fragment.html` + `spec.ts`)                               |
| `/web-fragments:migrate-to-fragments` | Analyzes an existing app and produces a phased extraction plan                                                  |
| `/web-fragments:fragment-csp`         | Generates and audits Content Security Policy headers for the iframe-based isolation model                       |
| `/web-fragments:fragment-perf`        | Audits your setup for piercing, streaming, caching, and route pattern issues                                    |

The commands are discovered automatically — no manual setup required beyond having Claude Code installed.

## More resources

We blogged about the philosophy of our approach and published some early research on the Cloudflare blog. You can check out a post introducing the previous generation of Web Fragments: https://blog.cloudflare.com/better-micro-frontends.

We also blogged about how Web Fragments can enable incremental adoption of micro-frontends: https://blog.cloudflare.com/fragment-piercing

> Incremental adoption of micro-frontends with Cloudflare Workers
>
> Large frontend applications are often hard to improve without major investments. With Cloudflare Workers, our fragment-based micro-frontend architecture, and fragment piercing technique, engineering teams can incrementally improve large frontends in a fraction of the time, yielding significant user and developer experience gains.

This research and development is sponsored by Cloudflare:

<img src="https://github.com/user-attachments/assets/daee5d2d-174d-4679-80d5-29cc3b38a903" data-canonical-src="https://github.com/user-attachments/assets/daee5d2d-174d-4679-80d5-29cc3b38a903" width="300" />
