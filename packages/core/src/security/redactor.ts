/**
 * S6 — a singleton per core instance that strips secret values (and known secret-shaped patterns)
 * out of any text before it can reach a log line, a crash report, or a prompt sent to Bob Shell.
 * Injected into JobEngine's `redact` dependency (A2), the logger, the agent adapter, crash reporting.
 */

const HIDDEN = '[hidden]';

/** Built-in patterns for secret shapes we didn't explicitly register but should never leak anyway. */
const BUILTIN_PATTERNS: RegExp[] = [
  // OpenSSH / PEM private key blocks (any -----BEGIN ... PRIVATE KEY----- ... -----END ... -----).
  /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z0-9 ]*PRIVATE KEY-----/g,
  // Authorization: Bearer <token>
  /Authorization:\s*Bearer\s+[^\s"'`]+/gi,
  // BOBSHELL_API_KEY=<x> / BOB_API_KEY=<x>
  /\b(BOBSHELL_API_KEY|BOB_API_KEY)=[^\s"'`]+/g,
  // password=<x> or "password":"<x>"
  /\bpassword=[^\s"'&`]+/gi,
  /"password"\s*:\s*"(?:[^"\\]|\\.)*"/gi,
  // Netlify personal access tokens.
  /\bnfp_[A-Za-z0-9]+/g,
  // AWS-style access key IDs.
  /\bAKIA[0-9A-Z]{16}\b/g,
  // Generic 40+ char hex/base64 token following the word "token" or "key" within 20 chars.
  /\b(?:token|key)\b[\s\S]{0,20}?\b([A-Za-z0-9+/_-]{40,}={0,2})\b/gi,
];

function base64Of(s: string): string {
  return Buffer.from(s, 'utf8').toString('base64');
}

function base64UrlOf(s: string): string {
  return base64Of(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export class Redactor {
  /** All registered literal forms (secret + its encoded variants), longest first. */
  private literals: string[] = [];
  private literalSet = new Set<string>();
  private compiled: RegExp | null = null;

  /** Registers `secret` and, if it's long enough to be worth it, its common encoded forms. */
  add(secret: string): void {
    if (!secret) return;
    this.addLiteral(secret);
    if (secret.length >= 6) {
      this.addLiteral(base64Of(secret));
      this.addLiteral(base64UrlOf(secret));
      this.addLiteral(encodeURIComponent(secret));
      this.addLiteral(JSON.stringify(secret).slice(1, -1)); // JSON-escaped, unquoted
    }
    this.compiled = null;
  }

  private addLiteral(value: string): void {
    if (!value || this.literalSet.has(value)) return;
    this.literalSet.add(value);
    this.literals.push(value);
    // Keep sorted longest-first so overlapping matches prefer the longer (more specific) one.
    this.literals.sort((a, b) => b.length - a.length);
  }

  private literalsPattern(): RegExp | null {
    if (this.literals.length === 0) return null;
    if (!this.compiled) {
      const alternatives = this.literals.map(escapeRegExp).join('|');
      this.compiled = new RegExp(alternatives, 'g');
    }
    return this.compiled;
  }

  /** Replaces every registered secret (and its encoded forms) and every built-in pattern match with '[hidden]'. */
  redact(text: string): string {
    if (typeof text !== 'string' || text.length === 0) return text;
    let out = text;
    const literalPattern = this.literalsPattern();
    if (literalPattern) {
      out = out.replace(literalPattern, HIDDEN);
    }
    for (const pattern of BUILTIN_PATTERNS) {
      out = out.replace(pattern, HIDDEN);
    }
    return out;
  }

  /** Deep-clones `value`, redacting every string it finds (including object keys' string values). */
  redactDeep<T>(value: T): T {
    return this.redactValue(value) as T;
  }

  private redactValue(value: unknown): unknown {
    if (typeof value === 'string') return this.redact(value);
    if (Array.isArray(value)) return value.map((v) => this.redactValue(v));
    if (value instanceof Date) return value;
    if (value && typeof value === 'object') {
      const out: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(value)) {
        out[k] = this.redactValue(v);
      }
      return out;
    }
    return value;
  }

  /** Thrown (as an error with code INTERNAL) by assertNoSecrets when a registered secret is present. */
  assertNoSecrets(text: string): void {
    for (const literal of this.literals) {
      if (literal.length > 0 && text.includes(literal)) {
        const err = new Error('Refusing to proceed: text contains a registered secret.') as Error & { code: string };
        err.code = 'INTERNAL';
        throw err;
      }
    }
  }
}
