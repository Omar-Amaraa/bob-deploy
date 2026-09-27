import { describe, it, expect } from 'vitest';
import { FakeHttpProbe } from './http-probe.js';

describe('FakeHttpProbe', () => {
  it('matches by URL substring and consumes queued responses in order', async () => {
    const probe = new FakeHttpProbe({ 'example.com': [{ ok: false, status: 502 }, { ok: true, status: 200 }] });
    expect(await probe.probe('https://example.com/', 1000)).toEqual({ ok: false, status: 502 });
    expect(await probe.probe('https://example.com/', 1000)).toEqual({ ok: true, status: 200 });
    expect(probe.callLog).toEqual(['https://example.com/', 'https://example.com/']);
  });

  it('reports a clear error when nothing was queued for a URL', async () => {
    const probe = new FakeHttpProbe();
    const result = await probe.probe('https://unexpected.example/', 1000);
    expect(result.ok).toBe(false);
    expect(result.error).toContain('no response queued');
  });
});
