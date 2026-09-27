import { fetch, Agent, setGlobalDispatcher } from 'undici';

type FetchResponse = Awaited<ReturnType<typeof fetch>>;

/**
 * Thrown by request()/requestBuffer() on any non-2xx response, or after retries are exhausted.
 * `code` follows the brief's mapping: 401/403 -> HOST_AUTH_FAILED, everything else -> HOST_API_ERROR.
 * `message` is always plain language, safe to show, and never contains the token (the token is only
 * ever sent in the Authorization header, never interpolated into a thrown message).
 */
export class HostApiError extends Error {
  readonly code: 'HOST_AUTH_FAILED' | 'HOST_API_ERROR';
  readonly status?: number;
  constructor(code: 'HOST_AUTH_FAILED' | 'HOST_API_ERROR', message: string, status?: number) {
    super(message);
    this.name = 'HostApiError';
    this.code = code;
    this.status = status;
  }
}

export interface RequestOptions {
  method?: string;
  headers?: Record<string, string>;
  body?: string | Uint8Array;
  signal?: AbortSignal;
  timeoutMs?: number;
  /** Max retries on 429/5xx, per the brief ("max 3, honour Retry-After"). */
  maxRetries?: number;
}

const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_MAX_RETRIES = 3;

// A single keep-alive Agent per process, so tests (and production) reuse connections and honour
// per-request `timeoutMs` via undici's own headers/body timeouts instead of node's global agent.
let agentInstalled = false;
function ensureAgent(): void {
  if (agentInstalled) return;
  setGlobalDispatcher(new Agent({ connectTimeout: DEFAULT_TIMEOUT_MS }));
  agentInstalled = true;
}

function combineSignals(a: AbortSignal, b: AbortSignal): AbortSignal {
  const controller = new AbortController();
  const onAbort = () => controller.abort();
  if (a.aborted || b.aborted) controller.abort();
  a.addEventListener('abort', onAbort, { once: true });
  b.addEventListener('abort', onAbort, { once: true });
  return controller.signal;
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new DOMException('Aborted', 'AbortError'));
      return;
    }
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener(
      'abort',
      () => {
        clearTimeout(timer);
        reject(new DOMException('Aborted', 'AbortError'));
      },
      { once: true },
    );
  });
}

function parseRetryAfterMs(response: FetchResponse): number | undefined {
  const retryAfter = response.headers.get('retry-after');
  if (retryAfter) {
    const seconds = Number(retryAfter);
    if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000);
  }
  const resetHeader = response.headers.get('x-ratelimit-reset');
  if (resetHeader) {
    const resetAt = Number(resetHeader);
    if (Number.isFinite(resetAt)) {
      // Vercel documents this header as a Unix timestamp (seconds) of when the limit resets.
      const ms = resetAt * 1000 - Date.now();
      if (ms > 0) return ms;
    }
  }
  return undefined;
}

function backoffMs(attempt: number): number {
  return Math.min(8_000, 250 * 2 ** attempt);
}

function mapStatusToCode(status: number): 'HOST_AUTH_FAILED' | 'HOST_API_ERROR' {
  return status === 401 || status === 403 ? 'HOST_AUTH_FAILED' : 'HOST_API_ERROR';
}

/** Raw fetch with retry/backoff on 429/5xx, honouring Retry-After / X-RateLimit-Reset. Never
 * retries other 4xx (those are permanent per-request failures, not transient). */
export async function requestRaw(url: string, options: RequestOptions = {}): Promise<FetchResponse> {
  ensureAgent();
  const maxRetries = options.maxRetries ?? DEFAULT_MAX_RETRIES;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  let lastError: unknown;
  for (let attempt = 0; attempt <= maxRetries; attempt += 1) {
    const timeoutController = new AbortController();
    const timeoutTimer = setTimeout(() => timeoutController.abort(), timeoutMs);
    const combinedSignal = options.signal
      ? combineSignals(options.signal, timeoutController.signal)
      : timeoutController.signal;
    try {
      const response = await fetch(url, {
        method: options.method ?? 'GET',
        headers: options.headers,
        body: options.body,
        signal: combinedSignal,
      });
      clearTimeout(timeoutTimer);
      if ((response.status === 429 || response.status >= 500) && attempt < maxRetries) {
        const delay = parseRetryAfterMs(response) ?? backoffMs(attempt);
        await sleep(delay, options.signal);
        continue;
      }
      return response;
    } catch (error) {
      clearTimeout(timeoutTimer);
      if (options.signal?.aborted) throw error; // caller-initiated abort: never retry, never mask.
      lastError = error;
      if (attempt < maxRetries) {
        await sleep(backoffMs(attempt), options.signal);
        continue;
      }
      throw new HostApiError('HOST_API_ERROR', 'Could not reach the hosting provider. Check your connection and try again.');
    }
  }
  throw lastError instanceof Error ? lastError : new HostApiError('HOST_API_ERROR', 'Request failed.');
}

/** GET/POST/etc a JSON endpoint. Throws HostApiError (never includes the token) on a non-2xx
 * response after retries. `parseErrorMessage` lets each provider read its own error-body shape
 * (Netlify: {message}; Vercel: {error:{message}}) without this helper knowing about either. */
export async function requestJson<T>(
  url: string,
  options: RequestOptions & { parseErrorMessage?: (body: unknown) => string | undefined } = {},
): Promise<T> {
  const response = await requestRaw(url, options);
  const text = await response.text();
  let body: unknown;
  try {
    body = text ? JSON.parse(text) : undefined;
  } catch {
    body = undefined;
  }
  if (!response.ok) {
    const message = options.parseErrorMessage?.(body) ?? `Request failed with status ${response.status}.`;
    throw new HostApiError(mapStatusToCode(response.status), message, response.status);
  }
  return body as T;
}

/** POST raw bytes (a zip, a single file) and get back parsed JSON. Same retry/error handling as
 * requestJson, but the request body is binary rather than a JSON string. */
export async function requestBinaryJson<T>(
  url: string,
  body: Uint8Array,
  options: RequestOptions & { parseErrorMessage?: (body: unknown) => string | undefined } = {},
): Promise<T> {
  return requestJson<T>(url, { ...options, body });
}
