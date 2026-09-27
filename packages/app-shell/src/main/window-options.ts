import type { BrowserWindowConstructorOptions } from 'electron';

interface MainWindowOptionsInput {
  preloadPath: string;
  appVersion: string;
  mock: boolean;
  /** BOB_DEPLOY_TESTBED=1 in the main process (DEC-020). Forwarded read-only so the sandboxed
   * renderer's form validation matches the main process; the UI can never switch it on. */
  testbed?: boolean;
}

export function createMainWindowOptions({
  preloadPath,
  appVersion,
  mock,
  testbed = false,
}: MainWindowOptionsInput): BrowserWindowConstructorOptions {
  return {
    width: 1280,
    height: 800,
    minWidth: 960,
    minHeight: 640,
    title: 'Bob Deploy',
    titleBarStyle: 'default',
    show: false,
    webPreferences: {
      preload: preloadPath,
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      webSecurity: true,
      webviewTag: true,
      spellcheck: false,
      additionalArguments: [
        `--bob-app-version=${appVersion}`,
        `--bob-mock=${mock ? '1' : '0'}`,
        `--bob-testbed=${testbed ? '1' : '0'}`,
      ],
    },
  };
}
