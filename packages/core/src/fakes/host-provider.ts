import type { HostDeployEvent, HostDeployInput, HostId, HostProvider, StackInfo } from '@bob-deploy/contracts';

let siteCounter = 0;

export interface FakeHostProviderScript {
  /** Return { ok:false, reason } to make supports() reject a stack (e.g. one that needsBackend). */
  supports?(stack: StackInfo): { ok: boolean; reason?: string };
  /** Return { ok:false, message } to simulate a bad/expired token. Defaults to always ok. */
  validateToken?(token: string, teamId?: string): { ok: boolean; accountName?: string; message?: string };
  /** Override the events deploy() yields; defaults to a normal preparing/uploading/building/ready
   * sequence. Throw to simulate a deploy that errors mid-stream (yielded as a final 'error' event
   * rather than an unhandled rejection, matching how a real provider would report a failure). */
  deployEvents?(input: HostDeployInput): HostDeployEvent[];
}

/** In-memory HostProvider for unit tests and for any flow test that doesn't need a real
 * Netlify/Vercel account (CLAUDE.md: every external dependency behind an interface with a fake).
 * Never used in production — packages/providers owns the real Netlify/Vercel implementations. */
export class FakeHostProvider implements HostProvider {
  readonly id: HostId;
  readonly displayName: string;
  readonly tokenPageUrl = 'https://example.invalid/tokens';

  constructor(
    id: HostId = 'netlify',
    private readonly script: FakeHostProviderScript = {},
  ) {
    this.id = id;
    this.displayName = id === 'netlify' ? 'Netlify' : 'Vercel';
  }

  supports(stack: StackInfo): { ok: boolean; reason?: string } {
    if (this.script.supports) return this.script.supports(stack);
    if (stack.needsBackend) {
      return { ok: false, reason: 'Free hosting only serves static sites; this project needs a server.' };
    }
    return { ok: true };
  }

  // async to match HostProvider's Promise<...> return type even though the fake resolves
  // synchronously.
  // eslint-disable-next-line @typescript-eslint/require-await
  async validateToken(token: string, teamId?: string): Promise<{ ok: boolean; accountName?: string; message?: string }> {
    if (this.script.validateToken) return this.script.validateToken(token, teamId);
    if (!token) return { ok: false, message: 'No token provided.' };
    return { ok: true, accountName: 'fake-account' };
  }

  // async generator to match HostProvider's AsyncIterable return type, though every event here is
  // produced synchronously.
  // eslint-disable-next-line @typescript-eslint/require-await
  async *deploy(input: HostDeployInput, signal?: AbortSignal): AsyncIterable<HostDeployEvent> {
    const siteId = input.siteId ?? `fake-site-${++siteCounter}`;
    const events =
      this.script.deployEvents?.(input) ?? [
        { phase: 'preparing', message: 'Preparing your files…' },
        { phase: 'uploading', message: 'Uploading…' },
        { phase: 'building', message: 'Building…' },
        { phase: 'ready', message: 'Your site is live.', url: `https://${input.siteName}.fake.dev`, siteId },
      ];
    for (const event of events) {
      if (signal?.aborted) return;
      yield { ...event, siteId: event.siteId ?? siteId };
    }
  }
}
