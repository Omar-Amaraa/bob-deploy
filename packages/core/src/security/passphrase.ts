import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { randomBytes, randomInt } from './crypto.js';

const WORDLIST_PATH = fileURLToPath(new URL('../../assets/eff_large_wordlist.txt', import.meta.url));

let cachedWordlist: readonly string[] | undefined;

/** Loads (and caches) the EFF large wordlist — see packages/core/assets/ATTRIBUTION.md. */
export function loadWordlist(): readonly string[] {
  if (!cachedWordlist) {
    const words = readFileSync(WORDLIST_PATH, 'utf8').split('\n').filter((w) => w.length > 0);
    cachedWordlist = Object.freeze(words);
  }
  return cachedWordlist;
}

export const WORDLIST_SIZE = 7776;

/** Bits of entropy per generated word (log2(7776) ≈ 12.925). */
export const BITS_PER_WORD = Math.log2(WORDLIST_SIZE);

/** Total entropy for the default 7-word passphrase — used as the "≥90 bits" acceptance check. */
export const PASSPHRASE_BITS = 7 * BITS_PER_WORD;

/**
 * Generates a passphrase of `words` words picked from the EFF large wordlist using
 * crypto.randomInt (rejection-sampled internally by Node, so no modulo bias), joined with '-'.
 * Used for the generated SSH key passphrase (DEC-002).
 */
export function generatePassphrase(words = 7): string {
  const list = loadWordlist();
  const picked: string[] = [];
  for (let i = 0; i < words; i++) {
    picked.push(list[randomInt(0, list.length)]!);
  }
  return picked.join('-');
}

const CROCKFORD_ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ'; // excludes I, L, O, U

/** Encodes `buf` as unpadded Crockford base32 (uppercase, ambiguous letters excluded). */
function crockfordBase32(buf: Buffer): string {
  let bits = 0;
  let value = 0;
  let out = '';
  for (const byte of buf) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += CROCKFORD_ALPHABET[(value >>> (bits - 5)) & 0x1f];
      bits -= 5;
    }
  }
  if (bits > 0) {
    out += CROCKFORD_ALPHABET[(value << (5 - bits)) & 0x1f];
  }
  return out;
}

/** Recovery code entropy, in bits (S13: 160 bits). */
export const RECOVERY_CODE_BITS = 160;

/**
 * Generates a 160-bit recovery code: 20 random bytes, Crockford base32 encoded (32 characters),
 * displayed as 8 groups of 4 separated by '-'. Shown once at account creation / regeneration.
 */
export function generateRecoveryCode(): string {
  const encoded = crockfordBase32(randomBytes(20));
  const groups: string[] = [];
  for (let i = 0; i < encoded.length; i += 4) groups.push(encoded.slice(i, i + 4));
  return groups.join('-');
}

/** Normalises a recovery code the way it's compared/derived-from: uppercase, dashes stripped. */
export function normalizeRecoveryCode(code: string): string {
  return code.replace(/-/g, '').toUpperCase();
}
