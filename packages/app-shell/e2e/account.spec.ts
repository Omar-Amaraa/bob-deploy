import { _electron as electron, expect, test } from '@playwright/test';
import { join } from 'node:path';

const entry = join(import.meta.dirname, '..', 'dist', 'main', 'index.js');

test('completes onboarding in mock mode', async () => {
  const application = await electron.launch({
    args: [entry],
    env: { ...process.env, BOB_DEPLOY_MOCK: '1', BOB_DEPLOY_SCENARIO: 'fresh' },
  });
  try {
    const window = await application.firstWindow();
    await window.getByRole('link', { name: 'Get started' }).click();
    await window.getByLabel('Your name').fill('Ada Example');
    await window.getByLabel('Email').fill('ada@example.test');
    await window.getByLabel('Master password').fill('Correct horse battery staple! 42');
    await window.getByLabel('Confirm password').fill('Correct horse battery staple! 42');
    await window.getByRole('checkbox').check();
    await expect(window.getByRole('button', { name: 'Create account' })).toBeEnabled();
    await window.getByRole('button', { name: 'Create account' }).click();
    await window.getByLabel('Type the last 4 characters to confirm').fill('WXYZ');
    await window.getByRole('button', { name: 'Continue' }).click();
    await expect(window.getByRole('heading', { name: 'Connect Bob' })).toBeVisible();
    await window.getByRole('button', { name: 'Check again' }).click();
    await expect(window.locator('.check-results li')).toHaveCount(4);
    await expect(window.getByText('Bob found.')).toBeVisible();
    await window.getByRole('button', { name: 'Continue' }).click();
    await expect(window.getByRole('heading', { name: 'Free hosting (optional)' })).toBeVisible();
    await window.getByRole('button', { name: 'Skip for now' }).click();
    await expect(window.getByRole('heading', { name: 'All set' })).toBeVisible();
  } finally {
    await application.close();
  }
});

test('unlocks with the right password after rejecting a wrong one', async () => {
  const application = await electron.launch({
    args: [entry],
    env: { ...process.env, BOB_DEPLOY_MOCK: '1', BOB_DEPLOY_SCENARIO: 'locked' },
  });
  try {
    const window = await application.firstWindow();
    const password = window.getByLabel('Master password');
    await expect(password).toBeFocused();
    await password.fill('wrong password');
    await window.getByRole('button', { name: 'Unlock' }).click();
    await expect(window.getByText('That password is not right.')).toBeVisible();
    await password.fill('correct horse battery staple');
    await window.getByRole('button', { name: 'Unlock' }).click();
    await expect(window.getByRole('heading', { name: /Welcome back/ })).toBeHidden();
  } finally {
    await application.close();
  }
});
