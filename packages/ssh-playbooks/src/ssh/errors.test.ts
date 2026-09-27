import { describe, it, expect } from 'vitest';
import { classifyConnectError } from './errors.js';

describe('classifyConnectError', () => {
  it.each(['ECONNREFUSED', 'EHOSTUNREACH', 'ENETUNREACH', 'ETIMEDOUT'])('maps %s to SSH_UNREACHABLE', (code) => {
    const err = Object.assign(new Error('boom'), { code });
    expect(classifyConnectError(err).code).toBe('SSH_UNREACHABLE');
  });

  it('maps the ssh2 auth-failure message to SSH_AUTH_FAILED with a plain-language message', () => {
    const err = new Error('All configured authentication methods failed');
    const mapped = classifyConnectError(err);
    expect(mapped.code).toBe('SSH_AUTH_FAILED');
    expect(mapped.message).toBe('The server did not accept the password.');
  });

  it('maps a ready-timeout message to SSH_TIMEOUT', () => {
    const err = new Error('Timed out while waiting for handshake');
    expect(classifyConnectError(err).code).toBe('SSH_TIMEOUT');
  });

  it('falls back to SSH_UNREACHABLE for anything unrecognized', () => {
    const err = new Error('something ssh2-internal and unexpected');
    expect(classifyConnectError(err).code).toBe('SSH_UNREACHABLE');
  });
});
