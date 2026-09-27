import { createHash } from 'node:crypto';
import { SshError } from './errors.js';

/** SHA256 fingerprint in the standard OpenSSH display format ("SHA256:<base64, no padding>"). */
export function fingerprintOf(rawPublicKey: Buffer): string {
  const digest = createHash('sha256').update(rawPublicKey).digest('base64').replace(/=+$/, '');
  return `SHA256:${digest}`;
}

export interface HostVerifierOptions {
  expectedFingerprint?: string;
  onUnknownHostKey?: (fingerprint: string) => Promise<boolean>;
}

/**
 * Builds an ssh2 `hostVerifier` (the async callback form: `(key, verify) => void`). If
 * `expectedFingerprint` is set, the connection is accepted or rejected purely by comparing
 * fingerprints — `onUnknownHostKey` is never consulted, and a mismatch is always
 * SSH_HOSTKEY_MISMATCH, never a prompt. Otherwise, `onUnknownHostKey` decides (TOFU); declining
 * (or its absence) rejects with SSH_HOSTKEY_REJECTED.
 */
export function makeHostVerifier(opts: HostVerifierOptions) {
  let capturedFingerprint = '';
  let capturedError: SshError | undefined;

  const verifier = (rawKey: Buffer, verify: (accepted: boolean) => void): void => {
    const fingerprint = fingerprintOf(rawKey);
    capturedFingerprint = fingerprint;

    if (opts.expectedFingerprint !== undefined) {
      if (fingerprint === opts.expectedFingerprint) {
        verify(true);
      } else {
        capturedError = new SshError('SSH_HOSTKEY_MISMATCH', 'The server presented a different host key than expected.', {
          expected: opts.expectedFingerprint,
          actual: fingerprint,
        });
        verify(false);
      }
      return;
    }

    if (!opts.onUnknownHostKey) {
      capturedError = new SshError('SSH_HOSTKEY_REJECTED', 'No pinned host key and nothing to confirm it against.', { fingerprint });
      verify(false);
      return;
    }

    opts
      .onUnknownHostKey(fingerprint)
      .then((accepted) => {
        if (!accepted) {
          capturedError = new SshError('SSH_HOSTKEY_REJECTED', 'The host key was not confirmed.', { fingerprint });
        }
        verify(accepted);
      })
      .catch(() => {
        capturedError = new SshError('SSH_HOSTKEY_REJECTED', 'The host key was not confirmed.', { fingerprint });
        verify(false);
      });
  };

  return {
    verifier,
    getFingerprint: () => capturedFingerprint,
    getError: () => capturedError,
  };
}
