import { readdir } from 'node:fs/promises';
import { join } from 'node:path';
import type { HttpProbe } from '@bob-deploy/ssh-playbooks';

/** How many built files are probed after a free-hosting deploy. Enough to catch a host that
 * silently dropped a whole folder, small enough to keep the deploy fast. */
export const MAX_ASSET_PROBES = 5;
const PROBE_TIMEOUT_MS = 10_000;

/** Never walked: tooling folders that are not part of the published site. */
const SKIPPED_DIRS = new Set(['node_modules', '.git']);
/** Host config files: consumed by Netlify/Vercel, never served as-is. */
const SKIPPED_FILES = new Set(['_redirects', '_headers', 'netlify.toml', 'vercel.json']);

function priority(path: string): number {
  if (/\.(m?js|css)$/i.test(path)) return 0; // what a blank page is missing
  if (/\.(png|jpe?g|gif|svg|webp|avif|ico|woff2?)$/i.test(path)) return 1;
  return 2;
}

/**
 * Picks up to `max` files from the build output that live in a SUBFOLDER (POSIX paths relative to
 * `outputDir`), scripts and styles first. Root files are skipped on purpose: the home-page probe
 * already covers them, and the failure this guards against is a host keeping only the root files
 * (e.g. a zip built with Windows `assets\\app.js` entry names).
 */
export async function pickPublishedSamples(outputDir: string, max = MAX_ASSET_PROBES): Promise<string[]> {
  const found: string[] = [];
  async function walk(dir: string, rel: string): Promise<void> {
    const entries = await readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.name.startsWith('.')) continue;
      const relPath = rel ? `${rel}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        if (!SKIPPED_DIRS.has(entry.name)) await walk(join(dir, entry.name), relPath);
      } else if (entry.isFile() && rel && !SKIPPED_FILES.has(entry.name)) {
        found.push(relPath);
      }
    }
  }
  await walk(outputDir, '');
  return found
    .sort((a, b) => priority(a) - priority(b) || a.localeCompare(b))
    .slice(0, max);
}

export interface UploadVerification {
  checked: string[];
  missing: string[];
}

/** Probes each sampled build file at the live site URL and reports the ones the host doesn't serve. */
export async function verifyPublishedFiles(
  siteUrl: string,
  outputDir: string,
  probe: HttpProbe,
  max = MAX_ASSET_PROBES,
): Promise<UploadVerification> {
  const checked = await pickPublishedSamples(outputDir, max);
  const base = siteUrl.endsWith('/') ? siteUrl : `${siteUrl}/`;
  const results = await Promise.all(
    checked.map(async (path) => {
      const url = new URL(path.split('/').map(encodeURIComponent).join('/'), base).toString();
      return { path, ok: (await probe.probe(url, PROBE_TIMEOUT_MS)).ok };
    }),
  );
  return { checked, missing: results.filter((r) => !r.ok).map((r) => r.path) };
}
