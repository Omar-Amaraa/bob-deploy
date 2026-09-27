import type {
  AppError,
  MaintenanceItem,
  MetricSample,
  SnapshotRecord,
  TimeRange,
} from '@bob-deploy/contracts';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { ExternalLink, RefreshCw, RotateCcw, Send, Wrench } from 'lucide-react';
import { useState } from 'react';
import { useForm } from 'react-hook-form';
import { Area, AreaChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { Button, Card, Dialog, EmptyState, ErrorState, Pill, Skeleton, Toast } from '../components/ui.js';
import { errorCopy } from '../errors/catalog.js';
import { useIpc } from '../ipc/context.js';
import {
  IpcQueryError,
  unwrap,
  useAnalytics,
  useBobStatus,
  useHealth,
  useJobs,
  useMaintenance,
  useMetrics,
  useProblems,
  useProjects,
  useReleases,
  useSnapshots,
} from '../ipc/hooks.js';
import { isTestbedSiteUrl } from '../utils/site-url.js';

function useCurrentProject() {
  const { projectId = '' } = useParams();
  const projects = useProjects();
  return { projectId, project: projects.data?.find((item) => item.id === projectId), projects };
}

function DeployFirst() {
  return (
    <EmptyState
      title="Put this project online first"
      body="This information appears after your first publish."
      action={
        <Link className="button link-button" to="../deploy">
          Put project online
        </Link>
      }
    />
  );
}

function LastKnownBanner({ checkedAt }: { checkedAt?: string }) {
  return (
    <div className="data-banner" role="status">
      The server is not answering. These are the last values we received.{' '}
      {checkedAt
        ? `Last updated ${new Date(checkedAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}.`
        : ''}
    </div>
  );
}

function TrendChart({
  samples,
  label,
  unit = '',
}: {
  samples: { ts: string; value: number }[];
  label: string;
  unit?: string;
}) {
  if (!samples.length) return <p className="chart-empty">No trend data yet.</p>;
  const data = samples.map((sample) => ({
    time: new Date(sample.ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
    value: sample.value,
  }));
  const gradientId = `fill-${label.replace(/\W/g, '')}`;
  return (
    <div
      className="line-chart"
      role="img"
      aria-label={`${label}. Latest value ${Math.round(samples.at(-1)?.value ?? 0)}${unit}.`}
    >
      <ResponsiveContainer width="100%" height={180}>
        <AreaChart data={data} margin={{ top: 8, right: 8, bottom: 0, left: -18 }}>
          <defs>
            <linearGradient id={gradientId} x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor="var(--accent)" stopOpacity={0.35} />
              <stop offset="100%" stopColor="var(--accent)" stopOpacity={0.02} />
            </linearGradient>
          </defs>
          <CartesianGrid vertical={false} stroke="var(--border)" />
          <XAxis dataKey="time" tickLine={false} axisLine={false} minTickGap={32} />
          <YAxis tickLine={false} axisLine={false} domain={[0, 'auto']} unit={unit} />
          <Tooltip formatter={(value) => [`${String(value)}${unit}`, label]} />
          <Area
            type="monotone"
            dataKey="value"
            stroke="var(--accent)"
            strokeWidth={2}
            fill={`url(#${gradientId})`}
          />
        </AreaChart>
      </ResponsiveContainer>
    </div>
  );
}

function mutationAppError(error: unknown): AppError | undefined {
  return error instanceof IpcQueryError ? error.appError : undefined;
}

function ActionError({ error, retry }: { error: unknown; retry?: () => void }) {
  const appError = mutationAppError(error);
  if (!appError)
    return (
      <p className="form-error" role="alert">
        {error instanceof Error ? error.message : 'Something went wrong.'}
      </p>
    );
  if (appError.code === 'JOB_RUNNING') {
    return (
      <p className="form-error" role="alert">
        Another task is running for this site. Wait for it to finish.
      </p>
    );
  }
  const copy = errorCopy(appError);
  const act = () => {
    if (copy.action === 'Open logs') void window.bobDeploy?.openLogsFolder();
    else if (copy.action === 'Unlock') window.location.hash = '#/unlock';
    else retry?.();
  };
  return (
    <div className="catalog-error" role="alert">
      <strong>{copy.title}</strong>
      <p>{copy.body}</p>
      {copy.action ? (
        <Button className="button-secondary" onClick={act}>
          {copy.action}
        </Button>
      ) : null}
    </div>
  );
}

const statusLabel = {
  live: 'Live',
  down: 'Down',
  deploying: 'Deploying',
  not_deployed: 'Not deployed',
  error: 'Error',
  unknown: 'Unknown',
} as const;
const activeJobStatuses = new Set(['queued', 'running', 'waiting_user']);

export function HomeScreen() {
  const { projectId, project, projects } = useCurrentProject();
  const health = useHealth(projectId);
  const jobs = useJobs(projectId, 5);
  const releases = useReleases(projectId);
  const snapshots = useSnapshots(projectId);
  const maintenance = useMaintenance(projectId);
  const bob = useBobStatus();
  const ipc = useIpc();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [snapshot, setSnapshot] = useState<SnapshotRecord>();
  const [notice, setNotice] = useState('');
  const startUpdate = useMutation({
    mutationFn: async () => unwrap(await ipc['update:start']({ projectId })),
    onSuccess: ({ jobId }) => void navigate(`/p/${projectId}/jobs/${jobId}`),
  });
  const rollback = useMutation({
    mutationFn: async (releaseId: string) => unwrap(await ipc['rollback:start']({ projectId, releaseId })),
    onSuccess: ({ jobId }) => void navigate(`/p/${projectId}/jobs/${jobId}`),
  });
  const restore = useMutation({
    mutationFn: async (snapshotId: string) =>
      unwrap(await ipc['snapshots:restore']({ projectId, snapshotId })),
    onSuccess: async () => {
      setSnapshot(undefined);
      setNotice('Your project folder was restored.');
      await queryClient.invalidateQueries({ queryKey: ['project-data', projectId, 'snapshots'] });
    },
  });

  if (
    projects.isLoading ||
    jobs.isLoading ||
    releases.isLoading ||
    snapshots.isLoading ||
    maintenance.isLoading ||
    bob.isLoading
  )
    return <Skeleton label="Loading project home" />;
  const queryError =
    projects.error ?? jobs.error ?? releases.error ?? snapshots.error ?? maintenance.error ?? bob.error;
  if (queryError)
    return (
      <ErrorState
        message={queryError.message}
        retry={() => {
          void projects.refetch();
          void jobs.refetch();
          void releases.refetch();
          void snapshots.refetch();
          void maintenance.refetch();
          void bob.refetch();
        }}
      />
    );
  if (!project) return <EmptyState title="No project selected" body="Choose a project to see its status." />;

  const activeJob = jobs.data?.find((job) => activeJobStatuses.has(job.status));
  const updateReason = activeJob
    ? 'Bob is already working on this project.'
    : !bob.data?.configured
      ? 'Connect Bob in Settings before updating.'
      : !project.target
        ? 'Put this project online before updating.'
        : undefined;
  const nextMaintenance = [...(maintenance.data ?? [])].sort(
    (a, b) => severityRank[a.severity] - severityRank[b.severity],
  )[0];
  const siteTone =
    project.status === 'live'
      ? 'good'
      : project.status === 'down' || project.status === 'error'
        ? 'bad'
        : project.status === 'deploying'
          ? 'warning'
          : 'neutral';
  const openSite = () => {
    const siteUrl = project.target?.siteUrl;
    if (!siteUrl) return;
    if (isTestbedSiteUrl(siteUrl)) void navigate(`/p/${project.id}/viewer`);
    else void window.bobDeploy?.openExternal(siteUrl);
  };

  return (
    <div className="stack home-screen">
      {startUpdate.error || rollback.error || restore.error ? (
        <ActionError
          error={startUpdate.error ?? rollback.error ?? restore.error}
          retry={() => {
            startUpdate.reset();
            rollback.reset();
            restore.reset();
          }}
        />
      ) : null}
      <div className="screen-grid">
        <Card>
          <p className="eyebrow">Site status</p>
          <div className="status-heading">
            <h2>{project.name}</h2>
            <Pill tone={siteTone}>{statusLabel[project.status]}</Pill>
          </div>
          {project.target?.siteUrl ? (
            <button className="text-button" onClick={openSite}>
              {project.target.siteUrl}
              <ExternalLink aria-hidden="true" />
            </button>
          ) : (
            <p>Put this project online when you are ready.</p>
          )}
          <p>
            {health.data?.checkedAt
              ? `Last checked ${new Date(health.data.checkedAt).toLocaleString()}`
              : 'No site check yet.'}
          </p>
        </Card>
        <Card className="update-card">
          <p className="eyebrow">Publish changes</p>
          <h2>Ready for your next version?</h2>
          <Button
            className="update-button"
            disabled={Boolean(updateReason) || startUpdate.isPending}
            aria-describedby={updateReason ? 'update-disabled-reason' : undefined}
            onClick={() => startUpdate.mutate()}
          >
            {startUpdate.isPending ? 'Starting…' : 'Update'}
          </Button>
          {updateReason ? (
            <p id="update-disabled-reason" className="field-help">
              {updateReason}
            </p>
          ) : null}
        </Card>
        <Card>
          <p className="eyebrow">Last release</p>
          <h2>
            {project.lastRelease
              ? new Date(project.lastRelease.createdAt).toLocaleString()
              : 'No versions yet'}
          </h2>
          <p>
            {project.lastRelease
              ? `Status: ${project.lastRelease.status}.`
              : 'Your first release will appear here.'}
          </p>
          {releases.data?.length ? (
            <details className="release-menu">
              <summary>Roll back</summary>
              <ul className="action-list">
                {releases.data.map((release) => (
                  <li key={release.id}>
                    <span>
                      <strong>{new Date(release.createdAt).toLocaleString()}</strong>
                      <small>{release.status}</small>
                    </span>
                    <Button
                      className="button-secondary"
                      disabled={rollback.isPending || activeJob !== undefined}
                      onClick={() => rollback.mutate(release.releaseId)}
                    >
                      Use this version
                    </Button>
                  </li>
                ))}
              </ul>
            </details>
          ) : null}
        </Card>
        <Card>
          <p className="eyebrow">Next maintenance item</p>
          {nextMaintenance ? (
            <>
              <Pill
                tone={
                  nextMaintenance.severity === 'critical'
                    ? 'bad'
                    : nextMaintenance.severity === 'warning'
                      ? 'warning'
                      : 'neutral'
                }
              >
                {nextMaintenance.severity}
              </Pill>
              <h2>{nextMaintenance.title}</h2>
              <p>{nextMaintenance.detail}</p>
              <Link className="text-button" to="../maintenance">
                View maintenance
              </Link>
            </>
          ) : (
            <>
              <h2>Nothing needs your attention</h2>
              <p>Bob Deploy will keep checking.</p>
            </>
          )}
        </Card>
      </div>
      <Card>
        <p className="eyebrow">Bob’s recent activity</p>
        <h2>Latest tasks</h2>
        {jobs.data?.length ? (
          <ul className="activity-list">
            {jobs.data.map((job) => (
              <li key={job.id}>
                <span>
                  <strong>{job.summary ?? job.kind.replaceAll('_', ' ')}</strong>
                  <small>
                    {new Date(job.startedAt).toLocaleString()} · {job.status.replace('_', ' ')}
                  </small>
                </span>
                <Link to={`../jobs/${job.id}`}>View task</Link>
              </li>
            ))}
          </ul>
        ) : (
          <p>Bob has not worked on this project yet.</p>
        )}
      </Card>
      <Card>
        <p className="eyebrow">Project snapshots</p>
        <h2>Undo Bob’s changes</h2>
        <p>Snapshots let you return the project folder to a point before Bob changed it.</p>
        {snapshots.data?.length ? (
          <ul className="activity-list">
            {snapshots.data.map((item) => (
              <li key={item.id}>
                <span>
                  <strong>{new Date(item.createdAt).toLocaleString()}</strong>
                  <small>{item.reason}</small>
                </span>
                <Button className="button-secondary" onClick={() => setSnapshot(item)}>
                  <RotateCcw aria-hidden="true" />
                  Undo Bob’s changes
                </Button>
              </li>
            ))}
          </ul>
        ) : (
          <p>No snapshots yet.</p>
        )}
      </Card>
      {snapshot ? (
        <Dialog title="Undo Bob’s changes?" onClose={() => setSnapshot(undefined)}>
          <p>
            Your project folder goes back to how it was on {new Date(snapshot.createdAt).toLocaleString()}.
            Newer files are moved to a safe place, not deleted.
          </p>
          <div className="button-row">
            <Button disabled={restore.isPending} onClick={() => restore.mutate(snapshot.id)}>
              {restore.isPending ? 'Restoring…' : 'Undo Bob’s changes'}
            </Button>
            <Button className="button-secondary" onClick={() => setSnapshot(undefined)}>
              Cancel
            </Button>
          </div>
        </Dialog>
      ) : null}
      {notice ? <Toast>{notice}</Toast> : null}
    </div>
  );
}

export function HealthScreen() {
  const { projectId, project, projects } = useCurrentProject();
  const health = useHealth(projectId);
  const response = useMetrics(projectId, 'response_ms');
  if (projects.isLoading) return <Skeleton label="Loading project" />;
  if (projects.error)
    return <ErrorState message={projects.error.message} retry={() => void projects.refetch()} />;
  if (!project?.target) return <DeployFirst />;
  if (health.isLoading || response.isLoading) return <Skeleton label="Checking site health" />;
  if (health.error || response.error)
    return (
      <ErrorState
        message={(health.error ?? response.error)?.message ?? 'Try again.'}
        retry={() => {
          void health.refetch();
          void response.refetch();
        }}
      />
    );
  if (!health.data)
    return <EmptyState title="No health checks yet" body="The first check will appear shortly." />;
  const certificateTone =
    (health.data.certDaysLeft ?? 99) < 3 ? 'bad' : (health.data.certDaysLeft ?? 99) < 14 ? 'warning' : 'good';
  return (
    <div className="stack">
      {!health.data.up || health.data.stale ? <LastKnownBanner checkedAt={health.data.checkedAt} /> : null}
      <div className="screen-grid">
        <Card>
          <p className="eyebrow">Current status</p>
          <div className="status-heading">
            <div className="metric-value">{health.data.up ? 'Up' : 'Down'}</div>
            {health.data.stale ? (
              <Pill>Stale</Pill>
            ) : (
              <Pill tone={health.data.up ? 'good' : 'bad'}>
                {health.data.up ? 'Responding' : 'Not responding'}
              </Pill>
            )}
          </div>
          <p>
            {health.data.checkedAt
              ? `Last checked ${new Date(health.data.checkedAt).toLocaleTimeString()}`
              : 'Waiting for the first check.'}
          </p>
          <Button className="button-secondary" onClick={() => void health.refetch()}>
            <RefreshCw aria-hidden="true" />
            Check now
          </Button>
        </Card>
        <Card>
          <p className="eyebrow">Response time</p>
          <div className="metric-value">
            {health.data.responseMs ?? '—'}
            <small> ms</small>
          </div>
          <TrendChart
            samples={(response.data ?? []).map((sample) => ({ ts: sample.ts, value: sample.value }))}
            label="Response time over 24 hours"
            unit=" ms"
          />
        </Card>
        <Card>
          <p className="eyebrow">Certificate</p>
          <Pill tone={certificateTone}>
            {health.data.certDaysLeft !== undefined && health.data.certDaysLeft < 14
              ? 'Needs attention'
              : 'Secure'}
          </Pill>
          <h2>
            {health.data.certDaysLeft === undefined
              ? 'No certificate information yet'
              : `Valid for ${health.data.certDaysLeft} more days`}
          </h2>
          <p>Bob Deploy checks this automatically.</p>
        </Card>
        <Card>
          <p className="eyebrow">Site programs</p>
          <h2>
            {health.data.failedServices.length ? 'A site program needs attention' : 'Everything is running'}
          </h2>
          {health.data.failedServices.length ? (
            <ul className="plain-list">
              {health.data.failedServices.map((service) => (
                <li key={service}>Your app stopped unexpectedly.</li>
              ))}
            </ul>
          ) : (
            <p>No stopped programs were found.</p>
          )}
        </Card>
      </div>
    </div>
  );
}

function resourceTone(kind: 'memory' | 'cpu' | 'disk', value: number): 'normal' | 'warning' | 'critical' {
  const warning = kind === 'disk' ? 85 : 80;
  const critical = kind === 'disk' ? 95 : kind === 'memory' ? 90 : 95;
  return value >= critical ? 'critical' : value >= warning ? 'warning' : 'normal';
}

function ResourceCard({
  label,
  kind,
  samples,
}: {
  label: string;
  kind: 'memory' | 'cpu' | 'disk';
  samples: MetricSample[];
}) {
  const latest = samples.at(-1);
  const value = latest?.value ?? 0;
  const detail =
    kind === 'memory' && latest?.meta
      ? `${Math.round(latest.meta.usedMb ?? 0)} MB of ${Math.round(latest.meta.totalMb ?? 0)} MB used`
      : kind === 'disk' && latest?.meta
        ? `${Math.round((latest.meta.usedBytes ?? 0) / 1_000_000_000)} GB of ${Math.round((latest.meta.totalBytes ?? 0) / 1_000_000_000)} GB used`
        : 'Based on the last 24 hours';
  const tone = resourceTone(kind, value);
  return (
    <Card className={`resource-card threshold-${tone}`} data-threshold={tone}>
      <p className="eyebrow">{label}</p>
      <div className="metric-value">{latest ? Math.round(value) : '—'}%</div>
      <p>{detail}</p>
      <TrendChart samples={samples} label={`${label} use over 24 hours`} unit="%" />
    </Card>
  );
}

export function MemoryScreen() {
  const { projectId, project, projects } = useCurrentProject();
  const memory = useMetrics(projectId, 'memory');
  const cpu = useMetrics(projectId, 'cpu');
  const disk = useMetrics(projectId, 'disk');
  if (projects.isLoading) return <Skeleton label="Loading project" />;
  if (projects.error)
    return <ErrorState message={projects.error.message} retry={() => void projects.refetch()} />;
  if (!project?.target) return <DeployFirst />;
  if (project.target.kind !== 'own_server')
    return (
      <EmptyState
        title="Your host manages the server for this site"
        body="Memory, processor and disk details are available in your hosting dashboard."
      />
    );
  if (memory.isLoading || cpu.isLoading || disk.isLoading) return <Skeleton label="Loading server use" />;
  if (memory.error || cpu.error || disk.error)
    return (
      <ErrorState
        message={(memory.error ?? cpu.error ?? disk.error)?.message ?? 'Try again.'}
        retry={() => {
          void memory.refetch();
          void cpu.refetch();
          void disk.refetch();
        }}
      />
    );
  const stale = project.status === 'down';
  return (
    <div className="stack">
      {stale ? <LastKnownBanner checkedAt={memory.data?.at(-1)?.ts} /> : null}
      <div className="screen-grid three-columns">
        <ResourceCard label="Memory" kind="memory" samples={memory.data ?? []} />
        <ResourceCard label="Processor" kind="cpu" samples={cpu.data ?? []} />
        <ResourceCard label="Disk" kind="disk" samples={disk.data ?? []} />
      </div>
    </div>
  );
}

const ranges: { value: TimeRange; label: string }[] = [
  { value: '24h', label: '24 h' },
  { value: '7d', label: '7 d' },
  { value: '30d', label: '30 d' },
];
const statusLabels: Record<string, string> = {
  '2xx': 'Working',
  '3xx': 'Redirects',
  '4xx': 'Not found or blocked',
  '5xx': 'Server errors',
};

export function AnalyticsScreen() {
  const { projectId, project, projects } = useCurrentProject();
  const [range, setRange] = useState<TimeRange>('24h');
  const analytics = useAnalytics(projectId, range);
  if (projects.isLoading) return <Skeleton label="Loading project" />;
  if (projects.error)
    return <ErrorState message={projects.error.message} retry={() => void projects.refetch()} />;
  if (!project?.target) return <DeployFirst />;
  if (analytics.isLoading) return <Skeleton label="Loading visits" />;
  if (analytics.error)
    return <ErrorState message={analytics.error.message} retry={() => void analytics.refetch()} />;
  if (!analytics.data || (analytics.data.source !== 'provider_dashboard' && analytics.data.visits === 0))
    return <EmptyState title="No visits yet" body="Come back after people have visited your site." />;
  const openDashboard = () => {
    if (analytics.data?.providerDashboardUrl)
      void window.bobDeploy?.openExternal(analytics.data.providerDashboardUrl);
  };
  return (
    <div className="stack">
      <div className="range-tabs" role="tablist" aria-label="Analytics range">
        {ranges.map((item) => (
          <button
            key={item.value}
            role="tab"
            aria-selected={range === item.value}
            onClick={() => setRange(item.value)}
          >
            {item.label}
          </button>
        ))}
      </div>
      {analytics.data.source === 'provider_dashboard' ? (
        <Card>
          <p className="eyebrow">Visits</p>
          <h2>View visits in your hosting dashboard</h2>
          <p>Your host keeps the detailed visit information for this site.</p>
          <Button onClick={openDashboard}>
            <ExternalLink aria-hidden="true" />
            Open your {project.target.kind === 'vercel' ? 'Vercel' : 'Netlify'} dashboard
          </Button>
        </Card>
      ) : (
        <>
          <div className="screen-grid">
            <Card>
              <p className="eyebrow">Visits</p>
              <div className="metric-value">{analytics.data.visits}</div>
              <p>{analytics.data.uniqueVisitors} unique visitors</p>
              <TrendChart
                samples={analytics.data.series.map((item) => ({ ts: item.ts, value: item.visits }))}
                label={`Visits over ${ranges.find((item) => item.value === range)?.label ?? range}`}
              />
            </Card>
            <Card>
              <p className="eyebrow">Status codes</p>
              <dl className="status-breakdown">
                {Object.entries(statusLabels).map(([code, label]) => (
                  <div key={code}>
                    <dt>{label}</dt>
                    <dd>{analytics.data?.statusCodes[code] ?? 0}</dd>
                  </div>
                ))}
              </dl>
            </Card>
          </div>
          <Card>
            <p className="eyebrow">Top pages</p>
            <table className="data-table">
              <thead>
                <tr>
                  <th scope="col">Page</th>
                  <th scope="col">Visits</th>
                </tr>
              </thead>
              <tbody>
                {analytics.data.topPages.map((page) => (
                  <tr key={page.path}>
                    <td>{page.path}</td>
                    <td>{page.count}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </Card>
        </>
      )}
    </div>
  );
}

const severityRank: Record<MaintenanceItem['severity'], number> = { critical: 0, warning: 1, info: 2 };

export function MaintenanceScreen() {
  const { projectId, project, projects } = useCurrentProject();
  const maintenance = useMaintenance(projectId);
  const ipc = useIpc();
  const navigate = useNavigate();
  const run = useMutation({
    mutationFn: async (item: MaintenanceItem) =>
      item.actionId
        ? unwrap(await ipc['maintenance:run']({ projectId, actionId: item.actionId }))
        : undefined,
    onSuccess: (result) => {
      if (result) void navigate(`/p/${projectId}/jobs/${result.jobId}`);
    },
  });
  if (projects.isLoading) return <Skeleton label="Loading project" />;
  if (projects.error)
    return <ErrorState message={projects.error.message} retry={() => void projects.refetch()} />;
  if (!project?.target) return <DeployFirst />;
  if (maintenance.isLoading) return <Skeleton label="Checking maintenance" />;
  if (maintenance.error)
    return <ErrorState message={maintenance.error.message} retry={() => void maintenance.refetch()} />;
  if (!maintenance.data?.length)
    return (
      <EmptyState
        title="Nothing needs your attention"
        body="Bob Deploy will let you know when something needs care."
      />
    );
  const sorted = [...maintenance.data].sort((a, b) => severityRank[a.severity] - severityRank[b.severity]);
  return (
    <div className="stack">
      {run.error ? (
        <p className="form-error" role="alert">
          {run.error.message}
        </p>
      ) : null}
      {sorted.map((item) => (
        <Card key={item.id} className={`maintenance-item severity-${item.severity}`}>
          <div className="maintenance-copy">
            <Pill
              tone={
                item.severity === 'critical' ? 'bad' : item.severity === 'warning' ? 'warning' : 'neutral'
              }
            >
              {item.severity}
            </Pill>
            <h2>{item.title}</h2>
            <p>{item.detail}</p>
          </div>
          {item.actionId ? (
            <Button disabled={run.isPending} onClick={() => run.mutate(item)}>
              <Wrench aria-hidden="true" />
              {run.isPending && run.variables?.id === item.id ? 'Starting…' : 'Fix'}
            </Button>
          ) : null}
        </Card>
      ))}
    </div>
  );
}

export function ProblemScreen() {
  const { projectId, project, projects } = useCurrentProject();
  const problems = useProblems(projectId);
  const ipc = useIpc();
  const navigate = useNavigate();
  const {
    register,
    handleSubmit,
    formState: { errors, isSubmitting },
    reset,
  } = useForm<{ note: string }>();
  const signal = useMutation({
    mutationFn: async (note: string) => unwrap(await ipc['problem:signal']({ projectId, note })),
    onSuccess: ({ jobId }) => {
      reset();
      void navigate(`/p/${projectId}/jobs/${jobId}`);
    },
  });
  if (projects.isLoading || problems.isLoading) return <Skeleton label="Loading reported problems" />;
  if (projects.error || problems.error)
    return (
      <ErrorState
        message={(projects.error ?? problems.error)?.message ?? 'Try again.'}
        retry={() => {
          void projects.refetch();
          void problems.refetch();
        }}
      />
    );
  if (!project)
    return (
      <EmptyState title="No project selected" body="Choose a project before sending a problem to Bob." />
    );
  return (
    <div className="stack">
      <Card>
        <p className="eyebrow">Signal a problem</p>
        <h2>Tell Bob what is happening</h2>
        <p>
          Describe what you expected and what happened. For example: “The contact form does nothing” or “The
          site shows an error since this morning”.
        </p>
        {signal.error ? <ActionError error={signal.error} retry={() => signal.reset()} /> : null}
        <form onSubmit={(event) => void handleSubmit((values) => signal.mutateAsync(values.note))(event)}>
          <div className="field">
            <label htmlFor="problem-note">What is wrong?</label>
            <textarea
              id="problem-note"
              rows={7}
              aria-invalid={Boolean(errors.note)}
              aria-describedby={errors.note ? 'problem-note-error' : 'problem-note-help'}
              {...register('note', {
                required: 'Describe the problem before sending it.',
                minLength: { value: 10, message: 'Use at least 10 characters.' },
                maxLength: { value: 2000, message: 'Keep the description under 2,000 characters.' },
              })}
            />
            <span id="problem-note-help" className="field-help">
              10–2,000 characters. Do not include passwords or API keys.
            </span>
            {errors.note ? (
              <span id="problem-note-error" className="field-error" aria-live="polite">
                {errors.note.message}
              </span>
            ) : null}
          </div>
          <Button type="submit" disabled={isSubmitting || signal.isPending}>
            <Send aria-hidden="true" />
            {signal.isPending ? 'Sending…' : 'Send to Bob'}
          </Button>
        </form>
      </Card>
      <Card>
        <p className="eyebrow">Past problems</p>
        <h2>What you have reported</h2>
        {problems.data?.length ? (
          <ul className="activity-list">
            {problems.data.map((problem) => (
              <li key={problem.id}>
                <span>
                  <strong>{problem.note}</strong>
                  <small>{new Date(problem.createdAt).toLocaleString()}</small>
                </span>
                <span className="problem-status">
                  <Pill tone={problem.resolvedAt ? 'good' : 'warning'}>
                    {problem.resolvedAt ? 'Resolved' : 'In progress'}
                  </Pill>
                  <Link to={`../jobs/${problem.jobId}`}>View task</Link>
                </span>
              </li>
            ))}
          </ul>
        ) : (
          <p>No problems have been reported for this project.</p>
        )}
      </Card>
    </div>
  );
}
