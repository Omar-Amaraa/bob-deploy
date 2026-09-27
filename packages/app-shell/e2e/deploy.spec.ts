import { _electron as electron, expect, test, type ElectronApplication, type Page } from '@playwright/test';
import { join } from 'node:path';

const entry = join(import.meta.dirname, '..', 'dist', 'main', 'index.js');

async function launch(scenario: string): Promise<{ application: ElectronApplication; page: Page }> {
  const application = await electron.launch({
    args: [entry],
    env: { ...process.env, BOB_DEPLOY_MOCK: '1', BOB_DEPLOY_SCENARIO: scenario },
  });
  return { application, page: await application.firstWindow() };
}

async function goTo(page: Page, path: string) {
  await page.evaluate((nextPath) => {
    window.location.hash = `#${nextPath}`;
  }, path);
}

test('deploys to an own server and confirms its fingerprint', async () => {
  const { application, page } = await launch('live-own-server');
  try {
    await goTo(page, '/p/project-own/deploy');
    await page.getByRole('button', { name: 'My own server' }).click();
    await page.getByLabel('Domain', { exact: true }).fill('new.example.com');
    await page.getByLabel('Server IP', { exact: true }).fill('203.0.113.20');
    const password = page.getByRole('textbox', { name: 'Password', exact: true });
    await password.fill('not-kept-after-switching');
    await page.getByRole('radio', { name: 'Key file' }).click();
    await page.getByRole('radio', { name: 'Password' }).click();
    await expect(password).toHaveValue('');
    await password.fill('one-time-password');
    await expect(page.getByLabel('Certificate email')).toHaveValue('ada@example.test');
    await page.getByRole('button', { name: 'Check DNS' }).click();
    await expect(page.getByText('Your domain points to this server', { exact: false })).toBeVisible();
    await page.getByRole('button', { name: 'Review setup' }).click();
    await expect(page.getByRole('heading', { name: 'Set up your server' })).toBeVisible();
    await expect(page.getByText('Password ••••')).toBeVisible();
    await page.getByRole('button', { name: 'Start setup' }).click();
    await expect(page.getByRole('heading', { name: 'Confirm this server' })).toBeVisible();
    await expect(page.getByText('SHA256:mockFingerprint')).toBeVisible();
    await page.getByRole('button', { name: 'Continue' }).click();
    await expect(page.getByRole('heading', { name: 'Your site is ready' })).toBeVisible();
  } finally {
    await application.close();
  }
});

test('deploys a project to a connected free host', async () => {
  const { application, page } = await launch('live-free-host');
  try {
    await goTo(page, '/p/project-free/deploy');
    await page.getByRole('button', { name: 'Free hosting' }).click();
    await expect(page.getByText('Connected as Ada Example')).toBeVisible();
    await page.getByRole('button', { name: 'Review deployment' }).click();
    await expect(page.getByRole('heading', { name: 'Publish with free hosting' })).toBeVisible();
    await page.getByRole('button', { name: 'Deploy', exact: true }).click();
    await expect(page.getByRole('heading', { name: 'Your site is ready' })).toBeVisible();
  } finally {
    await application.close();
  }
});

test('shows Bob changes during an update', async () => {
  const { application, page } = await launch('live-own-server');
  try {
    await goTo(page, '/p/project-own/home');
    await page.getByRole('button', { name: 'Update', exact: true }).click();
    await expect(page.getByRole('heading', { name: 'What Bob changed' })).toBeVisible();
    await expect(page.getByText('src/app.ts')).toBeVisible();
    await expect(page.getByText('pnpm test')).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Your site is ready' })).toBeVisible();
  } finally {
    await application.close();
  }
});

test('shows the rollback banner when an update fails', async () => {
  const { application, page } = await launch('failed-update');
  try {
    await goTo(page, '/p/project-own/home');
    await page.getByRole('button', { name: 'Update', exact: true }).click();
    await expect(page.getByRole('heading', { name: 'The previous version is still live' })).toBeVisible();
    await expect(page.getByText('The update could not be prepared.')).toBeVisible();
  } finally {
    await application.close();
  }
});

test('blocks deployment until Bob and the selected free host are connected', async () => {
  const missingBob = await launch('bob-missing');
  try {
    await goTo(missingBob.page, '/p/project-own/deploy');
    await expect(missingBob.page.getByRole('heading', { name: 'Connect Bob first' })).toBeVisible();
    await expect(missingBob.page.getByRole('link', { name: 'Open Bob settings' })).toHaveAttribute(
      'href',
      '#/settings/bob',
    );
  } finally {
    await missingBob.application.close();
  }

  const missingHost = await launch('live-own-server');
  try {
    await goTo(missingHost.page, '/p/project-own/deploy');
    await missingHost.page.getByRole('button', { name: 'Free hosting' }).click();
    await missingHost.page.getByRole('radio', { name: /Vercel/ }).click();
    await expect(missingHost.page.getByRole('heading', { name: 'Connect Vercel first' })).toBeVisible();
    await expect(missingHost.page.getByRole('button', { name: 'Review deployment' })).toBeDisabled();
  } finally {
    await missingHost.application.close();
  }
});
