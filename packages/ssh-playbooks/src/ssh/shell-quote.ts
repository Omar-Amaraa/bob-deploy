/**
 * Single-quote POSIX escaping: wraps `arg` in single quotes, replacing any single quote inside it
 * with `'\''` (close quote, escaped quote, reopen quote). Every playbook must build shell commands
 * through this — never string-interpolate a value directly into a command string.
 */
export function shellQuote(arg: string): string {
  return `'${arg.replace(/'/g, `'\\''`)}'`;
}
