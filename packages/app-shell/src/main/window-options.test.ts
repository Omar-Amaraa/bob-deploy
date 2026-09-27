import { describe, expect, it } from 'vitest';
import { createMainWindowOptions } from './window-options.js';

describe('main window security', () => {
  it('enables every S15 isolation flag', () => {
    const options = createMainWindowOptions({
      preloadPath: '/safe/preload.mjs',
      appVersion: '1.2.3',
      mock: true,
    });

    expect(options).toMatchObject({ width: 1280, height: 800, minWidth: 960, minHeight: 640 });
    expect(options.webPreferences).toMatchObject({
      preload: '/safe/preload.mjs',
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      webSecurity: true,
      webviewTag: true,
      spellcheck: false,
    });
    expect(options.webPreferences?.additionalArguments).toContain('--bob-mock=1');
    expect(options.webPreferences?.additionalArguments).toContain('--bob-testbed=0');
  });

  it('forwards testbed mode to the renderer only when asked', () => {
    const options = createMainWindowOptions({
      preloadPath: '/safe/preload.mjs',
      appVersion: '1.2.3',
      mock: false,
      testbed: true,
    });
    expect(options.webPreferences?.additionalArguments).toContain('--bob-testbed=1');
  });
});
