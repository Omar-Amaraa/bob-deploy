import { describe, expect, it } from 'vitest';
import { PACKAGE } from './index.js';

describe('@bob-deploy/agent', () => {
  it('exports its package name', () => {
    expect(PACKAGE).toBe('@bob-deploy/agent');
  });
});
