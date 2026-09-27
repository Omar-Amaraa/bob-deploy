import { describe, it, expect } from 'vitest';
import { join } from 'node:path';
import { START_CMD_PATTERN } from '@bob-deploy/contracts';
import { detectHeuristic } from './heuristics.js';

/**
 * examples/own-server/* are the documented "deploys without surprises" layouts. Each must be
 * recognised by the local heuristics at >= 0.9 confidence (the threshold where a failed or slow Bob
 * call can no longer block the deploy) with the exact stack the server scripts expect.
 */
const EXAMPLES = join(__dirname, '..', '..', '..', '..', 'examples', 'own-server');

describe('examples/own-server templates', () => {
  it.each([
    ['static-html', { type: 'static', outputDir: '.', needsBackend: false }],
    ['vite-site', { type: 'static', framework: 'vite', outputDir: 'dist', buildCmd: 'vite build', installCmd: 'npm ci' }],
    ['node-express', { type: 'node', framework: 'express', startCmd: 'npm start', installCmd: 'npm ci', runtimeVersion: '20' }],
    ['python-flask', { type: 'python', framework: 'flask', startCmd: '.venv/bin/gunicorn app:app --bind 127.0.0.1:$PORT' }],
    ['python-fastapi', { type: 'python', framework: 'fastapi', startCmd: '.venv/bin/uvicorn main:app --host 127.0.0.1 --port $PORT' }],
  ])('%s is detected confidently, without needing Bob', async (name, expected) => {
    const r = await detectHeuristic(join(EXAMPLES, name));
    expect(r.confidence).toBeGreaterThanOrEqual(0.9);
    expect(r.stack).toMatchObject(expected);
    if (r.stack.type !== 'static') expect(r.stack.startCmd).toMatch(START_CMD_PATTERN);
  });
});
