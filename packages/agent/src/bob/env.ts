import { join } from 'node:path';
import { platform } from 'node:os';

/**
 * Env var names Bob Shell reads its API key from. Confirmed via packages/core/src/security/
 * redactor.ts's built-in patterns, which already redact both `BOBSHELL_API_KEY=` and
 * `BOB_API_KEY=` — the naming convention core already assumes Bob uses.
 */
export const BOB_KEY_ENV_VARS: readonly string[] = ['BOBSHELL_API_KEY', 'BOB_API_KEY'];

export interface ScrubbedEnvInput {
  bobHome: string;
  apiKey: string;
}

/**
 * Builds the fully-scrubbed environment Bob is spawned with (S14): nothing from the parent
 * process's own environment leaks through except PATH, so Bob can never read an unrelated secret
 * sitting in the app's environment. bobHome stands in for the real HOME/USERPROFILE so anything
 * Bob writes to its own config/cache directories is contained and disposable.
 */
export function buildScrubbedEnv(input: ScrubbedEnvInput): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    PATH: process.env.PATH,
    HOME: input.bobHome,
    LANG: 'C.UTF-8',
    LC_ALL: 'C.UTF-8',
  };
  if (platform() === 'win32') {
    env.USERPROFILE = input.bobHome;
    env.APPDATA = join(input.bobHome, 'AppData', 'Roaming');
    env.LOCALAPPDATA = join(input.bobHome, 'AppData', 'Local');
    env.SystemRoot = process.env.SystemRoot;
    env.ComSpec = process.env.ComSpec;
    env.PATHEXT = process.env.PATHEXT;
  }
  for (const key of BOB_KEY_ENV_VARS) env[key] = input.apiKey;
  return env;
}
