// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import type { IpcChannel, IpcTransport, MaintenanceItem, MetricSample } from '@bob-deploy/contracts';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { createElement, type ReactNode } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { App } from '../app/App.js';
import { MockCore } from '../mock/MockCore.js';

vi.mock('recharts', async () => {
  const React = await import('react');
  const container = ({ children }: { children?: ReactNode }) => React.createElement('div', {}, children);
  return {
    Area: () => null,
    AreaChart: () => React.createElement('div'),
    CartesianGrid: () => null,
    ResponsiveContainer: container,
    Tooltip: () => null,
    XAxis: () => null,
    YAxis: () => null,
  };
});

type Override = (payload: unknown) => unknown;

function withOverrides(core: MockCore, overrides: Partial<Record<IpcChannel, Override>>): IpcTransport {
  return {
    invoke: (channel, payload) =>
      Promise.resolve(overrides[channel]?.(payload) ?? core.invoke(channel, payload)),
    on: (event, listener) => core.on(event, listener),
  };
}

function show(transport: IpcTransport, path: string) {
  return render(createElement(App, { transport, initialEntries: [path] }));
}

afterEach(() => {
  cleanup();
  Reflect.deleteProperty(window, 'bobDeploy');
  vi.restoreAllMocks();
});

describe('dashboard data screens', () => {
  it('shows the complete home summary and starts an update', async () => {
    const core = new MockCore('live-own-server', { delay: 0 });
    const update = vi.fn(() => ({ ok: true, data: { jobId: 'job-update-home' } }));
    show(withOverrides(core, { 'update:start': update }), '/p/project-own/home');

    expect(await screen.findByText('Site status')).toBeInTheDocument();
    expect(screen.getByText('Last release')).toBeInTheDocument();
    expect(screen.getByText('Next maintenance item')).toBeInTheDocument();
    expect(screen.getByText('Bob’s recent activity')).toBeInTheDocument();
    expect(screen.getByText('Project snapshots')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Update' }));
    await waitFor(() => expect(update).toHaveBeenCalledWith({ projectId: 'project-own' }));
  });

  it('explains why update is unavailable when Bob is not configured', async () => {
    show(new MockCore('bob-missing', { delay: 0 }), '/p/project-own/home');
    expect(await screen.findByRole('button', { name: 'Update' })).toBeDisabled();
    expect(screen.getByText('Connect Bob in Settings before updating.')).toBeInTheDocument();
  });

  it('confirms snapshot restoration with the safe-place promise', async () => {
    const core = new MockCore('live-own-server', { delay: 0 });
    const restore = vi.fn(() => ({ ok: true, data: undefined }));
    show(withOverrides(core, { 'snapshots:restore': restore }), '/p/project-own/home');

    fireEvent.click(await screen.findByRole('button', { name: 'Undo Bob’s changes' }));
    const dialog = screen.getByRole('dialog', { name: 'Undo Bob’s changes?' });
    expect(
      within(dialog).getByText(/Newer files are moved to a safe place, not deleted/),
    ).toBeInTheDocument();
    fireEvent.click(within(dialog).getByRole('button', { name: 'Undo Bob’s changes' }));
    await waitFor(() =>
      expect(restore).toHaveBeenCalledWith({ projectId: 'project-own', snapshotId: 'snapshot-1' }),
    );
  });

  it('validates, sends and lists problems in plain language', async () => {
    const core = new MockCore('live-own-server', { delay: 0 });
    const signal = vi.fn(() => ({ ok: true, data: { jobId: 'job-diagnose-1' } }));
    const transport = withOverrides(core, {
      'problem:signal': signal,
      'problems:list': () => ({
        ok: true,
        data: [
          {
            id: 'problem-1',
            projectId: 'project-own',
            note: 'The checkout page is blank',
            jobId: 'job-old',
            createdAt: '2026-09-24T10:00:00.000Z',
          },
        ],
      }),
    });
    show(transport, '/p/project-own/problem');

    expect(await screen.findByText('The checkout page is blank')).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText('What is wrong?'), { target: { value: 'short' } });
    fireEvent.click(screen.getByRole('button', { name: 'Send to Bob' }));
    expect(await screen.findByText('Use at least 10 characters.')).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText('What is wrong?'), {
      target: { value: 'The contact form does nothing' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Send to Bob' }));
    await waitFor(() =>
      expect(signal).toHaveBeenCalledWith({
        projectId: 'project-own',
        note: 'The contact form does nothing',
      }),
    );
  });

  it('shows health, response history and plain-language service status', async () => {
    const core = new MockCore('live-own-server', { delay: 0 });
    const transport = withOverrides(core, {
      'health:get': () => ({
        ok: true,
        data: {
          up: true,
          httpStatus: 200,
          responseMs: 87,
          certDaysLeft: 2,
          failedServices: ['web'],
          checkedAt: '2026-09-25T16:00:00.000Z',
          stale: false,
        },
      }),
    });
    show(transport, '/p/project-own/health');

    expect(await screen.findByText('87')).toBeInTheDocument();
    expect(screen.getByText('Needs attention')).toBeInTheDocument();
    expect(screen.getByText('Valid for 2 more days')).toBeInTheDocument();
    expect(screen.getByText('Your app stopped unexpectedly.')).toBeInTheDocument();
    expect(screen.getByRole('img', { name: /Response time over 24 hours/ })).toBeInTheDocument();
  });

  it('keeps last known health and memory visible when the server is down', async () => {
    const core = new MockCore('server-down', { delay: 0 });
    const view = show(core, '/p/project-own/health');
    expect(await screen.findByText(/server is not answering/i)).toBeInTheDocument();
    expect(screen.getAllByText('Down')).toHaveLength(2);

    view.unmount();
    show(core, '/p/project-own/memory');
    expect(await screen.findByText(/server is not answering/i)).toBeInTheDocument();
    expect(screen.getByText('Memory')).toBeInTheDocument();
  });

  it('applies warning and critical resource thresholds and shows raw totals', async () => {
    const core = new MockCore('live-own-server', { delay: 0 });
    const transport = withOverrides(core, {
      'metrics:series': (payload) => {
        const kind = (payload as { kind: MetricSample['kind'] }).kind;
        const values: Partial<Record<MetricSample['kind'], number>> = { memory: 85, cpu: 96, disk: 95 };
        const value = values[kind] ?? 100;
        const meta =
          kind === 'memory'
            ? { usedMb: 435, totalMb: 512 }
            : kind === 'disk'
              ? { usedBytes: 95_000_000_000, totalBytes: 100_000_000_000 }
              : undefined;
        return {
          ok: true,
          data: [
            {
              projectId: 'project-own',
              kind,
              value,
              unit: kind === 'response_ms' ? 'ms' : '%',
              ts: '2026-09-25T16:00:00.000Z',
              meta,
            },
          ],
        };
      },
    });
    const { container } = show(transport, '/p/project-own/memory');

    expect(await screen.findByText('435 MB of 512 MB used')).toBeInTheDocument();
    expect(screen.getByText('95 GB of 100 GB used')).toBeInTheDocument();
    expect(container.querySelector('[data-threshold="warning"]')).toHaveTextContent('Memory');
    expect(container.querySelectorAll('[data-threshold="critical"]')).toHaveLength(2);
  });

  it('sends free-host users to their provider instead of showing server controls', async () => {
    const core = new MockCore('live-free-host', { delay: 0 });
    const openExternal = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(window, 'bobDeploy', { configurable: true, value: { openExternal } });
    const memory = show(core, '/p/project-free/memory');
    expect(await screen.findByText('Your host manages the server for this site')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Memory use' })).toHaveAttribute('aria-disabled', 'true');
    expect(screen.getByRole('link', { name: 'Memory use' })).toHaveAttribute(
      'title',
      'Your host manages the server for this site.',
    );

    memory.unmount();
    show(core, '/p/project-free/analytics');
    fireEvent.click(await screen.findByRole('button', { name: 'Open your Netlify dashboard' }));
    expect(openExternal).toHaveBeenCalledWith('https://app.netlify.com/sites/launch-page');
  });

  it('changes analytics ranges and labels status codes in plain language', async () => {
    const core = new MockCore('live-own-server', { delay: 0 });
    show(core, '/p/project-own/analytics');

    expect(await screen.findByText('438')).toBeInTheDocument();
    expect(screen.getByRole('columnheader', { name: 'Page' })).toBeInTheDocument();
    expect(screen.getByText('Server errors')).toBeInTheDocument();
    const sevenDays = screen.getByRole('tab', { name: '7 d' });
    fireEvent.click(sevenDays);
    expect(await screen.findByRole('tab', { name: '7 d', selected: true })).toBeInTheDocument();
    expect(await screen.findByRole('img', { name: /Visits over 7 d/ })).toBeInTheDocument();
  });

  it('shows the analytics empty state', async () => {
    const core = new MockCore('live-own-server', { delay: 0 });
    const transport = withOverrides(core, {
      'analytics:get': (payload) => ({
        ok: true,
        data: {
          range: (payload as { range: string }).range,
          source: 'caddy',
          visits: 0,
          uniqueVisitors: 0,
          topPages: [],
          statusCodes: {},
          series: [],
        },
      }),
    });
    show(transport, '/p/project-own/analytics');
    expect(await screen.findByText('No visits yet')).toBeInTheDocument();
  });

  it('renders health and maintenance for a free host without server controls', async () => {
    const core = new MockCore('live-free-host', { delay: 0 });
    const health = show(core, '/p/project-free/health');
    expect(await screen.findByText('104')).toBeInTheDocument();
    expect(screen.getByText('Up')).toBeInTheDocument();

    health.unmount();
    show(core, '/p/project-free/maintenance');
    expect(await screen.findByText('Nothing needs your attention')).toBeInTheDocument();
  });

  it('keeps analytics and maintenance useful in the down-server scenario', async () => {
    const core = new MockCore('server-down', { delay: 0 });
    const analytics = show(core, '/p/project-own/analytics');
    expect(await screen.findByText('438')).toBeInTheDocument();

    analytics.unmount();
    show(core, '/p/project-own/maintenance');
    expect(await screen.findByText('Three updates are ready')).toBeInTheDocument();
  });

  it('sorts maintenance by urgency and starts the selected fix', async () => {
    const core = new MockCore('live-own-server', { delay: 0 });
    const run = vi.fn(() => ({ ok: true, data: { jobId: 'job-fix-1' } }));
    const items: MaintenanceItem[] = [
      {
        id: 'info',
        projectId: 'project-own',
        kind: 'old_releases',
        severity: 'info',
        title: 'Old versions can be cleaned',
        detail: 'This frees a little space.',
        detectedAt: '2026-09-25T16:00:00.000Z',
      },
      {
        id: 'critical',
        projectId: 'project-own',
        kind: 'disk_nearly_full',
        severity: 'critical',
        title: 'Disk is nearly full',
        detail: 'New versions may not fit.',
        actionId: 'clean_disk',
        detectedAt: '2026-09-25T16:00:00.000Z',
      },
      {
        id: 'warning',
        projectId: 'project-own',
        kind: 'security_patches',
        severity: 'warning',
        title: 'Updates are ready',
        detail: 'These improve security.',
        actionId: 'apply_security_updates',
        detectedAt: '2026-09-25T16:00:00.000Z',
      },
    ];
    const transport = withOverrides(core, {
      'maintenance:list': () => ({ ok: true, data: items }),
      'maintenance:run': run,
    });
    const { container } = show(transport, '/p/project-own/maintenance');

    expect(await screen.findByText('Disk is nearly full')).toBeInTheDocument();
    const cards = [...container.querySelectorAll('.maintenance-item')];
    expect(cards.map((card) => within(card as HTMLElement).getByRole('heading').textContent)).toEqual([
      'Disk is nearly full',
      'Updates are ready',
      'Old versions can be cleaned',
    ]);
    fireEvent.click(within(cards[0] as HTMLElement).getByRole('button', { name: 'Fix' }));
    await waitFor(() =>
      expect(run).toHaveBeenCalledWith({ projectId: 'project-own', actionId: 'clean_disk' }),
    );
  });

  it('handles projects without a target and monitor errors', async () => {
    const empty = new MockCore('onboarded-empty', { delay: 0 });
    await empty.invoke('projects:create', { name: 'Draft', folderPath: 'C:\\Sites\\draft' });
    const targetless = show(empty, '/p/project-1/health');
    expect(await screen.findByText('Put this project online first')).toBeInTheDocument();

    targetless.unmount();
    const targetlessMemory = show(empty, '/p/project-1/memory');
    expect(await screen.findByText('Put this project online first')).toBeInTheDocument();

    targetlessMemory.unmount();
    const targetlessAnalytics = show(empty, '/p/project-1/analytics');
    expect(await screen.findByText('Put this project online first')).toBeInTheDocument();

    targetlessAnalytics.unmount();
    const targetlessMaintenance = show(empty, '/p/project-1/maintenance');
    expect(await screen.findByText('Put this project online first')).toBeInTheDocument();

    targetlessMaintenance.unmount();
    const core = new MockCore('live-own-server', { delay: 0 });
    const transport = withOverrides(core, {
      'health:get': () => ({ ok: false, error: { code: 'INTERNAL', message: 'Health check failed.' } }),
    });
    show(transport, '/p/project-own/health');
    expect(await screen.findByText('Health check failed.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Try again' })).toBeInTheDocument();
  });
});
