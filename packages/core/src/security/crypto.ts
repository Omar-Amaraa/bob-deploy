import { randomBytes as nodeRandomBytes, randomInt as nodeRandomInt, createCipheriv, createDecipheriv } from 'node:crypto';
import { argon2id } from 'hash-wasm';

/** Argon2id parameters, per S12: 64 MiB memory, 3 iterations, 1 lane. Stored alongside every wrap
 * (KdfParams below) so they can be raised later without breaking old vaults. */
export const ARGON2ID_PARAMS = {
  memorySize: 65536, // KiB = 64 MiB
  iterations: 3,
  parallelism: 1,
  hashLength: 32,
} as const;

export interface KdfParams {
  alg: 'argon2id';
  m: number;
  t: number;
  p: number;
}

export const CURRENT_KDF_PARAMS: KdfParams = {
  alg: 'argon2id',
  m: ARGON2ID_PARAMS.memorySize,
  t: ARGON2ID_PARAMS.iterations,
  p: ARGON2ID_PARAMS.parallelism,
};

/** Thrown by open() when the AES-GCM auth tag doesn't verify: wrong key, or tampered/corrupt data. */
export class BadKeyError extends Error {
  constructor(message = 'Decryption failed: wrong key or corrupted data.') {
    super(message);
    this.name = 'BadKeyError';
  }
}

/**
 * Derives a 32-byte key from `secret` (a master password or recovery code) and a 16-byte `salt`
 * using Argon2id with the current parameters. The secret is Unicode-normalised (NFKC) first so the
 * same human input always derives the same key regardless of how it was typed/composed.
 */
export async function deriveKey(secret: string, salt: Buffer, params: KdfParams = CURRENT_KDF_PARAMS): Promise<Buffer> {
  const normalised = secret.normalize('NFKC');
  const out = await argon2id({
    password: normalised,
    salt,
    memorySize: params.m,
    iterations: params.t,
    parallelism: params.p,
    hashLength: ARGON2ID_PARAMS.hashLength,
    outputType: 'binary',
  });
  return Buffer.from(out);
}

export interface Sealed {
  iv: Buffer;
  ct: Buffer;
  tag: Buffer;
}

/** AES-256-GCM encrypt `plaintext` under `key`, authenticating `aad` (a fixed context string). */
export function seal(key: Buffer, plaintext: Buffer, aad: string): Sealed {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  cipher.setAAD(Buffer.from(aad, 'utf8'));
  const ct = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const tag = cipher.getAuthTag();
  return { iv, ct, tag };
}

/** Inverse of seal(). Throws BadKeyError if `key`/`aad` don't match or the ciphertext was altered. */
export function open(key: Buffer, sealed: Sealed, aad: string): Buffer {
  try {
    const decipher = createDecipheriv('aes-256-gcm', key, sealed.iv);
    decipher.setAAD(Buffer.from(aad, 'utf8'));
    decipher.setAuthTag(sealed.tag);
    return Buffer.concat([decipher.update(sealed.ct), decipher.final()]);
  } catch {
    throw new BadKeyError();
  }
}

export function randomBytes(size: number): Buffer {
  return nodeRandomBytes(size);
}

/** Unbiased random integer in [min, max) — re-exported so callers don't reach for node:crypto directly. */
export function randomInt(min: number, max: number): number {
  return nodeRandomInt(min, max);
}

/** Best-effort zeroing of a buffer's contents in place. Not a guarantee against a copying GC/JIT,
 * but removes the value from this particular allocation once callers are done with it. */
export function wipe(buf: Buffer | Uint8Array): void {
  buf.fill(0);
}
