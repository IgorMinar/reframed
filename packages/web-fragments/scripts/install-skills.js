#!/usr/bin/env node
/**
 * Postinstall script: symlinks .claude/commands/web-fragments into the
 * consuming project's root so Claude Code discovers the web-fragments skills.
 *
 * Supports npm, pnpm, and yarn via the INIT_CWD environment variable.
 */

import { symlinkSync, mkdirSync, existsSync, lstatSync, unlinkSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));

// INIT_CWD is set by npm and pnpm to the directory where install was run.
// Fall back to npm_config_local_prefix for older yarn versions.
const projectRoot = process.env.INIT_CWD ?? process.env.npm_config_local_prefix;

if (!projectRoot) {
	// Running outside of a package install (e.g. direct node call) — skip silently.
	process.exit(0);
}

// Resolve the source (skills inside this package) and the link target (in the consuming project).
const source = resolve(__dirname, '../.claude/commands');
const commandsDir = resolve(projectRoot, '.claude/commands');
const target = resolve(commandsDir, 'web-fragments');

// Skip if we are being installed inside our own repo (monorepo workspace install).
if (resolve(projectRoot) === resolve(__dirname, '..')) {
	process.exit(0);
}

try {
	mkdirSync(commandsDir, { recursive: true });

	// Remove a stale symlink or directory from a previous install.
	if (existsSync(target) || lstatSync(target).isSymbolicLink?.()) {
		unlinkSync(target);
	}

	symlinkSync(source, target, 'dir');
	console.log(`[web-fragments] Claude Code skills linked → ${target}`);
} catch (err) {
	// Non-fatal: symlink may fail in CI or restricted environments.
	console.warn(`[web-fragments] Could not link Claude Code skills: ${err.message}`);
}
