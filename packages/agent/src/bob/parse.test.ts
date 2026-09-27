import { describe, it, expect } from 'vitest';
import { z } from 'zod';
import { parseBobOutput } from './parse.js';
import { RESULT_BEGIN, RESULT_END } from '../prompts/output-contract.js';

const schema = z.object({ ok: z.boolean(), value: z.string() });

describe('parseBobOutput', () => {
  it('parses a valid result between the markers, ignoring surrounding commentary', () => {
    const stdout = `Sure, here is my answer.\n${RESULT_BEGIN}\n${JSON.stringify({ ok: true, value: 'x' })}\n${RESULT_END}\nThanks!`;
    const result = parseBobOutput(stdout, schema);
    expect(result).toEqual({ ok: true, data: { ok: true, value: 'x' } });
  });

  it('reports missing-markers when the begin marker is absent', () => {
    const stdout = `${JSON.stringify({ ok: true, value: 'x' })}\n${RESULT_END}`;
    const result = parseBobOutput(stdout, schema);
    expect(result.ok).toBe(false);
    expect(!result.ok && result.reason).toBe('missing-markers');
  });

  it('reports missing-markers when the end marker is absent', () => {
    const stdout = `${RESULT_BEGIN}\n${JSON.stringify({ ok: true, value: 'x' })}`;
    const result = parseBobOutput(stdout, schema);
    expect(result.ok).toBe(false);
    expect(!result.ok && result.reason).toBe('missing-markers');
  });

  it('reports invalid-json for malformed JSON between the markers', () => {
    const stdout = `${RESULT_BEGIN}\n{ this is not json }\n${RESULT_END}`;
    const result = parseBobOutput(stdout, schema);
    expect(result.ok).toBe(false);
    expect(!result.ok && result.reason).toBe('invalid-json');
  });

  it('reports schema-mismatch for well-formed JSON that fails validation', () => {
    const stdout = `${RESULT_BEGIN}\n${JSON.stringify({ ok: 'not-a-boolean' })}\n${RESULT_END}`;
    const result = parseBobOutput(stdout, schema);
    expect(result.ok).toBe(false);
    expect(!result.ok && result.reason).toBe('schema-mismatch');
  });

  it('handles extra text between the markers alongside the JSON by failing to parse', () => {
    const stdout = `${RESULT_BEGIN}\nHere you go: ${JSON.stringify({ ok: true, value: 'x' })}\n${RESULT_END}`;
    const result = parseBobOutput(stdout, schema);
    expect(result.ok).toBe(false);
    expect(!result.ok && result.reason).toBe('invalid-json');
  });
});
