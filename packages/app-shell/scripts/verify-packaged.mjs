import { access, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import process from 'node:process';
import { _electron as electron } from '@playwright/test';

const appDirectory = join(import.meta.dirname, '..');
const candidates =
  process.platform === 'win32'
    ? [join(appDirectory, 'release', 'win-unpacked', 'Bob Deploy.exe')]
    : process.platform === 'darwin'
      ? [
          join(
            appDirectory,
            'release',
            process.arch === 'arm64' ? 'mac-arm64' : 'mac',
            'Bob Deploy.app',
            'Contents',
            'MacOS',
            'Bob Deploy',
          ),
          join(appDirectory, 'release', 'mac', 'Bob Deploy.app', 'Contents', 'MacOS', 'Bob Deploy'),
        ]
      : [join(appDirectory, 'release', 'linux-unpacked', 'bob-deploy')];

let executablePath;
for (const candidate of candidates) {
  try {
    await access(candidate);
    executablePath = candidate;
    break;
  } catch {
    // Try the next platform-specific output directory.
  }
}
if (!executablePath) throw new Error('The packaged Bob Deploy executable was not found.');

const userDataDirectory = await mkdtemp(join(tmpdir(), 'bob-deploy-packaged-'));
const application = await electron.launch({
  executablePath,
  args: [`--user-data-dir=${userDataDirectory}`],
  env: { ...process.env, BOB_DEPLOY_MOCK: '0' },
});
try {
  const window = await application.firstWindow();
  const status = await window.evaluate(async () => window.bobDeploy?.invoke('account:status', undefined));
  if (!status || typeof status !== 'object' || !('ok' in status) || status.ok !== true) {
    throw new Error('The packaged app did not return a successful account status.');
  }
} finally {
  await application.close();
  await rm(userDataDirectory, { recursive: true, force: true });
}
