import { _electron as electron, expect, test } from '@playwright/test';
import { join } from 'node:path';

test('opens the hardened shell in mock mode', async () => {
  const application = await electron.launch({
    args: [join(import.meta.dirname, '..', 'dist', 'main', 'index.js')],
    env: { ...process.env, BOB_DEPLOY_MOCK: '1' },
  });

  try {
    const window = await application.firstWindow();
    await expect(window.getByRole('heading', { name: 'Home' })).toBeVisible();
    await expect(window.getByRole('navigation', { name: 'Project sections' })).toBeVisible();
    await expect(window.getByRole('link', { name: 'Live viewer' })).toBeVisible();
  } finally {
    await application.close();
  }
});

test('selects a project folder through the Electron bridge', async () => {
  const application = await electron.launch({
    args: [join(import.meta.dirname, '..', 'dist', 'main', 'index.js')],
    env: { ...process.env, BOB_DEPLOY_MOCK: '1', BOB_DEPLOY_SCENARIO: 'onboarded-empty' },
  });

  try {
    await application.evaluate(({ dialog }) => {
      dialog.showOpenDialog = () =>
        Promise.resolve({
          canceled: false,
          filePaths: ['C:\\Sites\\folder-picker-smoke'],
        });
    });
    const window = await application.firstWindow();
    await window.getByRole('button', { name: 'Choose your project folder' }).click();
    await expect(window.getByText('C:\\Sites\\folder-picker-smoke')).toBeVisible();
    await expect(window.getByLabel('Name')).toHaveValue('folder-picker-smoke');
    await expect(window.getByRole('button', { name: 'Add project' })).toBeEnabled();
  } finally {
    await application.close();
  }
});
