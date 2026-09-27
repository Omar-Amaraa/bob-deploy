import { zxcvbn, zxcvbnOptions } from '@zxcvbn-ts/core';
import * as zxcvbnCommon from '@zxcvbn-ts/language-common';
import * as zxcvbnEn from '@zxcvbn-ts/language-en';

let configured = false;

/** Configures zxcvbn-ts with the common + English dictionaries/graphs once per process. Without
 * this, zxcvbn has no dictionary at all and scores everything (including 'password123456') as if
 * it were random — so this must run before the first scorePassword() call. */
function ensureConfigured(): void {
  if (configured) return;
  zxcvbnOptions.setOptions({
    dictionary: { ...zxcvbnCommon.dictionary, ...zxcvbnEn.dictionary },
    graphs: zxcvbnCommon.adjacencyGraphs,
    translations: zxcvbnEn.translations,
  });
  configured = true;
}

export interface PasswordScore {
  score: 0 | 1 | 2 | 3 | 4;
  warning?: string;
  suggestions: string[];
}

/** Scores `password` against zxcvbn-ts, treating `userInputs` (display name, email, product names, ...)
 * as extra "known" strings the way a real attacker's guess list would include them. */
export function scorePassword(password: string, userInputs: string[] = []): PasswordScore {
  ensureConfigured();
  const result = zxcvbn(password, userInputs);
  return {
    score: result.score,
    warning: result.feedback.warning || undefined,
    suggestions: result.feedback.suggestions ?? [],
  };
}
