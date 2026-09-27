// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { createElement } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { App } from '../app/App.js';
import { MockCore } from '../mock/MockCore.js';

afterEach(() => {
  cleanup();
  Reflect.deleteProperty(window, 'bobDeploy');
  vi.restoreAllMocks();
});

describe('live viewer', () => {
  it('embeds the site in the isolated viewer partition and opens it in the browser', async () => {
    const openExternal = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(window, 'bobDeploy', {
      configurable: true,
      value: { openExternal, onViewerExternalOpened: vi.fn(() => () => undefined) },
    });
    const { container } = render(createElement(App, { transport: new MockCore('live-own-server', { delay: 0 }), initialEntries: ['/p/project-own/viewer'] }));

    const viewer = await waitFor(() => {
      const element = container.querySelector('webview');
      expect(element).toBeInTheDocument();
      return element as HTMLElement;
    });
    expect(viewer).toHaveAttribute('src', 'https://studio.example.test');
    expect(viewer).toHaveAttribute('partition', 'persist:liveviewer');
    expect(viewer).not.toHaveAttribute('preload');
    expect(viewer).not.toHaveAttribute('nodeintegration');
    expect(viewer).not.toHaveAttribute('allowpopups');

    fireEvent.click(screen.getByRole('button', { name: 'Open in browser' }));
    expect(openExternal).toHaveBeenCalledWith('https://studio.example.test');
  });

  it('keeps reserved testbed sites inside Bob Deploy', async () => {
    const openExternal = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(window, 'bobDeploy', {
      configurable: true,
      value: { openExternal, onViewerExternalOpened: vi.fn(() => () => undefined) },
    });
    render(createElement(App, {
      transport: new MockCore('live-own-server', { delay: 0, siteUrl: 'https://static.bd.test/' }),
      initialEntries: ['/p/project-own/viewer'],
    }));

    const button = await screen.findByRole('button', { name: 'Local test site' });
    expect(button).toBeDisabled();
    expect(button).toHaveAttribute('title', 'Local test sites open only inside Bob Deploy.');
    fireEvent.click(button);
    expect(openExternal).not.toHaveBeenCalled();
  });

  it('shows the offline state for a down site with retry and Health actions', async () => {
    const { container } = render(createElement(App, { transport: new MockCore('server-down', { delay: 0 }), initialEntries: ['/p/project-own/viewer'] }));
    expect(await screen.findByText('Your site is not answering right now.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Retry' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Go to Health' })).toHaveAttribute('href', '/p/project-own/health');
    expect(container.querySelector('webview')).not.toBeInTheDocument();
  });

  it('offers deployment when the project has no target', async () => {
    const core = new MockCore('onboarded-empty', { delay: 0 });
    await core.invoke('projects:create', { name: 'Draft', folderPath: 'C:\\Sites\\draft' });
    render(createElement(App, { transport: core, initialEntries: ['/p/project-1/viewer'] }));
    expect(await screen.findByText('Put this project online first')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Put project online' })).toHaveAttribute('href', '/p/project-1/deploy');
  });

  it('announces when a blocked-domain link opens outside the viewer', async () => {
    let notify: (() => void) | undefined;
    Object.defineProperty(window, 'bobDeploy', {
      configurable: true,
      value: {
        openExternal: vi.fn().mockResolvedValue(undefined),
        onViewerExternalOpened: vi.fn((listener: () => void) => { notify = listener; return () => undefined; }),
      },
    });
    render(createElement(App, { transport: new MockCore('live-own-server', { delay: 0 }), initialEntries: ['/p/project-own/viewer'] }));
    await screen.findByLabelText('Current address');
    act(() => notify?.());
    expect(await screen.findByText('Opened in your browser')).toHaveAttribute('role', 'status');
  });
});
