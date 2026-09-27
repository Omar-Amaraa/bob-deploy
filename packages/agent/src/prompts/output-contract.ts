import { zodToJsonSchema } from 'zod-to-json-schema';
import type { z } from 'zod';

export const RESULT_BEGIN = 'BOB_DEPLOY_RESULT_BEGIN';
export const RESULT_END = 'BOB_DEPLOY_RESULT_END';

/**
 * Renders the fixed output-contract text (spec section 4c): exactly one JSON object between the
 * BEGIN/END markers, matching the JSON schema generated from the given zod schema.
 */
export function renderOutputContract(schema: z.ZodType, schemaName: string): string {
  const jsonSchema: unknown = zodToJsonSchema(schema, schemaName);
  return [
    `Reply with exactly one JSON object between the lines ${RESULT_BEGIN} and ${RESULT_END},`,
    'matching this JSON schema. Do not include any other text between those two lines.',
    '',
    JSON.stringify(jsonSchema, null, 2),
  ].join('\n');
}
