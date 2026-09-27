import { _electron as electron, expect, test } from '@playwright/test';
import { join } from 'node:path';

const entry = join(import.meta.dirname, '..', 'dist', 'main', 'index.js');

test('requires the master password before revealing the server key passphrase', async () => {
  const application = await electron.launch({
    args: [entry],
    env: { ...process.env, BOB_DEPLOY_MOCK: '1', BOB_DEPLOY_SCENARIO: 'live-own-server' },
  });
  try {
    const window = await application.firstWindow();
    await window.getByRole('button', { name: 'Settings' }).click();
    await window.getByRole('link', { name: 'Servers and keys' }).click();
    await window.getByRole('button', { name: 'Show key passphrase' }).click();
    const password = window.getByRole('dialog').getByLabel('Master password');
    await expect(password).toBeFocused();
    await password.fill('wrong password');
    await window.getByRole('button', { name: 'Show passphrase' }).click();
    await expect(window.getByText('That password is not right.')).toBeVisible();
    await password.fill('correct horse battery staple');
    await window.getByRole('button', { name: 'Show passphrase' }).click();
    await expect(window.getByText('amber-lantern-orbit-meadow-cobalt-river-sparrow')).toBeVisible();
    await expect(window.getByText(/Hidden again in 30 seconds/)).toBeVisible();
  } finally {
    await application.close();
  }
});

test('moves through the sidebar and opens sections using only the keyboard', async () => {
  const application = await electron.launch({
    args: [entry],
    env: { ...process.env, BOB_DEPLOY_MOCK: '1', BOB_DEPLOY_SCENARIO: 'live-own-server' },
  });
  try {
    const window = await application.firstWindow();
    const home = window.getByRole('link', { name: 'Home' });
    await home.focus();
    await expect(home).toBeFocused();
    await window.keyboard.press('ArrowDown');
    const viewer = window.getByRole('link', { name: 'Live viewer' });
    await expect(viewer).toBeFocused();
    await window.keyboard.press('Enter');
    await expect(window.getByRole('heading', { name: 'Live viewer' })).toBeVisible();
    await window.keyboard.press(process.platform === 'darwin' ? 'Meta+3' : 'Control+3');
    await expect(window.getByRole('heading', { name: 'Analytics' })).toBeVisible();
    await window.getByRole('link', { name: 'Signal a problem' }).focus();
    await window.keyboard.press('Enter');
    await expect(window.getByRole('heading', { name: 'Signal a problem' })).toBeVisible();
  } finally {
    await application.close();
  }
});
