import http from 'node:http';
import https, { type RequestOptions } from 'node:https';
import { performance } from 'node:perf_hooks';
import { TLSSocket } from 'node:tls';

export interface SiteCheck { status: number; responseMs: number; certDaysLeft?: number }
export interface SiteCheckOptions {
  tlsInsecure?: boolean;
  timeoutMs?: number;
  testbedHttpsPort?: number;
}

function testbedHttpsPort(value: number | undefined): number {
  if (Number.isInteger(value) && value !== undefined && value >= 1 && value <= 65_535) return value;
  const configured = Number(process.env['BOB_DEPLOY_TESTBED_HTTPS_PORT'] ?? '8443');
  return Number.isInteger(configured) && configured >= 1 && configured <= 65_535 ? configured : 8443;
}

function isTestbedHttpsTarget(target: URL, options: SiteCheckOptions): boolean {
  return Boolean(
    options.tlsInsecure &&
    target.protocol === 'https:' &&
    target.hostname.toLowerCase().endsWith('.bd.test'),
  );
}

export function siteRequestOptions(target: URL, options: SiteCheckOptions): RequestOptions {
  const requestOptions: RequestOptions = {
    method: 'HEAD',
    timeout: options.timeoutMs ?? 10_000,
  };
  if (isTestbedHttpsTarget(target, options)) {
    return {
      ...requestOptions,
      hostname: '127.0.0.1',
      port: testbedHttpsPort(options.testbedHttpsPort),
      path: `${target.pathname}${target.search}`,
      servername: target.hostname,
      headers: { host: target.host },
      rejectUnauthorized: false,
    };
  }
  if (target.protocol === 'https:') requestOptions.rejectUnauthorized = !options.tlsInsecure;
  return requestOptions;
}

export function certificateDaysLeft(validTo: string, now = new Date()): number | undefined {
  const expiry = Date.parse(validTo);
  if (!Number.isFinite(expiry)) return undefined;
  return Math.ceil((expiry - now.getTime()) / 86_400_000);
}

export async function checkSite(url: string, options: SiteCheckOptions = {}): Promise<SiteCheck> {
  const started = performance.now();
  try {
    const target = new URL(url);
    const client = target.protocol === 'https:' ? https : http;
    return await new Promise<SiteCheck>((resolve) => {
      const request = client.request(target, siteRequestOptions(target, options), (response) => {
        const result: SiteCheck = { status: response.statusCode ?? 0, responseMs: Math.round(performance.now() - started) };
        if (target.protocol === 'https:') {
          const certificate = response.socket instanceof TLSSocket ? response.socket.getPeerCertificate() : undefined;
          const days = certificate?.valid_to ? certificateDaysLeft(certificate.valid_to) : undefined;
          if (days !== undefined) result.certDaysLeft = days;
        }
        response.resume();
        resolve(result);
      });
      request.on('timeout', () => request.destroy(new Error('timeout')));
      request.on('error', () => resolve({ status: 0, responseMs: Math.round(performance.now() - started) }));
      request.end();
    });
  } catch {
    return { status: 0, responseMs: Math.round(performance.now() - started) };
  }
}
