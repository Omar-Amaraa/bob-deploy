import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { mkdir } from 'node:fs/promises';
import type { CoreHandle, CreateCore, CreateMonitorService, HostProvider } from '@bob-deploy/contracts';
import { app, BrowserWindow, dialog, ipcMain, safeStorage, session, shell, type WebContents } from 'electron';
import { ipcHostFromElectron } from './ipc-host.js';
import {
  CONTENT_SECURITY_POLICY,
  hardenWebviewPreferences,
  isAllowedExternalUrl,
  isSameAppNavigation,
  isViewerNavigationAllowed,
} from './security.js';
import { SHELL_CHANNELS } from '../shared/bridge.js';
import { logsDirectory, registerShellHandlers } from './shell-handlers.js';
import { createMainWindowOptions } from './window-options.js';
import {
  isTestbedSiteUrl,
  parseTestbedHttpsPort,
  testbedHostResolverRules,
} from './testbed-network.js';

const currentDirectory = dirname(fileURLToPath(import.meta.url));
const testbedMode = process.env['BOB_DEPLOY_TESTBED'] === '1';
const testbedHttpsPort = parseTestbedHttpsPort(process.env['BOB_DEPLOY_TESTBED_HTTPS_PORT']);
let mainWindow: BrowserWindow | undefined;
let coreHandle: CoreHandle | undefined;

// Chromium's mapped resolver preserves the original Host header and TLS server name while routing
// *.bd.test to Docker's published HTTPS port. It is set before `ready`, and never enabled outside
// the explicit testbed mode.
if (testbedMode) {
  app.commandLine.appendSwitch('host-resolver-rules', testbedHostResolverRules(testbedHttpsPort));
}

interface RuntimeModules {
  createCore: CreateCore;
  monitorFactory?: CreateMonitorService;
  hostProviders?: HostProvider[];
}

async function resolveRuntime(): Promise<{ mock: boolean; modules?: RuntimeModules }> {
  const requestedMock = process.env.BOB_DEPLOY_MOCK ?? (app.isPackaged ? '0' : '1');
  if (requestedMock === '1') return { mock: true };

  const [coreModule, monitorModule, providerModule] = await Promise.all([
    import('@bob-deploy/core'),
    import('@bob-deploy/monitors'),
    import('@bob-deploy/providers'),
  ]);
  const createCore = (coreModule as unknown as { createCore?: CreateCore }).createCore;
  if (!createCore) {
    throw new Error('The Bob Deploy core could not be loaded.');
  }

  const createMonitorService = (monitorModule as unknown as { createMonitorService?: CreateMonitorService })
    .createMonitorService;
  const providers = providerModule as unknown as {
    netlifyProvider?: () => HostProvider;
    vercelProvider?: () => HostProvider;
  };
  const hostProviders = [providers.netlifyProvider?.(), providers.vercelProvider?.()].filter(
    (provider): provider is HostProvider => provider !== undefined,
  );

  return {
    mock: false,
    modules: {
      createCore,
      monitorFactory: createMonitorService,
      hostProviders,
    },
  };
}

function applyContentSecurityPolicy(): void {
  session.defaultSession.webRequest.onHeadersReceived((details, callback) => {
    const headers = { ...details.responseHeaders };
    headers['Content-Security-Policy'] = [CONTENT_SECURITY_POLICY];
    callback({ responseHeaders: headers });
  });
}

function guardWebContents(contents: WebContents): void {
  if (contents.getType() === 'webview') {
    let siteUrl = contents.getURL();
    const isAllowed = (target: string) => {
      if (!siteUrl) {
        try {
          const parsed = new URL(target);
          if (!['http:', 'https:'].includes(parsed.protocol)) return false;
          siteUrl = target;
          return true;
        } catch {
          return false;
        }
      }
      return isViewerNavigationAllowed(target, siteUrl);
    };
    const openOutside = (target: string) => {
      if (!isAllowedExternalUrl(target)) return;
      void shell.openExternal(target);
      contents.hostWebContents?.send(SHELL_CHANNELS.viewerExternalOpened);
    };

    contents.setWindowOpenHandler(({ url }) => {
      if (isAllowed(url)) void contents.loadURL(url);
      else openOutside(url);
      return { action: 'deny' };
    });
    contents.on('will-navigate', (event, target) => {
      if (isAllowed(target)) return;
      event.preventDefault();
      openOutside(target);
    });
    contents.on('will-redirect', (event, target) => {
      if (!isAllowed(target)) event.preventDefault();
    });
    return;
  }

  contents.setWindowOpenHandler(() => ({ action: 'deny' }));
  contents.on('will-navigate', (event, target) => {
    const current = contents.getURL();
    // Electron emits will-navigate for the main-process-controlled first load while getURL() is blank.
    // After that bootstrap navigation, keep the contents inside its established app origin.
    if (current && !isSameAppNavigation(target, current)) event.preventDefault();
  });
  contents.on('will-attach-webview', (_event, preferences) => {
    hardenWebviewPreferences(preferences);
  });
}

