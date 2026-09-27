import { describe, expect, it } from 'vitest';
import { PACKAGE } from './index.js';

describe('@bob-deploy/ssh-playbooks', () => {
  it('exports its package name', () => {
    expect(PACKAGE).toBe('@bob-deploy/ssh-playbooks');
  });
});
