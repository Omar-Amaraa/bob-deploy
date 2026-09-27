import { contextBridge, ipcRenderer } from 'electron';
import { createBridge } from './bridge.js';

function argument(name: string): string | undefined {
  return process.argv.find((value) => value.startsWith(`${name}=`))?.slice(name.length + 1);
}

const platform = process.platform;
if (platform !== 'win32' && platform !== 'darwin' && platform !== 'linux') {
  throw new Error('Unsupported desktop platform.');
}

contextBridge.exposeInMainWorld(
  'bobDeploy',
  createBridge(ipcRenderer, {
    platform,
    appVersion: argument('--bob-app-version') ?? '0.0.0',
    mock: argument('--bob-mock') !== '0',
  }),
);

// Testbed mode (DEC-020) is read from process.env by @bob-deploy/contracts' isTestbedMode(), but a
// sandboxed, context-isolated renderer has no `process`, so the deploy form rejected 127.0.0.1 even
// when the app ran with BOB_DEPLOY_TESTBED=1. Mirror just that one flag, frozen, and only when the
// main process launched in testbed mode.
if (argument('--bob-testbed') === '1') {
  contextBridge.exposeInMainWorld('process', Object.freeze({ env: Object.freeze({ BOB_DEPLOY_TESTBED: '1' }) }));
}
