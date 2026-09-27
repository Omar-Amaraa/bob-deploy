import { createHash } from 'node:crypto';
import { readdir, readFile, stat } from 'node:fs/promises';
import { join, relative } from 'node:path';
import type { HostDeployEvent, HostDeployInput, HostProvider, StackInfo } from '@bob-deploy/contracts';
import { HostApiError, requestJson, requestRaw } from './http.js';

// Verified against Vercel's REST API reference (https://vercel.com/docs/rest-api, including
// GET /v2/user, POST /v11/projects, POST /v2/files, POST /v13/deployments, and
// GET /v13/deployments/{idOrUrl}) and REST API errors reference
// (https://vercel.com/docs/rest-api/errors) on 25 September 2026 — see packages/providers/README.md.

const POLL_INTERVAL_MS = 2_000;
const POLL_TIMEOUT_MS = 10 * 60 * 1_000;

/** Frameworks Vercel builds that Bob Deploy is willing to hand a Node project to, per the brief. */
const SUPPORTED_FRAMEWORKS = new Set(['nextjs', 'vite', 'astro', 'sveltekit', 'nuxt', 'remix', 'create-react-app']);

const EXCLUDED_DIR_NAMES = new Set(['node_modules', '.git']);

interface VercelUser {
  user?: { username?: string; email?: string; name?: string };
}
interface VercelDeployment {
  id: string;
  url: string;
  /** Known values: 'QUEUED' | 'BUILDING' | 'READY' | 'ERROR' | 'CANCELED' — kept open since Vercel adds states. */
  readyState: string;
  alias?: string[];
  errorMessage?: string;
}

function authHeaders(token: string): Record<string, string> {
  return { Authorization: `Bearer ${token}` };
}

function withTeam(url: string, teamId?: string): string {
  if (!teamId) return url;
  return `${url}${url.includes('?') ? '&' : '?'}teamId=${encodeURIComponent(teamId)}`;
}

function parseVercelErrorMessage(body: unknown): string | undefined {
  if (
    body &&
    typeof body === 'object' &&
    'error' in body &&
    body.error &&
    typeof body.error === 'object' &&
    'message' in body.error &&
    typeof body.error.message === 'string'
  ) {
    return body.error.message;
  }
  return undefined;
}

interface FileEntry {
  absolutePath: string;
  relativePath: string;
  size: number;
  sha: string;
}

async function walk(dir: string, root: string, excludeDotEnv: boolean, out: string[]): Promise<void> {
  const entries = await readdir(dir, { withFileTypes: true });
  for (const entry of entries) {
    if (entry.isDirectory() && EXCLUDED_DIR_NAMES.has(entry.name)) continue;
    const fullPath = join(dir, entry.name);
    if (entry.isDirectory()) {
      await walk(fullPath, root, excludeDotEnv, out);
      continue;
    }
    if (excludeDotEnv && entry.name.startsWith('.env')) continue;
    out.push(fullPath);
  }
}

async function collectFiles(root: string, excludeDotEnv: boolean): Promise<FileEntry[]> {
  const paths: string[] = [];
  await walk(root, root, excludeDotEnv, paths);
  const entries: FileEntry[] = [];
  for (const absolutePath of paths) {
    const info = await stat(absolutePath);
    if (!info.isFile()) continue;
    const content = await readFile(absolutePath);
    const sha = createHash('sha1').update(content).digest('hex');
    entries.push({ absolutePath, relativePath: relative(root, absolutePath).split('\\').join('/'), size: info.size, sha });
  }
  return entries;
}

async function uploadFile(baseUrl: string, token: string, teamId: string | undefined, entry: FileEntry, signal?: AbortSignal): Promise<void> {
  const content = await readFile(entry.absolutePath);
  const response = await requestRaw(withTeam(`${baseUrl}/v2/files`, teamId), {
    method: 'POST',
    headers: {
      ...authHeaders(token),
      'content-length': String(entry.size),
      'x-vercel-digest': entry.sha,
    },
    body: content,
    signal,
  });
  // 200 = uploaded, 409 = Vercel already has this exact content (matched by digest) — both mean
  // the deployment-creation call below can reference this sha safely.
  if (!response.ok && response.status !== 409) {
    throw new HostApiError('HOST_API_ERROR', `Vercel rejected an upload of ${entry.relativePath}.`, response.status);
  }
}

export interface VercelProviderOptions {
  baseUrl?: string;
}

