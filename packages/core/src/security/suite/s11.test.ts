/**
 * S11 — "A failed release never replaces a healthy one; rollback needs no Bob call."
 *
 * Behavioral coverage (blue/green, health-checked before switching, broken build never replaces the
 * live release) is release.test.ts and release.int.test.ts (tagged "S11"); rollback.test.ts (tagged
 * "S11") already exercises rollbackTo end-to-end with a fake RemoteExec and no AgentRunner in
 * sight. This file adds the one thing those don't: a structural (source-level) guarantee that
 * rollback's *import surface* has no way to reach an AgentRunner/Bob dependency at all — not just
 * that today's tests happen not to pass one — so a future change can't quietly reintroduce a Bob
 * call into rollback without this failing. (Doc comments are allowed to mention "AgentRunner" when
 * explaining the guarantee, so this checks imports/fields, not the whole file's text.)
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

function readSource(relativeToThisFile: string): string {
  return readFileSync(fileURLToPath(new URL(relativeToThisFile, import.meta.url)), 'utf8');
}

/** Every `import ... from '...'` line's module specifier, so we can check what's actually reachable
 * without being tripped up by the word "AgentRunner" appearing only in a comment. */
function importedModules(source: string): string[] {
  return [...source.matchAll(/^import\s+(?:type\s+)?[^;]*\sfrom\s+['"]([^'"]+)['"];?$/gm)].map((m) => m[1]!);
}

describe('S11: rollback has no structural import path to an AgentRunner/Bob dependency', () => {
  it('ssh-playbooks/release/rollback.ts imports nothing agent-related, and RollbackInput has no agent-shaped field', () => {
    const source = readSource('../../../../ssh-playbooks/src/release/rollback.ts');
    for (const mod of importedModules(source)) {
      expect(mod).not.toMatch(/agent/i);
    }
    const interfaceBody = source.slice(source.indexOf('export interface RollbackInput'), source.indexOf('export interface RollbackOutput'));
    expect(interfaceBody).not.toMatch(/AgentRunner|agentRunner|runner\s*:/i);
  });

  it("core's flows/rollback.ts likewise imports nothing agent-related", () => {
    const source = readSource('../../flows/rollback.ts');
    for (const mod of importedModules(source)) {
      expect(mod).not.toMatch(/^@bob-deploy\/agent$/);
    }
  });
});
