export function isTestbedSiteUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && url.hostname.toLowerCase().endsWith('.bd.test');
  } catch {
    return false;
  }
}
