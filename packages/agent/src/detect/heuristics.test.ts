import { describe, it, expect } from 'vitest';
import { join } from 'node:path';
import { detectHeuristic } from './heuristics.js';

const SAMPLES = join(__dirname, '__samples__');

describe('detectHeuristic', () => {
  it('detects Vite as static with dist output', async () => {
    const r = await detectHeuristic(join(SAMPLES, 'vite'));
    expect(r.stack.type).toBe('static');
    expect(r.stack.framework).toBe('vite');
    expect(r.stack.outputDir).toBe('dist');
    expect(r.stack.needsBackend).toBe(false);
    expect(r.confidence).toBeGreaterThanOrEqual(0.9);
  });

  it('detects Create React App as static with build output', async () => {
    const r = await detectHeuristic(join(SAMPLES, 'cra'));
    expect(r.stack.type).toBe('static');
    expect(r.stack.framework).toBe('cra');
    expect(r.stack.outputDir).toBe('build');
    expect(r.confidence).toBeGreaterThanOrEqual(0.9);
  });

  it('detects Astro as static with dist output', async () => {
    const r = await detectHeuristic(join(SAMPLES, 'astro'));
    expect(r.stack.type).toBe('static');
    expect(r.stack.framework).toBe('astro');
    expect(r.stack.outputDir).toBe('dist');
    expect(r.confidence).toBeGreaterThanOrEqual(0.9);
  });

  it('trusts a plain HTML project (index.html, nothing server-side) without asking Bob', async () => {
    const r = await detectHeuristic(join(SAMPLES, 'plain-html'));
    expect(r.stack.type).toBe('static');
    expect(r.stack.needsBackend).toBe(false);
    expect(r.stack.outputDir).toBe('.');
    expect(r.confidence).toBeGreaterThanOrEqual(0.9);
  });

  it('detects a static-export Next.js app as static, not needing a backend', async () => {
    const r = await detectHeuristic(join(SAMPLES, 'next-static'));
    expect(r.stack.type).toBe('static');
    expect(r.stack.framework).toBe('nextjs');
    expect(r.stack.needsBackend).toBe(false);
    expect(r.stack.outputDir).toBe('out');
    expect(r.confidence).toBeGreaterThanOrEqual(0.9);
  });

  it('detects an SSR Next.js app as node, needing a backend', async () => {
    const r = await detectHeuristic(join(SAMPLES, 'next-ssr'));
    expect(r.stack.type).toBe('node');
    expect(r.stack.framework).toBe('nextjs');
    expect(r.stack.needsBackend).toBe(true);
    expect(r.confidence).toBeGreaterThanOrEqual(0.9);
  });

  it('detects Express as node', async () => {
    const r = await detectHeuristic(join(SAMPLES, 'express'));
    expect(r.stack.type).toBe('node');
    expect(r.stack.framework).toBe('express');
    expect(r.stack.needsBackend).toBe(true);
    expect(r.stack.startCmd).toBe('npm start');
    // the sample has no package-lock.json, so Bob still gets asked
    expect(r.confidence).toBeLessThan(0.9);
  });

  it('detects Flask as python with a gunicorn app:app start command', async () => {
    const r = await detectHeuristic(join(SAMPLES, 'flask'));
    expect(r.stack.type).toBe('python');
    expect(r.stack.framework).toBe('flask');
    expect(r.stack.startCmd).toBe('.venv/bin/gunicorn app:app --bind 127.0.0.1:$PORT');
    expect(r.confidence).toBeGreaterThanOrEqual(0.9);
  });

  it('detects FastAPI as python with a uvicorn main:app start command', async () => {
    const r = await detectHeuristic(join(SAMPLES, 'fastapi'));
    expect(r.stack.type).toBe('python');
    expect(r.stack.framework).toBe('fastapi');
    expect(r.stack.startCmd).toBe('.venv/bin/uvicorn main:app --host 127.0.0.1 --port $PORT');
    expect(r.confidence).toBeGreaterThanOrEqual(0.9);
  });

  it('detects Django as python needing a backend', async () => {
    const r = await detectHeuristic(join(SAMPLES, 'django'));
    expect(r.stack.type).toBe('python');
    expect(r.stack.framework).toBe('django');
    expect(r.stack.needsBackend).toBe(true);
  });

  it('returns zero confidence for a directory with no recognised markers', async () => {
    const r = await detectHeuristic(SAMPLES); // the __samples__ dir itself has no package.json etc.
    expect(r.confidence).toBe(0);
    expect(r.stack).toEqual({});
  });
});
