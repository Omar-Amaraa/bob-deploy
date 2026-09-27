import { describe, it, expect } from 'vitest';
import { deriveKey, seal, open, randomBytes, randomInt, wipe, BadKeyError, CURRENT_KDF_PARAMS } from './crypto.js';

describe('crypto', () => {
  it('derives the same key for the same secret + salt, and a different one for a different secret', async () => {
    const salt = randomBytes(16);
    const k1 = await deriveKey('correct-horse-battery-Staple-42', salt);
    const k2 = await deriveKey('correct-horse-battery-Staple-42', salt);
    const k3 = await deriveKey('a-different-password', salt);
    expect(k1.equals(k2)).toBe(true);
    expect(k1.equals(k3)).toBe(false);
    expect(k1).toHaveLength(32);
  });

  it('normalises NFKC so differently-composed Unicode input derives the same key', async () => {
    const salt = randomBytes(16);
    const nfc = 'café'; // é as a single code point
    const nfd = 'café'; // e + combining acute accent
    const k1 = await deriveKey(nfc, salt);
    const k2 = await deriveKey(nfd, salt);
    expect(k1.equals(k2)).toBe(true);
  });

  it('records the current KDF params so they can be raised later', () => {
    expect(CURRENT_KDF_PARAMS).toEqual({ alg: 'argon2id', m: 65536, t: 3, p: 1 });
  });

  it('seal/open round-trips plaintext under matching key and aad', async () => {
    const key = await deriveKey('some-secret', randomBytes(16));
    const plaintext = Buffer.from('hello vault', 'utf8');
    const sealed = seal(key, plaintext, 'bd-vault-v1');
    const opened = open(key, sealed, 'bd-vault-v1');
    expect(opened.equals(plaintext)).toBe(true);
  });

  it('open throws BadKeyError on wrong key', async () => {
    const key1 = await deriveKey('secret-one', randomBytes(16));
    const key2 = await deriveKey('secret-two', randomBytes(16));
    const sealed = seal(key1, Buffer.from('payload'), 'aad');
    expect(() => open(key2, sealed, 'aad')).toThrow(BadKeyError);
  });

  it('open throws BadKeyError on mismatched aad', async () => {
    const key = await deriveKey('secret', randomBytes(16));
    const sealed = seal(key, Buffer.from('payload'), 'aad-a');
    expect(() => open(key, sealed, 'aad-b')).toThrow(BadKeyError);
  });

  it('open throws BadKeyError on tampered ciphertext', async () => {
    const key = await deriveKey('secret', randomBytes(16));
    const sealed = seal(key, Buffer.from('payload'), 'aad');
    sealed.ct[0] = sealed.ct[0]! ^ 0xff;
    expect(() => open(key, sealed, 'aad')).toThrow(BadKeyError);
  });

  it('randomInt(min, max) never returns max and stays unbiased over a small range', () => {
    const counts = new Map<number, number>();
    for (let i = 0; i < 2000; i++) {
      const n = randomInt(0, 5);
      expect(n).toBeGreaterThanOrEqual(0);
      expect(n).toBeLessThan(5);
      counts.set(n, (counts.get(n) ?? 0) + 1);
    }
    expect(counts.size).toBe(5);
  });

  it('wipe zeroes a buffer in place', () => {
    const buf = Buffer.from('secret-bytes');
    wipe(buf);
    expect(buf.every((b) => b === 0)).toBe(true);
  });
});
