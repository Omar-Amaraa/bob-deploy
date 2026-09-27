import type { WebPreferences } from 'electron';

export const CONTENT_SECURITY_POLICY = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data:",
  "connect-src 'self'",
  "frame-src 'none'",
  "object-src 'none'",
  "base-uri 'none'",
].join('; ');

export function isAllowedExternalUrl(value: string): boolean {
  try {
    return new URL(value).protocol === 'https:';
  } catch {
    return false;
  }
}

export function isSameAppNavigation(target: string, current: string): boolean {
  try {
    const targetUrl = new URL(target);
    const currentUrl = new URL(current);
    if (targetUrl.protocol !== currentUrl.protocol) return false;

    if (currentUrl.protocol === 'file:') {
      const appDirectory = currentUrl.pathname.slice(0, currentUrl.pathname.lastIndexOf('/') + 1);
      return targetUrl.pathname.startsWith(appDirectory);
    }

    return targetUrl.origin === currentUrl.origin;
  } catch {
    return false;
  }
}

export function isViewerNavigationAllowed(target: string, siteUrl: string): boolean {
  try {
    const targetUrl = new URL(target);
    const allowedSite = new URL(siteUrl);
    if (!['http:', 'https:'].includes(targetUrl.protocol)) return false;
    if (targetUrl.protocol !== allowedSite.protocol) return false;
    const hostname = targetUrl.hostname.toLowerCase();
    const siteHostname = allowedSite.hostname.toLowerCase();
    return hostname === siteHostname || hostname.endsWith(`.${siteHostname}`);
  } catch {
    return false;
  }
}

export function hardenWebviewPreferences(preferences: WebPreferences): void {
  delete preferences.preload;
  (preferences as WebPreferences & { preloadURL?: string }).preloadURL = undefined;
  preferences.nodeIntegration = false;
  preferences.contextIsolation = true;
  preferences.sandbox = true;
  preferences.webSecurity = true;
  preferences.partition = 'persist:liveviewer';
  (preferences as WebPreferences & { enableRemoteModule?: boolean }).enableRemoteModule = false;
}
