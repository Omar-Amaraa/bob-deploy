// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import type { IpcChannel, IpcTransport } from '@bob-deploy/contracts';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { createElement } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { App } from '../app/App.js';
import { MockCore } from '../mock/MockCore.js';

type Override = (payload: unknown) => unknown;

function withOverrides(core: MockCore, overrides: Partial<Record<IpcChannel, Override>>): IpcTransport {
  return {
    invoke: (channel, payload) =>
      Promise.resolve(overrides[channel]?.(payload) ?? core.invoke(channel, payload)),
    on: (event, listener) => core.on(event, listener),
  };
}

function show(path: string, transport: IpcTransport = new MockCore('live-own-server', { delay: 0 })) {
  return render(createElement(App, { transport, initialEntries: [path] }));
}

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  Reflect.deleteProperty(window, 'bobDeploy');
  vi.restoreAllMocks();
});

describe('settings', () => {
  it('shows every section in the settings navigation', async () => {
    show('/settings/account');
    const nav = await screen.findByRole('navigation', { name: 'Settings sections' });
    for (const name of [
      'Account',
      'Bob',
      'Free hosting',
      'Servers and keys',
      'Monitoring',
      'Appearance',
      'About',
    ]) {
      expect(nav).toHaveTextContent(name);
    }
  });

  it('maps a wrong current password to its field and changes a valid password', async () => {
    show('/settings/account');
    const newPassword = 'Correct horse battery staple 2!';
    fireEvent.change(await screen.findByLabelText('Current password'), { target: { value: 'wrong' } });
    fireEvent.change(screen.getByLabelText('New password'), { target: { value: newPassword } });
    fireEvent.change(screen.getByLabelText('Confirm new password'), { target: { value: newPassword } });
    const submit = screen.getByRole('button', { name: 'Change password' });
    await waitFor(() => expect(submit).toBeEnabled());
    fireEvent.click(submit);
    expect(await screen.findByText('That password is not right.')).toBeInTheDocument();

    fireEvent.change(screen.getByLabelText('Current password'), {
      target: { value: 'correct horse battery staple' },
    });
    fireEvent.change(screen.getByLabelText('New password'), { target: { value: newPassword } });
    fireEvent.change(screen.getByLabelText('Confirm new password'), { target: { value: newPassword } });
    await waitFor(() => expect(submit).toBeEnabled());
    fireEvent.click(submit);
    expect(await screen.findByText('Password changed')).toHaveAttribute('role', 'status');
  });

  it('creates and confirms a replacement recovery code', async () => {
    show('/settings/account');
    fireEvent.click(await screen.findByRole('button', { name: 'Create a new recovery code' }));
    fireEvent.change(screen.getByLabelText('Master password'), {
      target: { value: 'correct horse battery staple' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Continue' }));
    expect(await screen.findByRole('heading', { name: 'Save your new recovery code' })).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText('Type the last 4 characters to confirm'), {
      target: { value: 'WXYZ' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Continue' }));
    expect(await screen.findByText('A new recovery code was created.')).toBeInTheDocument();
  });

  it('tests and removes the Bob key through confirmation', async () => {
    show('/settings/bob');
    expect(await screen.findByRole('heading', { name: 'Ready' })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Test again' }));
    fireEvent.click(screen.getByRole('button', { name: 'Remove Bob key' }));
    expect(screen.getByRole('dialog', { name: 'Remove Bob key?' })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Remove key' }));
    expect(await screen.findByText('Bob key removed')).toHaveAttribute('role', 'status');
  });

  it('does not continue after a failed Bob connection check', async () => {
    const core = new MockCore('bob-missing', { delay: 0 });
    show(
      '/settings/bob?returnTo=%2Fp%2Fproject-live%2Fdeploy',
      withOverrides(core, {
        'bob:check': () => ({
          ok: true,
          data: [
            { step: 'binary', ok: true, message: 'Bob found.' },
            { step: 'node', ok: true, message: 'Node.js is ready.' },
            { step: 'license', ok: true, message: 'License accepted.' },
            { step: 'auth', ok: false, message: 'That key was not accepted.' },
          ],
        }),
      }),
    );
    fireEvent.change(await screen.findByLabelText('New API key'), { target: { value: 'bad-key' } });
    fireEvent.click(screen.getByRole('button', { name: 'Test and save' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('That key was not accepted.');
    expect(screen.getByRole('heading', { name: 'Connection check' })).toBeVisible();
  });

  it('shows a Bob removal error', async () => {
    const core = new MockCore('live-own-server', { delay: 0 });
    show(
      '/settings/bob',
      withOverrides(core, {
        'bob:clear': () => ({
          ok: false,
          error: { code: 'INTERNAL', message: 'Bob key could not be removed.' },
        }),
      }),
    );
    fireEvent.click(await screen.findByRole('button', { name: 'Remove Bob key' }));
    fireEvent.click(screen.getByRole('button', { name: 'Remove key' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Bob key could not be removed.');
  });

  it('maps rejected hosting tokens and shows the provider revocation follow-up', async () => {
    show('/settings/hosting');
    fireEvent.change(await screen.findByLabelText('Token'), { target: { value: 'bad-token' } });
    fireEvent.click(screen.getByRole('button', { name: 'Connect' }));
    expect(await screen.findByText('That token was not accepted.')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Remove' }));
    fireEvent.click(screen.getByRole('button', { name: 'Remove token' }));
    expect(await screen.findByText(/Also revoke it on Netlify/)).toBeInTheDocument();
  });

  it('reveals the server passphrase for only 30 seconds', async () => {
    show('/settings/servers');
    fireEvent.click(await screen.findByRole('button', { name: 'Show key passphrase' }));
    fireEvent.change(screen.getByLabelText('Master password'), {
      target: { value: 'correct horse battery staple' },
    });
    vi.useFakeTimers();
    fireEvent.click(screen.getByRole('button', { name: 'Show passphrase' }));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(screen.getByText('amber-lantern-orbit-meadow-cobalt-river-sparrow')).toBeInTheDocument();
    expect(screen.getByText('Hidden again in 30 seconds')).toBeInTheDocument();
    act(() => {
      vi.advanceTimersByTime(30_000);
    });
    expect(screen.queryByText('amber-lantern-orbit-meadow-cobalt-river-sparrow')).not.toBeInTheDocument();
  });

  it('downloads the encrypted private key through the save dialog and shows the ssh command', async () => {
    const saveTextFile = vi.fn().mockResolvedValue(true);
    Object.defineProperty(window, 'bobDeploy', {
      configurable: true,
      value: { saveTextFile, platform: 'win32' },
    });
    show('/settings/servers');
    fireEvent.click(await screen.findByRole('button', { name: 'Download private key' }));
    fireEvent.change(screen.getByLabelText('Master password'), {
      target: { value: 'correct horse battery staple' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Download key' }));
    expect(await screen.findByText('Private key saved')).toBeInTheDocument();
    const saved = saveTextFile.mock.calls[0]?.[0] as { defaultName: string; content: string };
    expect(saved.defaultName).toBe('bob-deploy-mock-site');
    expect(saved.content).toContain('BEGIN OPENSSH PRIVATE KEY');
    expect(
      screen.getByText('ssh -i "$env:USERPROFILE\\.ssh\\bob-deploy-mock-site" deploy@203.0.113.10'),
    ).toBeInTheDocument();
  });

  it('does not download the key with a wrong master password', async () => {
    const saveTextFile = vi.fn().mockResolvedValue(true);
    Object.defineProperty(window, 'bobDeploy', {
      configurable: true,
      value: { saveTextFile, platform: 'win32' },
    });
    show('/settings/servers');
    fireEvent.click(await screen.findByRole('button', { name: 'Download private key' }));
    fireEvent.change(screen.getByLabelText('Master password'), { target: { value: 'wrong' } });
    fireEvent.click(screen.getByRole('button', { name: 'Download key' }));
    expect(await screen.findByText('That password is not right.')).toBeInTheDocument();
    expect(saveTextFile).not.toHaveBeenCalled();
  });

  it('maps passphrase throttling to a useful retry message', async () => {
    const core = new MockCore('live-own-server', { delay: 0 });
    show(
      '/settings/servers',
      withOverrides(core, {
        'security:revealSshPassphrase': () => ({
          ok: false,
          error: { code: 'TOO_MANY_ATTEMPTS', message: 'Wait.', details: { retryAfterSeconds: 12 } },
        }),
      }),
    );
    fireEvent.click(await screen.findByRole('button', { name: 'Show key passphrase' }));
    fireEvent.change(screen.getByLabelText('Master password'), { target: { value: 'wrong' } });
    fireEvent.click(screen.getByRole('button', { name: 'Show passphrase' }));
    expect(await screen.findByText('Try again in 12 seconds.')).toBeInTheDocument();
  });

  it('validates and saves monitoring ranges', async () => {
    show('/settings/monitoring');
    const health = await screen.findByLabelText('Health checks (seconds)');
    fireEvent.change(health, { target: { value: '10' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save intervals' }));
    expect(await screen.findByText('Choose 30 to 600 seconds.')).toBeInTheDocument();
    fireEvent.change(health, { target: { value: '45' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save intervals' }));
    expect(await screen.findByText('Monitoring updated')).toBeInTheDocument();
  });

  it('shows a monitoring save error from the core', async () => {
    const core = new MockCore('live-own-server', { delay: 0 });
    show(
      '/settings/monitoring',
      withOverrides(core, {
        'settings:set': () => ({
          ok: false,
          error: { code: 'INTERNAL', message: 'Settings could not be saved.' },
        }),
      }),
    );
    fireEvent.click(await screen.findByRole('button', { name: 'Save intervals' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Settings could not be saved.');
  });

  it('changes appearance immediately', async () => {
    Object.defineProperty(window, 'matchMedia', {
      configurable: true,
      value: vi.fn(() => ({ matches: false, addEventListener: vi.fn(), removeEventListener: vi.fn() })),
    });
    show('/settings/appearance');
    fireEvent.click(await screen.findByRole('radio', { name: 'Dark' }));
    await waitFor(() => expect(document.documentElement.dataset.theme).toBe('dark'));
  });

  it('shows an appearance save error', async () => {
    Object.defineProperty(window, 'matchMedia', {
      configurable: true,
      value: vi.fn(() => ({ matches: false, addEventListener: vi.fn(), removeEventListener: vi.fn() })),
    });
    const core = new MockCore('live-own-server', { delay: 0 });
    show(
      '/settings/appearance',
      withOverrides(core, {
        'settings:set': () => ({
          ok: false,
          error: { code: 'INTERNAL', message: 'Theme could not be saved.' },
        }),
      }),
    );
    fireEvent.click(await screen.findByRole('radio', { name: 'Dark' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Theme could not be saved.');
  });

  it('opens logs, clears viewer data and lists generated licenses', async () => {
    const openLogsFolder = vi.fn().mockResolvedValue(undefined);
    const clearViewerData = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(window, 'bobDeploy', {
      configurable: true,
      value: { appVersion: '1.2.3', openLogsFolder, clearViewerData },
    });
    show('/settings/about');
    expect(await screen.findByRole('heading', { name: 'Version 1.2.3' })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Open logs folder' }));
    fireEvent.click(screen.getByRole('button', { name: 'Clear viewer data' }));
    await waitFor(() => expect(openLogsFolder).toHaveBeenCalled());
    expect(clearViewerData).toHaveBeenCalled();
    expect(await screen.findByText('Viewer data cleared')).toBeInTheDocument();
    expect(screen.getByText('@tanstack/react-query')).toBeInTheDocument();
  });

  it('maps About shell-action failures', async () => {
    Object.defineProperty(window, 'bobDeploy', {
      configurable: true,
      value: {
        appVersion: '1.2.3',
        openLogsFolder: vi.fn().mockRejectedValue(new Error('failed')),
        clearViewerData: vi.fn().mockResolvedValue(undefined),
      },
    });
    show('/settings/about');
    fireEvent.click(await screen.findByRole('button', { name: 'Open logs folder' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('The logs folder could not be opened.');
  });
});
