import { _electron as electron, expect, test } from '@playwright/test';
import { createServer } from 'node:http';
import { join } from 'node:path';

test('loads a local site in the isolated live viewer', async () => {
  const server = createServer((_request, response) => {
    response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    response.end('<!doctype html><title>Viewer fixture</title><h1>Local viewer site</h1>');
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('The viewer test server did not start.');
  const siteUrl = `http://127.0.0.1:${address.port}/`;
  const application = await electron.launch({
    args: [join(import.meta.dirname, '..', 'dist', 'main', 'index.js')],
    env: { ...process.env, BOB_DEPLOY_MOCK: '1', BOB_DEPLOY_VIEWER_URL: siteUrl },
  });

  try {
    const window = await application.firstWindow();
    await window.getByRole('link', { name: 'Live viewer' }).click();
    await expect(window.locator('webview')).toHaveAttribute('partition', 'persist:liveviewer');
    await expect(window.getByLabel('Current address')).toHaveValue(siteUrl);
    await expect.poll(() => application.evaluate(({ webContents }) => webContents.getAllWebContents().find((contents) => contents.getType() === 'webview')?.getURL())).toBe(siteUrl);
    await expect.poll(() => application.evaluate(async ({ webContents }) => {
      const viewer = webContents.getAllWebContents().find((contents) => contents.getType() === 'webview');
      return viewer ? viewer.executeJavaScript('document.title') as Promise<string> : '';
    })).toBe('Viewer fixture');
  } finally {
    await application.close();
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
});
