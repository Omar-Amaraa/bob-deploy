import axeCore, { type AxeResults } from 'axe-core';
import { _electron as electron, expect, test, type Page } from '@playwright/test';
import { join } from 'node:path';

const entry = join(import.meta.dirname, '..', 'dist', 'main', 'index.js');

async function audit(page: Page, label: string): Promise<void> {
  if (!(await page.evaluate(() => 'axe' in globalThis))) {
    await page.evaluate(axeCore.source);
  }
  const results = await page.evaluate(async () => {
    const axe = (
      globalThis as unknown as {
        axe: { run: (context: Document, options: object) => Promise<AxeResults> };
      }
    ).axe;
    return axe.run(document, {
      runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa', 'wcag21aa', 'wcag22aa'] },
    });
  });
  const blocking = results.violations.filter(({ impact }) => impact === 'serious' || impact === 'critical');
  if (blocking.length) {
    await test.info().attach(`${label}-axe.json`, {
      body: Buffer.from(JSON.stringify(blocking, null, 2)),
      contentType: 'application/json',
    });
  }
  expect(blocking, `${label} has serious or critical accessibility violations`).toEqual([]);
}

async function goTo(page: Page, path: string, heading: string): Promise<void> {
  await page.evaluate((nextPath) => {
    window.location.hash = `#${nextPath}`;
  }, path);
  await expect(page.getByRole('heading', { name: heading, exact: true }).first()).toBeVisible();
}

test('dashboard and settings screens meet the serious accessibility gate in both themes', async () => {
  const application = await electron.launch({
    args: [entry],
    env: { ...process.env, BOB_DEPLOY_MOCK: '1', BOB_DEPLOY_SCENARIO: 'live-own-server' },
  });
  try {
    const page = await application.firstWindow();
    const dashboardRoutes = [
      ['home', 'Home'],
      ['viewer', 'Live viewer'],
      ['analytics', 'Analytics'],
      ['health', 'Health'],
      ['memory', 'Memory use'],
      ['maintenance', 'Maintenance'],
      ['problem', 'Signal a problem'],
    ] as const;
    for (const [route, heading] of dashboardRoutes) {
      await goTo(page, `/p/project-own/${route}`, heading);
      await audit(page, `dashboard-${route}`);
    }

    await goTo(page, '/p/project-own/deploy', 'Where should Studio portfolio run?');
    await audit(page, 'deploy-target-choice');
    await page.getByRole('button', { name: 'My own server' }).click();
    await audit(page, 'deploy-own-server-form');
    await page.getByRole('button', { name: 'Choose another option' }).click();
    await page.getByRole('button', { name: 'Free hosting' }).click();
    await audit(page, 'deploy-free-host-form');

    const settingsRoutes = [
      'account',
      'bob',
      'hosting',
      'servers',
      'monitoring',
      'appearance',
      'about',
    ] as const;
    for (const route of settingsRoutes) {
      await goTo(page, `/settings/${route}`, 'Settings');
      await audit(page, `settings-${route}`);
    }

    await goTo(page, '/settings/appearance', 'Settings');
    await page.getByLabel('Dark').click();
    await expect(page.getByLabel('Dark')).toBeChecked();
    await goTo(page, '/p/project-own/home', 'Home');
    await audit(page, 'dashboard-home-dark');
    await goTo(page, '/settings/appearance', 'Settings');
    await page.getByLabel('Light').click();
    await expect(page.getByLabel('Light')).toBeChecked();
    await audit(page, 'settings-appearance-light');
  } finally {
    await application.close();
  }
});

test('account, recovery and project screens meet the serious accessibility gate', async () => {
  const fresh = await electron.launch({
    args: [entry],
    env: { ...process.env, BOB_DEPLOY_MOCK: '1', BOB_DEPLOY_SCENARIO: 'fresh' },
  });
  try {
    const page = await fresh.firstWindow();
    await audit(page, 'welcome');
    await page.getByRole('link', { name: 'Get started' }).click();
    await audit(page, 'create-account');
    await page.getByLabel('Your name').fill('Ada Example');
    await page.getByLabel('Email').fill('ada@example.test');
    await page.getByLabel('Master password').fill('Correct horse battery staple! 42');
    await page.getByLabel('Confirm password').fill('Correct horse battery staple! 42');
    await page.getByRole('checkbox').check();
    await expect(page.getByRole('button', { name: 'Create account' })).toBeEnabled();
    await page.getByRole('button', { name: 'Create account' }).click();
    await audit(page, 'recovery-code');
    await page.getByLabel('Type the last 4 characters to confirm').fill('WXYZ');
    await page.getByRole('button', { name: 'Continue' }).click();
    await audit(page, 'connect-bob');
    await page.getByRole('button', { name: 'Continue' }).click();
    await audit(page, 'connect-hosting');
    await page.getByRole('button', { name: 'Skip for now' }).click();
    await audit(page, 'all-set');
  } finally {
    await fresh.close();
  }

  const locked = await electron.launch({
    args: [entry],
    env: { ...process.env, BOB_DEPLOY_MOCK: '1', BOB_DEPLOY_SCENARIO: 'locked' },
  });
  try {
    const page = await locked.firstWindow();
    await audit(page, 'unlock');
    await page.getByRole('link', { name: 'Forgot your password?' }).click();
    await audit(page, 'recover-account');
  } finally {
    await locked.close();
  }

  const empty = await electron.launch({
    args: [entry],
    env: { ...process.env, BOB_DEPLOY_MOCK: '1', BOB_DEPLOY_SCENARIO: 'onboarded-empty' },
  });
  try {
    const page = await empty.firstWindow();
    await audit(page, 'add-project');
  } finally {
    await empty.close();
  }
});

test('reduced motion disables decorative animation', async () => {
  const application = await electron.launch({
    args: [entry],
    env: { ...process.env, BOB_DEPLOY_MOCK: '1', BOB_DEPLOY_SCENARIO: 'live-own-server' },
  });
  try {
    const page = await application.firstWindow();
    await page.emulateMedia({ reducedMotion: 'reduce' });
    const durationMs = await page.evaluate(() => {
      const container = document.createElement('div');
      const sample = document.createElement('span');
      container.className = 'skeleton';
      container.append(sample);
      document.body.append(container);
      const value = getComputedStyle(sample).animationDuration;
      container.remove();
      return value.endsWith('ms') ? Number.parseFloat(value) : Number.parseFloat(value) * 1_000;
    });
    expect(durationMs).toBeLessThanOrEqual(0.01);
  } finally {
    await application.close();
  }
});
