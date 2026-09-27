import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import { BOOTSTRAP_SCRIPTS, HELPER_SCRIPTS, HELPERS_ALLOWLIST } from './scripts.js';

// POSIX-only: needs a real bash / /bin/sh. Windows has none (the WSL bash.exe shim can't see C:\ paths),
// so these run on Linux/macOS and CI and are skipped on win32.
const IS_WINDOWS = process.platform === 'win32';

// Every generated script (lib.sh already inlined) must at least be syntactically valid bash —
// cheap to check here, and it would have caught A8's early `bd-app-setup` heredoc quoting bugs
// long before a testbed run.
describe('generated scripts have valid bash syntax', () => {
  for (const script of [...BOOTSTRAP_SCRIPTS, ...HELPER_SCRIPTS]) {
    it.skipIf(IS_WINDOWS)(script.name, () => {
      expect(() => execFileSync('bash', ['-n'], { input: script.content })).not.toThrow();
    });
  }

  it('allowlist.txt is not a bash script but has no stray content', () => {
    expect(HELPERS_ALLOWLIST.content.length).toBeGreaterThan(0);
  });
});
