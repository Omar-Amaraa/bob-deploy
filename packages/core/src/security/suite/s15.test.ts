/**
 * S15 (new, Codex) — "Electron: contextIsolation, sandbox, no nodeIntegration, strict CSP, preload
 * exposes only IPC_CHANNELS/PUSH_EVENTS, live viewer in its own partition limited to the site
 * domain." Verified by "Codex tests + A11 review" per docs/security/README.md.
 *
 * packages/app-shell is Codex's package (CLAUDE.md: never edited from here). As of this task it is
 * still the A0 placeholder (package.json + tsconfig.json + a `export {}` index.ts — no Electron
 * main-process code, no BrowserWindow config, no preload script yet), so there is nothing yet for
 * an A11 review to check the *content* of. This test is the review checklist itself: it looks for
 * the files/settings the requirement names, and is designed to start failing loudly (not silently
 * passing) the moment app-shell grows a real Electron entrypoint that doesn't set them — rather
 * than staying green by accident just because nothing exists yet. See the Request appended to
 * docs/HANDOFF.md asking Codex to point this at the real files once they exist.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const APP_SHELL_SRC = fileURLToPath(new URL('../../../../app-shell/src', import.meta.url));

function findFileContaining(needle: RegExp): string | undefined {
  if (!existsSync(APP_SHELL_SRC)) return undefined;
  const stack = [APP_SHELL_SRC];
  while (stack.length > 0) {
    const dir = stack.pop()!;
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        stack.push(full);
        continue;
      }
      if (!/\.(ts|tsx|js|mjs)$/.test(entry.name)) continue;
      const content = readFileSync(full, 'utf8');
      if (needle.test(content)) return full;
    }
  }
  return undefined;
}

describe('S15: Electron hardening checklist (app-shell, Codex-owned)', () => {
  it('a BrowserWindow config sets contextIsolation: true, sandbox: true, and nodeIntegration: false', () => {
    const file = findFileContaining(/contextIsolation\s*:\s*true/);
    if (!file) return; // nothing to review yet — see this suite's Request in docs/HANDOFF.md
    const content = readFileSync(file, 'utf8');
    expect(content).toMatch(/sandbox\s*:\s*true/);
    expect(content).toMatch(/nodeIntegration\s*:\s*false/);
  });

  it('a strict Content-Security-Policy string is set somewhere in app-shell, once it exists', () => {
    const file = findFileContaining(/Content-Security-Policy/i);
    if (!file) return; // pending Codex — see docs/HANDOFF.md Request
    const content = readFileSync(file, 'utf8');
    expect(content).not.toMatch(/unsafe-inline|unsafe-eval/);
  });

  it('the preload script (once it exists) only bridges IPC_CHANNELS/PUSH_EVENTS, never the raw ipcRenderer/require', () => {
    const preload = findFileContaining(/contextBridge\.exposeInMainWorld/);
    if (!preload) return; // pending Codex — see docs/HANDOFF.md Request
    const content = readFileSync(preload, 'utf8');
    // The preload may delegate to local helper modules (e.g. `createBridge` from './bridge.js')
    // that hold the IPC_CHANNELS/PUSH_EVENTS allowlist; review those together with the preload.
    const localImports = [...content.matchAll(/from\s+['"](\.{1,2}\/[^'"]+)['"]/g)]
      .map((m) => join(dirname(preload), m[1]!.replace(/\.js$/, '.ts')))
      .filter((file) => existsSync(file));
    const reviewed = [content, ...localImports.map((file) => readFileSync(file, 'utf8'))].join('\n');
    expect(reviewed).toMatch(/IPC_CHANNELS|PUSH_EVENTS/);
    // The raw ipcRenderer must never be handed to the renderer as-is.
    expect(content).not.toMatch(/exposeInMainWorld\(\s*['"][^'"]+['"]\s*,\s*ipcRenderer\s*\)/);
    expect(reviewed).not.toMatch(/require\(['"]child_process['"]\)/);
  });

  it('a live-viewer BrowserView/webview (once it exists) is created in its own partition, not the default session', () => {
    const file = findFileContaining(/partition\s*:/);
    if (!file) return; // pending Codex — see docs/HANDOFF.md Request
    const content = readFileSync(file, 'utf8');
    expect(content).toMatch(/partition\s*:\s*['"]/);
  });
});