async function createWindow(mock: boolean): Promise<BrowserWindow> {
  // Sandboxed preload scripts run as CommonJS in Electron. Loading an ESM
  // preload here silently leaves window.bobDeploy undefined in the renderer.
  const preloadPath = join(currentDirectory, '../preload/index.cjs');
  const window = new BrowserWindow(
    createMainWindowOptions({
      preloadPath,
      appVersion: app.getVersion(),
      mock,
      testbed: testbedMode,
    }),
  );
  window.once('ready-to-show', () => window.show());

  const developmentUrl = process.env.ELECTRON_RENDERER_URL;
  const scenario = process.env.BOB_DEPLOY_SCENARIO;
  const viewerUrl = process.env.BOB_DEPLOY_VIEWER_URL;
  if (developmentUrl) {
    const target = new URL(developmentUrl);
    if (scenario) target.searchParams.set('scenario', scenario);
    if (viewerUrl) target.searchParams.set('viewerUrl', viewerUrl);
    await window.loadURL(target.toString());
  } else {
    const query = { ...(scenario ? { scenario } : {}), ...(viewerUrl ? { viewerUrl } : {}) };
    await window.loadFile(
      join(currentDirectory, '../renderer/index.html'),
      Object.keys(query).length ? { query } : undefined,
    );
  }

  return window;
}

async function startCore(modules: RuntimeModules): Promise<void> {
  const core = await modules.createCore({
    dataDir: app.getPath('userData'),
    keyProtector: {
      isAvailable: () => safeStorage.isEncryptionAvailable(),
      encryptString: (value) => safeStorage.encryptString(value),
      decryptString: (value) => safeStorage.decryptString(value),
    },
    appVersion: app.getVersion(),
    monitorFactory: modules.monitorFactory,
    hostProviders: modules.hostProviders,
  });
  core.registerIpc(ipcHostFromElectron(ipcMain, () => mainWindow?.webContents));
  coreHandle = core;
}

async function showStartupError(): Promise<void> {
  const directory = logsDirectory(app.getPath('userData'));
  const result = await dialog.showMessageBox({
    type: 'error',
    title: 'Bob Deploy could not start',
    message: 'Bob Deploy could not start.',
    detail: 'Details are in the log. You can open the logs folder now or quit.',
    buttons: ['Open logs folder', 'Quit'],
    defaultId: 0,
    cancelId: 1,
    noLink: true,
  });
  if (result.response === 0) {
    await mkdir(directory, { recursive: true });
    await shell.openPath(directory);
  }
}

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (!mainWindow) return;
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.focus();
  });

  app.on('web-contents-created', (_event, contents) => guardWebContents(contents));

  app.on('certificate-error', (event, contents, url, _error, _certificate, callback) => {
    const isViewer =
      contents.getType() === 'webview' &&
      contents.session === session.fromPartition('persist:liveviewer');
    if (testbedMode && isViewer && isTestbedSiteUrl(url)) {
      event.preventDefault();
      callback(true);
      return;
    }
    callback(false);
  });

  void app
    .whenReady()
    .then(async () => {
      const runtime = await resolveRuntime();
      applyContentSecurityPolicy();
      registerShellHandlers(ipcMain, () => logsDirectory(app.getPath('userData')));
      // Core first: its IPC handlers must exist before the renderer's first request. Opening the
      // window first raced them — the first account:status failed ("No handler registered"), the
      // UI took that as "no account", went to /welcome, then saw the account and jumped to
      // /welcome/bob ("Connect Bob") without ever asking to unlock.
      if (runtime.modules) await startCore(runtime.modules);
      mainWindow = await createWindow(runtime.mock);

      app.on('activate', () => {
        if (BrowserWindow.getAllWindows().length === 0) {
          void createWindow(runtime.mock).then((window) => {
            mainWindow = window;
          });
        }
      });
    })
    .catch(async (error: unknown) => {
      console.error('Bob Deploy could not start.', error);
      await showStartupError();
      app.quit();
    });

  app.on('before-quit', () => {
    void coreHandle?.shutdown();
  });

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit();
  });
}
