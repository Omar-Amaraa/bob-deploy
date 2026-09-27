import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  loadWordlist,
  generatePassphrase,
  generateRecoveryCode,
  normalizeRecoveryCode,
  WORDLIST_SIZE,
  PASSPHRASE_BITS,
  RECOVERY_CODE_BITS,
} from './passphrase.js';

const WORDLIST_PATH = fileURLToPath(new URL('../../assets/eff_large_wordlist.txt', import.meta.url));

describe('EFF wordlist asset', () => {
  it('has exactly 7776 unique lowercase words', () => {
    const words = readFileSync(WORDLIST_PATH, 'utf8').split('\n').filter((w) => w.length > 0);
    expect(words).toHaveLength(7776);
    expect(new Set(words).size).toBe(7776);
    for (const w of words) {
      expect(w).toBe(w.toLowerCase());
      expect(w).not.toMatch(/\s/);
    }
  });

  it('loadWordlist() matches the asset and is cached', () => {
    const list = loadWordlist();
    expect(list).toHaveLength(WORDLIST_SIZE);
    expect(loadWordlist()).toBe(list); // same frozen array instance: cached
  });
});

describe('generatePassphrase', () => {
  it('returns 7 hyphen-joined words from the list by default', () => {
    const list = new Set(loadWordlist());
    const phrase = generatePassphrase();
    const words = phrase.split('-');
    expect(words).toHaveLength(7);
    for (const w of words) expect(list.has(w)).toBe(true);
  });

  it('respects a custom word count', () => {
    expect(generatePassphrase(4).split('-')).toHaveLength(4);
  });

  it('PASSPHRASE_BITS (7 words) is at least 90 bits of entropy', () => {
    expect(PASSPHRASE_BITS).toBeGreaterThanOrEqual(90);
  });

  it('produces no duplicates across 10,000 generations', () => {
    const seen = new Set<string>();
    for (let i = 0; i < 10_000; i++) {
      seen.add(generatePassphrase());
    }
    expect(seen.size).toBe(10_000);
  });
});

describe('S13: generateRecoveryCode', () => {
  it('is 8 groups of 4 Crockford-base32 characters separated by dashes (160 bits)', () => {
    const code = generateRecoveryCode();
    expect(code).toMatch(/^[0-9A-HJKMNP-TV-Z]{4}(-[0-9A-HJKMNP-TV-Z]{4}){7}$/);
    expect(RECOVERY_CODE_BITS).toBe(160);
  });

  it('produces no duplicates across 10,000 generations', () => {
    const seen = new Set<string>();
    for (let i = 0; i < 10_000; i++) seen.add(generateRecoveryCode());
    expect(seen.size).toBe(10_000);
  });

  it('normalizeRecoveryCode strips dashes and upper-cases', () => {
    expect(normalizeRecoveryCode('abcd-1234')).toBe('ABCD1234');
  });
});
