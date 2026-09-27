import { describe, expect, it } from 'vitest';
import { CONTENT_SECURITY_POLICY, isAllowedExternalUrl, isSameAppNavigation, isViewerNavigationAllowed } from './security.js';

describe('desktop security helpers', () => {
  it('uses the release-blocking content security policy', () => {
    expect(CONTENT_SECURITY_POLICY).toBe(
      "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; frame-src 'none'; object-src 'none'; base-uri 'none'",
    );
  });

  it.each(['http://example.com', 'file:///tmp/secret', 'javascript:alert(1)', 'not a url'])(
    'rejects unsafe external URL %s',
    (url) => expect(isAllowedExternalUrl(url)).toBe(false),
  );

  it('allows HTTPS external links', () => {
    expect(isAllowedExternalUrl('https://example.com/help')).toBe(true);
  });

  it('allows only navigation within the app origin or file directory', () => {
    expect(isSameAppNavigation('http://localhost:5173/settings', 'http://localhost:5173/')).toBe(true);
    expect(isSameAppNavigation('https://evil.test/', 'http://localhost:5173/')).toBe(false);
    expect(isSameAppNavigation('file:///app/out/renderer/settings.html', 'file:///app/out/renderer/index.html')).toBe(true);
    expect(isSameAppNavigation('file:///app/private.txt', 'file:///app/out/renderer/index.html')).toBe(false);
  });

  it.each([
    ['https://mysite.com/about', true],
    ['https://www.mysite.com/about', true],
    ['https://mysite.com.evil.net/about', false],
    ['http://mysite.com/about', false],
    ['javascript:alert(1)', false],
  ])('checks viewer navigation %s', (target, expected) => {
    expect(isViewerNavigationAllowed(target, 'https://mysite.com')).toBe(expected);
  });
});
