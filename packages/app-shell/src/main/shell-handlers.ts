import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  BrowserWindow,
  dialog,
  type IpcMain,
  type IpcMainInvokeEvent,
  session,
  shell,
} from 'electron';
import { z } from 'zod';
import { SHELL_CHANNELS } from '../shared/bridge.js';
import { isAllowedExternalUrl } from './security.js';

const pickFileSchema = z.object({
  title: z.string().min(1).max(120),
  filters: z
    .array(z.object({ name: z.string().min(1), extensions: z.array(z.string().regex(/^[a-z0-9]+$/i)) }))
    .optional(),
});
const saveTextFileSchema = z.object({
  defaultName: z.string().min(1).max(160).regex(/^[^/\\]+$/),
  content: z.string().max(1_000_000),
});
const printTextSchema = z.object({ title: z.string().min(1).max(120), content: z.string().max(1_000_000) });
const externalUrlSchema = z.string().refine(isAllowedExternalUrl, 'Only HTTPS links are allowed.');

function escapeHtml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#039;');
}

async function printPlainText(input: z.infer<typeof printTextSchema>): Promise<void> {
  const printWindow = new BrowserWindow({
    show: false,
    webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false },
  });
  const document = `<!doctype html><meta charset="utf-8"><title>${escapeHtml(input.title)}</title><style>body{font:16px system-ui;padding:32px}pre{white-space:pre-wrap;font:16px ui-monospace,monospace}@media print{body{padding:0}}</style><h1>${escapeHtml(input.title)}</h1><pre>${escapeHtml(input.content)}</pre>`;
  await printWindow.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(document)}`);
  await new Promise<void>((resolve, reject) => {
    printWindow.webContents.print({ silent: false, printBackground: false }, (success, reason) => {
      if (success) resolve();
      else reject(new Error(reason || 'Printing was cancelled.'));
    });
  }).finally(() => printWindow.close());
}

function validateSender(event: IpcMainInvokeEvent): void {
  if (!event.senderFrame) throw new Error('The request did not come from the app.');
  const protocol = new URL(event.senderFrame.url).protocol;
  if (protocol !== 'file:' && protocol !== 'http:' && protocol !== 'https:') {
    throw new Error('The request did not come from the app.');
  }
}

export function registerShellHandlers(ipcMain: IpcMain, getLogsDirectory: () => string): void {
  ipcMain.handle(SHELL_CHANNELS.pickFolder, async (event) => {
    validateSender(event);
    const parent = BrowserWindow.fromWebContents(event.sender);
    const result = parent
      ? await dialog.showOpenDialog(parent, { properties: ['openDirectory'] })
      : await dialog.showOpenDialog({ properties: ['openDirectory'] });
    return result.canceled ? null : (result.filePaths[0] ?? null);
  });

  ipcMain.handle(SHELL_CHANNELS.pickFile, async (event, raw) => {
    validateSender(event);
    const options = pickFileSchema.parse(raw);
    const result = await dialog.showOpenDialog({
      title: options.title,
      properties: ['openFile'],
      filters: options.filters,
    });
    return result.canceled ? null : (result.filePaths[0] ?? null);
  });

  ipcMain.handle(SHELL_CHANNELS.saveTextFile, async (event, raw) => {
    validateSender(event);
    const options = saveTextFileSchema.parse(raw);
    const result = await dialog.showSaveDialog({ defaultPath: options.defaultName });
    if (result.canceled || !result.filePath) return false;
    await writeFile(result.filePath, options.content, { encoding: 'utf8', mode: 0o600 });
    return true;
  });

  ipcMain.handle(SHELL_CHANNELS.printText, async (event, raw) => {
    validateSender(event);
    await printPlainText(printTextSchema.parse(raw));
  });

  ipcMain.handle(SHELL_CHANNELS.openExternal, async (event, raw) => {
    validateSender(event);
    await shell.openExternal(externalUrlSchema.parse(raw));
  });

  ipcMain.handle(SHELL_CHANNELS.openLogsFolder, async (event) => {
    validateSender(event);
    const directory = getLogsDirectory();
    await mkdir(directory, { recursive: true });
    const error = await shell.openPath(directory);
    if (error) throw new Error('The logs folder could not be opened.');
  });

  ipcMain.handle(SHELL_CHANNELS.clearViewerData, async (event) => {
    validateSender(event);
    const viewerSession = session.fromPartition('persist:liveviewer');
    await Promise.all([viewerSession.clearCache(), viewerSession.clearStorageData()]);
  });
}

export function parseExternalUrl(value: unknown): string {
  return externalUrlSchema.parse(value);
}

export function logsDirectory(userDataDirectory: string): string {
  return join(userDataDirectory, 'logs');
}
