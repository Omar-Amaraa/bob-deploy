import { readdir, readFile, stat } from 'node:fs/promises';
import { join, relative } from 'node:path';
import JSZip from 'jszip';
import type { HostDeployEvent, HostDeployInput, HostProvider, StackInfo } from '@bob-deploy/contracts';
import { HostApiError, requestJson } from './http.js';

// Verified against Netlify's API getting-started guide
// (https://docs.netlify.com/api-and-cli-guides/api-guides/get-started-with-api/) and the OpenAPI
// reference (https://open-api.netlify.com/) on 25 September 2026 — see packages/providers/README.md.

const POLL_INTERVAL_MS = 2_000;
const POLL_TIMEOUT_MS = 10 * 60 * 1_000;

interface NetlifyUser {
  full_name?: string;
  email?: string;
}
interface NetlifySite {
  id: string;
  name: string;
  url?: string;
  ssl_url?: string;
}
interface NetlifyDeploy {
  id: string;
  site_id: string;
  /** Known values: 'uploading' | 'processing' | 'ready' | 'error' — kept open since Netlify adds states. */
  state: string;
  url?: string;
  ssl_url?: string;
  deploy_ssl_url?: string;
  error_message?: string;
}

function authHeaders(token: string): Record<string, string> {
  return { Authorization: `Bearer ${token}` };
}

function parseNetlifyErrorMessage(body: unknown): string | undefined {
  if (body && typeof body === 'object' && 'message' in body && typeof body.message === 'string') {
    return body.message;
  }
  return undefined;
}

async function zipDirectory(outputDir: string): Promise<Uint8Array> {
  const zip = new JSZip();
  async function addDir(dir: string): Promise<void> {
    const entries = await readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = join(dir, entry.name);
      if (entry.isDirectory()) {
        await addDir(fullPath);
        continue;
      }
      const content = await readFile(fullPath);
      // ZIP entry names always use POSIX separators. Passing Windows paths such as
      // `assets\\app.js` makes Netlify publish only the root files and silently lose
      // nested build assets.
      zip.file(relative(outputDir, fullPath).replaceAll('\\', '/'), content);
    }
  }
  await addDir(outputDir);
  const buffer = await zip.generateAsync({ type: 'uint8array', compression: 'DEFLATE' });
  return buffer;
}

async function outputDirExists(outputDir: string | undefined): Promise<boolean> {
  if (!outputDir) return false;
  try {
    return (await stat(outputDir)).isDirectory();
  } catch {
    return false;
  }
}

export interface NetlifyProviderOptions {
  /** Injectable for tests, per the brief ("HTTP via undici with a base URL injectable for
   * tests"). Defaults to the real Netlify API. */
  baseUrl?: string;
}

export function netlifyProvider(options: NetlifyProviderOptions = {}): HostProvider {
  const baseUrl = options.baseUrl ?? 'https://api.netlify.com';

  async function createSite(token: string, siteName: string): Promise<NetlifySite> {
    try {
      return await requestJson<NetlifySite>(`${baseUrl}/api/v1/sites`, {
        method: 'POST',
        headers: { ...authHeaders(token), 'content-type': 'application/json' },
        body: JSON.stringify({ name: siteName }),
        parseErrorMessage: parseNetlifyErrorMessage,
      });
    } catch (error) {
      // Netlify reports a taken site name as a 422 (with a message mentioning the name); retry
      // once with a short random suffix, per the brief ("on name conflict append a short random
      // suffix and report it").
      if (error instanceof HostApiError && error.status === 422) {
        const suffix = Math.random().toString(36).slice(2, 6);
        const suffixedName = `${siteName}-${suffix}`;
        const site = await requestJson<NetlifySite>(`${baseUrl}/api/v1/sites`, {
          method: 'POST',
          headers: { ...authHeaders(token), 'content-type': 'application/json' },
          body: JSON.stringify({ name: suffixedName }),
          parseErrorMessage: parseNetlifyErrorMessage,
        });
        return site;
      }
      throw error;
    }
  }

  async function pollDeploy(token: string, deployId: string, signal?: AbortSignal): Promise<NetlifyDeploy> {
    const deadline = Date.now() + POLL_TIMEOUT_MS;
    for (;;) {
      const deploy = await requestJson<NetlifyDeploy>(`${baseUrl}/api/v1/deploys/${deployId}`, {
        headers: authHeaders(token),
        signal,
        parseErrorMessage: parseNetlifyErrorMessage,
      });
      if (deploy.state === 'ready' || deploy.state === 'error') return deploy;
      if (Date.now() > deadline) {
        throw new HostApiError('HOST_API_ERROR', 'Netlify deploy did not finish within 10 minutes.');
      }
      await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
      if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');
    }
  }

  return {
    id: 'netlify',
    displayName: 'Netlify',
    tokenPageUrl: 'https://app.netlify.com/user/applications#personal-access-tokens',

    supports(stack: StackInfo): { ok: boolean; reason?: string } {
      if (stack.type === 'static' || (!stack.needsBackend && stack.outputDir)) return { ok: true };
      return { ok: false, reason: 'Netlify in Bob Deploy supports static sites only for now.' };
    },

    async validateToken(token: string): Promise<{ ok: boolean; accountName?: string; message?: string }> {
      try {
        const user = await requestJson<NetlifyUser>(`${baseUrl}/api/v1/user`, {
          headers: authHeaders(token),
          parseErrorMessage: parseNetlifyErrorMessage,
        });
        return { ok: true, accountName: user.full_name ?? user.email };
      } catch (error) {
        if (error instanceof HostApiError) return { ok: false, message: error.message };
        throw error;
      }
    },

    async *deploy(input: HostDeployInput, signal?: AbortSignal): AsyncIterable<HostDeployEvent> {
      const { token, siteName, siteId: existingSiteId, outputDir } = input;
      try {
        yield { phase: 'preparing', message: 'Preparing your site on Netlify…' };

        let site: { id: string };
        if (existingSiteId) {
          site = { id: existingSiteId };
        } else {
          site = await createSite(token, siteName);
        }

        if (!(await outputDirExists(outputDir))) {
          yield { phase: 'error', message: 'No build output found to deploy.', siteId: site.id };
          return;
        }

        yield { phase: 'uploading', message: 'Uploading your files to Netlify…', siteId: site.id };
        const zipBytes = await zipDirectory(outputDir as string);
        const created = await requestJson<NetlifyDeploy>(`${baseUrl}/api/v1/sites/${site.id}/deploys`, {
          method: 'POST',
          headers: { ...authHeaders(token), 'content-type': 'application/zip' },
          body: zipBytes,
          signal,
          parseErrorMessage: parseNetlifyErrorMessage,
        });

        yield { phase: 'building', message: 'Netlify is building your site…', siteId: site.id, deployId: created.id };
        const finished = await pollDeploy(token, created.id, signal);

        if (finished.state === 'error') {
          yield {
            phase: 'error',
            message: finished.error_message ?? 'Netlify reported a deploy error.',
            siteId: site.id,
            deployId: finished.id,
          };
          return;
        }

        const url = finished.ssl_url ?? finished.url;
        yield {
          phase: 'ready',
          message: 'Your site is live on Netlify.',
          url,
          siteId: finished.site_id,
          deployId: finished.id,
        };
      } catch (error) {
        if (signal?.aborted) return;
        const message = error instanceof HostApiError ? error.message : 'Netlify deploy failed unexpectedly.';
        yield { phase: 'error', message };
      }
    },
  };
}
