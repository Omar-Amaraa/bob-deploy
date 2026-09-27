import { describe, it, expect } from 'vitest';
import { scorePassword } from './password-strength.js';

describe('scorePassword', () => {
  it('scores common/weak passwords low, even without extra userInputs', () => {
    expect(scorePassword('password123456').score).toBeLessThan(3);
  });

  it('scores a product-name password low once product userInputs are supplied', () => {
    expect(scorePassword('bobdeploy2026!', ['bob', 'deploy', 'bobdeploy']).score).toBeLessThan(3);
  });

  it('scores a repeated display name low once it is supplied as a userInput', () => {
    expect(scorePassword('AliceAliceAliceAlice', ['Alice']).score).toBeLessThan(3);
  });

  it('scores a strong random passphrase highly', () => {
    expect(scorePassword('correct-horse-battery-Staple-42', ['bob', 'deploy', 'bobdeploy']).score).toBeGreaterThanOrEqual(3);
  });
});
