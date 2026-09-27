import type { StackInfo, Clock } from '@bob-deploy/contracts';
import type { RemoteExec } from '../ssh/types.js';
import { HELPER_SCRIPTS, type GeneratedScript } from '../generated/scripts.js';
import { runScript } from '../playbook/run-script.js';
import { mapBdErrorCode } from '../playbook/error-mapping.js';
import { stepFail, stepOk, type PlaybookStep, type PlaybookStepOutcome } from '../playbook/types.js';
import { findFreePortPair } from './ports.js';
import type { HttpProbe, HttpProbeResult } from './http-probe.js';
import { realClock, sleep } from './release.js';

function scriptByName(name: string): GeneratedScript {
  const found = HELPER_SCRIPTS.find((s) => s.name === name);
  if (!found) throw new Error(`No generated helper script named "${name}" (this is a bug).`);
  return found;
}

export type TlsMode = 'auto' | 'internal';

export interface ProxyAndHttpsInput {
  session: RemoteExec;
  app: string;
  adminUser: string;
  domain: string;
  stack: StackInfo;
  tlsMode: TlsMode;
  /** Ports already claimed by other apps/targets on this same server (see findFreePortPair). */
  portsInUse?: readonly number[];
  /** Only needed to verify HTTPS for static apps right away; proxy apps verify after first_release. */
  httpProbe?: HttpProbe;
  healthPath?: string;
  /** HTTPS check retries: Caddy was just restarted/reloaded and may need a moment to listen on
   * 443 and issue the certificate (slow on Docker Desktop). Defaults: 6 tries, 2 s apart. */
  probeTries?: number;
  probeIntervalMs?: number;
  clock?: Clock;
}

export interface ProxyAndHttpsOutput {
  portA: number;
  portB: number;
  /** True once bd-caddy-site has actually been run for this app (static apps: now; proxy apps: not
   * yet — release.ts's switch step (j) does it once the first release is live). */
  caddySiteConfigured: boolean;
}

/**
 * Step 8 (Flow 1): proxy_and_https. Installs Caddy, scaffolds the app (user, dir, systemd unit
 * template — port-instanced, so blue/green releases can run two instances at once), and allocates
 * a free port pair >= 3100. Static apps get their Caddy site (serving files, no proxy) immediately
 * and are verified over HTTPS here; proxy apps (node/python) have no running process yet, so their
 * Caddy site is created later, once first_release has something live to point at.
 */
export const proxyAndHttpsStep: PlaybookStep<ProxyAndHttpsInput, ProxyAndHttpsOutput> = {
  id: 'proxy_and_https',
  title: 'Set up the reverse proxy and HTTPS',
  async run(input): Promise<PlaybookStepOutcome<ProxyAndHttpsOutput>> {
    const caddy = await runScript(input.session, scriptByName('bd-install-caddy'), [], { sudo: true, timeoutMs: 120000 });
    if (!caddy.outcome.ok) {
      return stepFail(mapBdErrorCode(caddy.outcome.code), caddy.outcome.message, { stderr: caddy.exec.stderr });
    }

    const appSetup = await runScript(input.session, scriptByName('bd-app-setup'), [input.app, input.adminUser], {
      sudo: true,
    });
    if (!appSetup.outcome.ok) {
      return stepFail(mapBdErrorCode(appSetup.outcome.code), appSetup.outcome.message, { stderr: appSetup.exec.stderr });
    }

    const pair = await findFreePortPair(input.session, input.portsInUse ?? []);
    if (!pair) {
      return stepFail('INTERNAL', 'Could not find two free ports (>= 3100) on the server for this app.');
    }

    if (input.stack.type === 'static') {
      const site = await runScript(
        input.session,
        scriptByName('bd-caddy-site'),
        [input.app, input.domain, 'static', input.tlsMode],
        { sudo: true },
      );
      if (!site.outcome.ok) {
        return stepFail(mapBdErrorCode(site.outcome.code), site.outcome.message, { stderr: site.exec.stderr });
      }
      if (input.httpProbe) {
        const healthPath = input.healthPath ?? '/';
        // Nothing has been released yet (first_release uploads the files and checks the page
        // itself), so Caddy answers 403/404 here. This check is only about HTTPS working: any
        // non-5xx answer over TLS passes; no answer at all, a TLS error or a 5xx fails.
        const httpsAnswers = (r: HttpProbeResult): boolean =>
          r.ok || (typeof r.status === 'number' && r.status > 0 && r.status < 500);
        const tries = input.probeTries ?? 6;
        const clock = input.clock ?? realClock;
        let probe: HttpProbeResult = { ok: false, error: 'not probed' };
        for (let i = 0; i < tries; i++) {
          probe = await input.httpProbe.probe(`https://${input.domain}${healthPath}`, 10000);
          if (httpsAnswers(probe)) break;
          if (i < tries - 1) await sleep(clock, input.probeIntervalMs ?? 2000);
        }
        if (!httpsAnswers(probe)) {
          return stepFail(
            'HEALTHCHECK_FAILED',
            `The site was configured but did not answer over HTTPS: ${probe.error ?? `status ${probe.status ?? 'unknown'}`}`,
          );
        }
      }
      return stepOk({ portA: pair.portA, portB: pair.portB, caddySiteConfigured: true });
    }

    return stepOk({ portA: pair.portA, portB: pair.portB, caddySiteConfigured: false });
  },
};
