import type { z } from 'zod';
import { RESULT_BEGIN, RESULT_END } from '../prompts/output-contract.js';

export type ParseFailureReason = 'missing-markers' | 'invalid-json' | 'schema-mismatch';

export type ParseResult<T> = { ok: true; data: T } | { ok: false; reason: ParseFailureReason; detail: string };

/**
 * Extracts exactly one JSON object between the BOB_DEPLOY_RESULT_BEGIN/END markers from `stdout`
 * and validates it against `schema`. Bob's own commentary before or after the markers is ignored;
 * only what's between them is parsed.
 */
export function parseBobOutput<T>(stdout: string, schema: z.ZodType<T>): ParseResult<T> {
  const beginIndex = stdout.indexOf(RESULT_BEGIN);
  const endIndex = stdout.indexOf(RESULT_END);
  if (beginIndex === -1 || endIndex === -1 || endIndex < beginIndex) {
    return { ok: false, reason: 'missing-markers', detail: `could not find both ${RESULT_BEGIN} and ${RESULT_END} in the output` };
  }
  const raw = stdout.slice(beginIndex + RESULT_BEGIN.length, endIndex).trim();

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    return { ok: false, reason: 'invalid-json', detail: err instanceof Error ? err.message : String(err) };
  }

  const result = schema.safeParse(parsed);
  if (!result.success) {
    return { ok: false, reason: 'schema-mismatch', detail: result.error.message };
  }
  return { ok: true, data: result.data };
}
