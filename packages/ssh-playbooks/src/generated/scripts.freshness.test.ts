import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { buildGeneratedSource, OUT_FILE } from '../../scripts-gen/build-scripts.mjs';

// Guards against editing scripts/*.sh (or scripts/helpers/bd-*) without re-running
// `node scripts-gen/build-scripts.mjs` to regenerate this package's src/generated/scripts.ts.
// buildGeneratedSource() also throws if a script file was added/removed without updating the
// generator's NUMBERED_SCRIPTS / HELPER_SCRIPT_NAMES lists, or if a script is missing the
// `# @@LIB@@` marker line lib.sh gets inlined into.
describe('src/generated/scripts.ts', () => {
  it('is up to date with packages/ssh-playbooks/scripts/', () => {
    const expected = buildGeneratedSource();
    const actual = readFileSync(OUT_FILE, 'utf8');
    expect(actual).toBe(expected);
  });
});