export function vercelProvider(options: VercelProviderOptions = {}): HostProvider {
  const baseUrl = options.baseUrl ?? 'https://api.vercel.com';

  async function pollDeployment(token: string, teamId: string | undefined, id: string, signal?: AbortSignal): Promise<VercelDeployment> {
    const deadline = Date.now() + POLL_TIMEOUT_MS;
    for (;;) {
      const deployment = await requestJson<VercelDeployment>(withTeam(`${baseUrl}/v13/deployments/${id}`, teamId), {
        headers: authHeaders(token),
        signal,
        parseErrorMessage: parseVercelErrorMessage,
      });
      if (deployment.readyState === 'READY' || deployment.readyState === 'ERROR' || deployment.readyState === 'CANCELED') {
        return deployment;
      }
      if (Date.now() > deadline) {
        throw new HostApiError('HOST_API_ERROR', 'Vercel deployment did not finish within 10 minutes.');
      }
      await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
      if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');
    }
  }

  return {
    id: 'vercel',
    displayName: 'Vercel',
    tokenPageUrl: 'https://vercel.com/account/tokens',

    supports(stack: StackInfo): { ok: boolean; reason?: string } {
      if (stack.type === 'static' && stack.outputDir) return { ok: true };
      if (stack.type === 'node' && !stack.needsBackend && stack.framework && SUPPORTED_FRAMEWORKS.has(stack.framework)) {
        return { ok: true };
      }
      return {
        ok: false,
        reason: 'Vercel in Bob Deploy supports static output or a Vercel-buildable framework (no custom backend) for now.',
      };
    },

    async validateToken(token: string, teamId?: string): Promise<{ ok: boolean; accountName?: string; message?: string }> {
      try {
        const result = await requestJson<VercelUser>(withTeam(`${baseUrl}/v2/user`, teamId), {
          headers: authHeaders(token),
          parseErrorMessage: parseVercelErrorMessage,
        });
        return { ok: true, accountName: result.user?.username ?? result.user?.email };
      } catch (error) {
        if (error instanceof HostApiError) return { ok: false, message: error.message };
        throw error;
      }
    },

    async *deploy(input: HostDeployInput, signal?: AbortSignal): AsyncIterable<HostDeployEvent> {
      const { token, teamId, siteName, stack, outputDir, projectDir } = input;
      try {
        yield { phase: 'preparing', message: 'Preparing your project for Vercel…' };

        const isStatic = stack.type === 'static';
        const root = isStatic ? (outputDir as string) : projectDir;
        if (isStatic) {
          try {
            await stat(root);
          } catch {
            yield { phase: 'error', message: 'No build output found to deploy.' };
            return;
          }
        }

        yield { phase: 'uploading', message: 'Uploading your files to Vercel…' };
        const files = await collectFiles(root, !isStatic);
        for (const entry of files) {
          if (signal?.aborted) return;
          await uploadFile(baseUrl, token, teamId, entry, signal);
        }

        yield { phase: 'building', message: 'Vercel is building your site…' };
        const deployBody: Record<string, unknown> = {
          name: siteName,
          target: 'production',
          files: files.map((entry) => ({ file: entry.relativePath, sha: entry.sha, size: entry.size })),
        };
        if (!isStatic) {
          deployBody.projectSettings = {
            framework: stack.framework,
            ...(stack.buildCmd ? { buildCommand: stack.buildCmd } : {}),
            ...(stack.outputDir ? { outputDirectory: stack.outputDir } : {}),
          };
        }
        const created = await requestJson<VercelDeployment>(withTeam(`${baseUrl}/v13/deployments`, teamId), {
          method: 'POST',
          headers: { ...authHeaders(token), 'content-type': 'application/json' },
          body: JSON.stringify(deployBody),
          signal,
          parseErrorMessage: parseVercelErrorMessage,
        });

        const finished = await pollDeployment(token, teamId, created.id, signal);
        if (finished.readyState !== 'READY') {
          yield {
            phase: 'error',
            message: finished.errorMessage ?? 'Vercel reported a deploy error.',
            deployId: finished.id,
          };
          return;
        }

        const url = finished.alias?.[0] ?? finished.url;
        yield {
          phase: 'ready',
          message: 'Your site is live on Vercel.',
          url: url.startsWith('http') ? url : `https://${url}`,
          siteId: finished.id,
          deployId: finished.id,
        };
      } catch (error) {
        if (signal?.aborted) return;
        const message = error instanceof HostApiError ? error.message : 'Vercel deploy failed unexpectedly.';
        yield { phase: 'error', message };
      }
    },
  };
}
