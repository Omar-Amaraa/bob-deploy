import { describe, it, expect } from 'vitest';
import { createHash } from 'node:crypto';
import { fingerprintOf, makeHostVerifier } from './host-verifier.js';

const KEY_A = Buffer.from('fake-host-key-a');
const KEY_B = Buffer.from('fake-host-key-b');

function expectedFingerprint(key: Buffer): string {
  return `SHA256:${createHash('sha256').update(key).digest('base64').replace(/=+$/, '')}`;
}

describe('fingerprintOf', () => {
  it('computes the standard OpenSSH SHA256 fingerprint format', () => {
    expect(fingerprintOf(KEY_A)).toBe(expectedFingerprint(KEY_A));
    expect(fingerprintOf(KEY_A)).toMatch(/^SHA256:[A-Za-z0-9+/]+$/);
  });
});

describe('makeHostVerifier — pinned fingerprint', () => {
  it('accepts a matching pinned fingerprint without ever consulting onUnknownHostKey', async () => {
    let promptCalled = false;
    const { verifier, getError } = makeHostVerifier({
      expectedFingerprint: fingerprintOf(KEY_A),
      onUnknownHostKey: () => {
        promptCalled = true;
        return Promise.resolve(true);
      },
    });
    const accepted = await new Promise<boolean>((resolve) => verifier(KEY_A, resolve));
    expect(accepted).toBe(true);
    expect(promptCalled).toBe(false);
    expect(getError()).toBeUndefined();
  });

  it('rejects a mismatched pinned fingerprint with SSH_HOSTKEY_MISMATCH, never prompting', async () => {
    let promptCalled = false;
    const { verifier, getError } = makeHostVerifier({
      expectedFingerprint: fingerprintOf(KEY_A),
      onUnknownHostKey: () => {
        promptCalled = true;
        return Promise.resolve(true);
      },
    });
    const accepted = await new Promise<boolean>((resolve) => verifier(KEY_B, resolve));
    expect(accepted).toBe(false);
    expect(promptCalled).toBe(false);
    expect(getError()?.code).toBe('SSH_HOSTKEY_MISMATCH');
  });
});

describe('makeHostVerifier — TOFU (no pinned fingerprint)', () => {
  it('accepts when onUnknownHostKey resolves true', async () => {
    let seenFingerprint = '';
    const { verifier, getError } = makeHostVerifier({
      onUnknownHostKey: (fp) => {
        seenFingerprint = fp;
        return Promise.resolve(true);
      },
    });
    const accepted = await new Promise<boolean>((resolve) => verifier(KEY_A, resolve));
    expect(accepted).toBe(true);
    expect(seenFingerprint).toBe(fingerprintOf(KEY_A));
    expect(getError()).toBeUndefined();
  });

  it('rejects with SSH_HOSTKEY_REJECTED when onUnknownHostKey resolves false', async () => {
    const { verifier, getError } = makeHostVerifier({ onUnknownHostKey: () => Promise.resolve(false) });
    const accepted = await new Promise<boolean>((resolve) => verifier(KEY_A, resolve));
    expect(accepted).toBe(false);
    expect(getError()?.code).toBe('SSH_HOSTKEY_REJECTED');
  });

  it('rejects with SSH_HOSTKEY_REJECTED when no onUnknownHostKey is given at all', async () => {
    const { verifier, getError } = makeHostVerifier({});
    const accepted = await new Promise<boolean>((resolve) => verifier(KEY_A, resolve));
    expect(accepted).toBe(false);
    expect(getError()?.code).toBe('SSH_HOSTKEY_REJECTED');
  });
});
