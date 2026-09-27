import type { BobCheckResult, HostId, PollIntervals } from '@bob-deploy/contracts';
import { useQueryClient } from '@tanstack/react-query';
import { Check, Copy, Download, FolderOpen, KeyRound, Trash2 } from 'lucide-react';
import { useEffect, useState, type ReactNode } from 'react';
import { useForm } from 'react-hook-form';
import { NavLink, useLocation, useNavigate } from 'react-router-dom';
import {
  Button,
  Card,
  Dialog,
  EmptyState,
  ErrorState,
  Field,
  PasswordField,
  Pill,
  Skeleton,
  Toast,
} from '../components/ui.js';
import { thirdPartyLicenses } from '../generated/licenses.js';
import { useIpc } from '../ipc/context.js';
import {
  useAccountStatus,
  useBobStatus,
  useHosts,
  useProjects,
  useSettings,
  useTargetInfo,
} from '../ipc/hooks.js';
import { RecoveryCodeScreen, StrengthMeter, usePasswordStrength } from './AccountScreens.js';

const sections = [
  ['account', 'Account'],
  ['bob', 'Bob'],
  ['hosting', 'Free hosting'],
  ['servers', 'Servers and keys'],
  ['monitoring', 'Monitoring'],
  ['appearance', 'Appearance'],
  ['about', 'About'],
] as const;

function openExternal(url: string) {
  if (window.bobDeploy) void window.bobDeploy.openExternal(url);
  else window.open(url, '_blank', 'noopener,noreferrer');
}

function SectionState({
  loading,
  error,
  retry,
}: {
  loading: boolean;
  error?: Error | null;
  retry: () => void;
}) {
  if (loading) return <Skeleton label="Loading settings" />;
  if (error) return <ErrorState message={error.message} retry={retry} />;
  return null;
}

interface PasswordValues {
  currentPassword: string;
  newPassword: string;
  confirmPassword: string;
}

function AccountSettings() {
  const account = useAccountStatus();
  const settings = useSettings();
  const ipc = useIpc();
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const [saved, setSaved] = useState('');
  const [actionError, setActionError] = useState('');
  const [recoveryOpen, setRecoveryOpen] = useState(false);
  const [recoveryCode, setRecoveryCode] = useState('');
  const recovery = useForm<{ password: string }>({ defaultValues: { password: '' } });
  const form = useForm<PasswordValues>({
    defaultValues: { currentPassword: '', newPassword: '', confirmPassword: '' },
  });
  const password = form.watch('newPassword');
  const confirm = form.watch('confirmPassword');
  const strength = usePasswordStrength(password, [
    account.data?.displayName ?? '',
    account.data?.email ?? '',
  ]);

  const state = (
    <SectionState
      loading={account.isLoading || settings.isLoading}
      error={account.error ?? settings.error}
      retry={() => {
        void account.refetch();
        void settings.refetch();
      }}
    />
  );
  if (account.isLoading || settings.isLoading || account.error || settings.error) return state;
  if (recoveryCode)
    return (
      <RecoveryCodeScreen
        embedded
        code={recoveryCode}
        title="Save your new recovery code"
        onContinue={() => {
          setRecoveryCode('');
          setSaved('A new recovery code was created.');
        }}
      />
    );

  const changePassword = form.handleSubmit(async (values) => {
    form.clearErrors();
    const result = await ipc['account:changePassword']({
      currentPassword: values.currentPassword,
      newPassword: values.newPassword,
    });
    form.reset();
    if (!result.ok) {
      if (result.error.code === 'BAD_PASSWORD')
        form.setError('currentPassword', { message: 'That password is not right.' });
      else form.setError('currentPassword', { message: result.error.message });
      return;
    }
    setSaved('Password changed');
  });
  const regenerate = recovery.handleSubmit(async ({ password: masterPassword }) => {
    const result = await ipc['account:regenerateRecoveryCode']({ password: masterPassword });
    recovery.reset();
    if (!result.ok) {
      recovery.setError('password', {
        message: result.error.code === 'BAD_PASSWORD' ? 'That password is not right.' : result.error.message,
      });
      return;
    }
    setRecoveryOpen(false);
    setRecoveryCode(result.data.recoveryCode);
  });
  const saveAutoLock = async (minutes: number) => {
    const result = await ipc['settings:set']({ autoLockMinutes: minutes });
    if (result.ok) {
      queryClient.setQueryData(['settings'], result.data);
      setSaved('Auto-lock updated');
      setActionError('');
    } else setActionError(result.error.message);
  };

  return (
    <div className="stack">
      <Card>
        <p className="eyebrow">Local account</p>
        <h2>{account.data?.displayName}</h2>
        <p>{account.data?.email}</p>
      </Card>
      <Card>
        <h2>Change password</h2>
        <form
          onSubmit={(event) => {
            void changePassword(event);
          }}
        >
          <PasswordField
            label="Current password"
            autoComplete="current-password"
            error={form.formState.errors.currentPassword?.message}
            {...form.register('currentPassword', { required: 'Enter your current password.' })}
          />
          <PasswordField
            label="New password"
            autoComplete="new-password"
            error={form.formState.errors.newPassword?.message}
            {...form.register('newPassword', {
              required: 'Enter a new password.',
              minLength: { value: 12, message: 'Use at least 12 characters.' },
            })}
          />
          <StrengthMeter
            password={password}
            userInputs={[account.data?.displayName ?? '', account.data?.email ?? '']}
          />
          <PasswordField
            label="Confirm new password"
            autoComplete="new-password"
            error={form.formState.errors.confirmPassword?.message}
            {...form.register('confirmPassword', {
              validate: (value) => value === password || 'Passwords do not match.',
            })}
          />
          <Button
            disabled={form.formState.isSubmitting || !strength.authoritative?.ok || confirm !== password}
          >
            Change password
          </Button>
        </form>
      </Card>
      <Card>
        <h2>Recovery and locking</h2>
        <div className="settings-row">
          <div>
            <strong>Recovery code</strong>
            <p>Create a replacement if the old one is no longer safe.</p>
          </div>
          <Button className="button-secondary" onClick={() => setRecoveryOpen(true)}>
            Create a new recovery code
          </Button>
        </div>
        <label className="field">
          <span>Auto-lock after</span>
          <select
            aria-label="Auto-lock after"
            value={settings.data?.autoLockMinutes ?? 15}
            onChange={(event) => void saveAutoLock(Number(event.target.value))}
          >
            {[5, 15, 30, 60, 240].map((minutes) => (
              <option key={minutes} value={minutes}>
                {minutes < 60 ? `${minutes} minutes` : `${minutes / 60} hours`}
              </option>
            ))}
          </select>
        </label>
        <Button
          className="button-secondary"
          onClick={() => {
            void ipc['account:lock']().then(() => navigate('/unlock'));
          }}
        >
          Lock now
        </Button>
      </Card>
      {actionError ? (
        <p className="form-error" role="alert">
          {actionError}
        </p>
      ) : null}
      {recoveryOpen ? (
        <Dialog
          title="Create a new recovery code"
          onClose={() => {
            recovery.reset();
            setRecoveryOpen(false);
          }}
        >
          <form
            onSubmit={(event) => {
              void regenerate(event);
            }}
          >
            <PasswordField
              label="Master password"
              autoComplete="current-password"
              autoFocus
              error={recovery.formState.errors.password?.message}
              {...recovery.register('password', { required: 'Enter your master password.' })}
            />
            <Button>Continue</Button>
          </form>
        </Dialog>
      ) : null}
      {saved ? <Toast>{saved}</Toast> : null}
    </div>
  );
}

interface BobValues {
  apiKey: string;
  keyType: 'inference' | 'general';
  teamId: string;
}

function BobSettings({ returnTo }: { returnTo?: string }) {
  const bob = useBobStatus();
  const ipc = useIpc();
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const [replace, setReplace] = useState(false);
  const [confirmRemove, setConfirmRemove] = useState(false);
  const [message, setMessage] = useState('');
  const [actionError, setActionError] = useState('');
  const [checks, setChecks] = useState<BobCheckResult[]>([]);
  const form = useForm<BobValues>({ defaultValues: { apiKey: '', keyType: 'inference', teamId: '' } });
  const keyType = form.watch('keyType');
  if (bob.isLoading) return <Skeleton label="Loading Bob settings" />;
  if (bob.error) return <ErrorState message={bob.error.message} retry={() => void bob.refetch()} />;
  const save = form.handleSubmit(async (values) => {
    setActionError('');
    setChecks([]);
    const result = await ipc['bob:save']({
      apiKey: values.apiKey,
      keyType: values.keyType,
      teamId: values.keyType === 'general' ? values.teamId : undefined,
      binaryPath: bob.data?.binaryPath,
      acceptLicense: true,
    });
    form.reset();
    if (!result.ok) {
      form.setError('apiKey', { message: result.error.message });
      return;
    }
    queryClient.setQueryData(['bob-status'], result.data);
    const checked = await ipc['bob:check']();
    if (!checked.ok) {
      setActionError(checked.error.message);
      return;
    }
    setChecks(checked.data);
    const failed = checked.data.find((check) => !check.ok);
    await bob.refetch();
    if (failed) {
      setActionError(failed.message);
      return;
    }
    setReplace(false);
    setMessage('Bob is connected');
    if (returnTo) void navigate(returnTo, { replace: true });
  });
  const remove = async () => {
    const result = await ipc['bob:clear']();
    if (result.ok) queryClient.setQueryData(['bob-status'], result.data);
    else {
      setActionError(result.error.message);
      return;
    }
    setConfirmRemove(false);
    setMessage('Bob key removed');
  };
  return (
    <div className="stack">
      <Card>
        <div className="status-heading">
          <div>
            <p className="eyebrow">Bob Shell</p>
            <h2>{bob.data?.configured ? 'Ready' : 'Not connected'}</h2>
          </div>
          <Pill tone={bob.data?.lastCheckOk ? 'good' : 'warning'}>
            {bob.data?.lastCheckOk ? 'Working' : 'Needs attention'}
          </Pill>
        </div>
        <dl className="settings-details">
          <div>
            <dt>Bob version</dt>
            <dd>{bob.data?.bobVersion ?? 'Not found'}</dd>
          </div>
          <div>
            <dt>Node.js version</dt>
            <dd>{bob.data?.nodeVersion ?? 'Not found'}</dd>
          </div>
          <div>
            <dt>Program location</dt>
            <dd>{bob.data?.binaryPath ?? 'Automatic'}</dd>
          </div>
        </dl>
        <div className="button-row wrap">
          <Button
            className="button-secondary"
            onClick={() => void ipc['bob:check']().then(() => bob.refetch())}
          >
            Test again
          </Button>
          <Button
            className="button-secondary"
            onClick={() =>
              void window.bobDeploy?.pickFile({ title: 'Choose the Bob program' }).then((path) => {
                if (path)
                  void ipc['bob:save']({
                    keyType: bob.data?.keyType ?? 'inference',
                    binaryPath: path,
                    acceptLicense: true,
                  }).then(() => bob.refetch());
              })
            }
          >
            Choose program
          </Button>
        </div>
      </Card>
      {returnTo && !bob.data?.configured ? (
        <Card>
          <p className="eyebrow">Project added</p>
          <h2>Connect Bob to continue</h2>
          <p>Bob needs a valid API key before it can inspect and publish your project.</p>
        </Card>
      ) : null}
      <Card>
        <h2>API key</h2>
        {!replace && bob.data?.keySaved ? (
          <div className="settings-row">
            <p className="success-line">
              <Check aria-hidden="true" />
              Key saved
            </p>
            <div className="button-row">
              <Button className="button-secondary" onClick={() => setReplace(true)}>
                Replace API key
              </Button>
              <Button className="button-secondary" onClick={() => setConfirmRemove(true)}>
                <Trash2 aria-hidden="true" />
                Remove Bob key
              </Button>
            </div>
          </div>
        ) : (
          <form
            onSubmit={(event) => {
              void save(event);
            }}
          >
            <PasswordField
              label="New API key"
              autoComplete="off"
              error={form.formState.errors.apiKey?.message}
              {...form.register('apiKey', { required: 'Enter an API key.' })}
            />
            <div className="radio-row">
              <label>
                <input type="radio" value="inference" {...form.register('keyType')} />
                Inference
              </label>
              <label>
                <input type="radio" value="general" {...form.register('keyType')} />
                General
              </label>
            </div>
            {keyType === 'general' ? (
              <Field label="Team ID" {...form.register('teamId', { required: 'Enter the team ID.' })} />
            ) : null}
            <Button>Test and save</Button>
          </form>
        )}
      </Card>
      {checks.length ? (
        <Card>
          <h2>Connection check</h2>
          <ul className="check-list" aria-live="polite">
            {checks.map((check) => (
              <li key={check.step}>
                <span aria-hidden="true">{check.ok ? '✓' : '✗'}</span>
                <span>{check.message}</span>
              </li>
            ))}
          </ul>
        </Card>
      ) : null}
      {actionError ? (
        <p className="form-error" role="alert">
          {actionError}
        </p>
      ) : null}
      {confirmRemove ? (
        <Dialog title="Remove Bob key?" onClose={() => setConfirmRemove(false)}>
          <p>Deployments will pause until you add another key.</p>
          <Button onClick={() => void remove()}>Remove key</Button>
        </Dialog>
      ) : null}
      {message ? <Toast>{message}</Toast> : null}
    </div>
  );
}

const tokenPages: Record<HostId, string> = {
  netlify: 'https://app.netlify.com/user/applications#personal-access-tokens',
  vercel: 'https://vercel.com/account/tokens',
};

function HostingSettings() {
  const hosts = useHosts();
  const ipc = useIpc();
  const queryClient = useQueryClient();
  const [removeHost, setRemoveHost] = useState<HostId>();
  const [revoked, setRevoked] = useState<HostId>();
  const [actionError, setActionError] = useState('');
  const forms = {
    netlify: useForm<{ token: string; teamId: string }>({ defaultValues: { token: '', teamId: '' } }),
    vercel: useForm<{ token: string; teamId: string }>({ defaultValues: { token: '', teamId: '' } }),
  };
  if (hosts.isLoading) return <Skeleton label="Loading hosting settings" />;
  if (hosts.error) return <ErrorState message={hosts.error.message} retry={() => void hosts.refetch()} />;
  async function save(host: HostId, token: string, teamId?: string) {
    const result = await ipc['hosts:saveToken']({ host, token, teamId: teamId || undefined });
    forms[host].reset();
    if (!result.ok) {
      forms[host].setError('token', {
        message:
          result.error.code === 'HOST_AUTH_FAILED' ? 'That token was not accepted.' : result.error.message,
      });
      return;
    }
    await queryClient.invalidateQueries({ queryKey: ['hosts'] });
  }
  async function remove() {
    if (!removeHost) return;
    const host = removeHost;
    const result = await ipc['hosts:revokeToken']({ host });
    if (!result.ok) {
      setActionError(result.error.message);
      return;
    }
    await queryClient.invalidateQueries({ queryKey: ['hosts'] });
    setRemoveHost(undefined);
    setRevoked(host);
  }
  return (
    <div className="host-grid">
      {actionError ? (
        <p className="form-error" role="alert">
          {actionError}
        </p>
      ) : null}
      {(['netlify', 'vercel'] as const).map((host) => {
        const status = hosts.data?.find((item) => item.host === host);
        const form = forms[host];
        const connect = form.handleSubmit((values) =>
          save(host, values.token, 'teamId' in values ? values.teamId : undefined),
        );
        return (
          <Card key={host} className="host-card">
            <h2>{host === 'netlify' ? 'Netlify' : 'Vercel'}</h2>
            {status?.connected ? (
              <>
                <p className="success-line">
                  <Check aria-hidden="true" />
                  Connected as {status.accountName}
                </p>
                <Button className="button-secondary" onClick={() => setRemoveHost(host)}>
                  Remove
                </Button>
              </>
            ) : (
              <form
                onSubmit={(event) => {
                  void connect(event);
                }}
              >
                <PasswordField
                  label="Token"
                  autoComplete="off"
                  error={form.formState.errors.token?.message}
                  {...form.register('token', { required: 'Enter a token.' })}
                />
                {host === 'vercel' ? (
                  <Field label="Team ID (optional)" {...forms.vercel.register('teamId')} />
                ) : null}
                <Button>Connect</Button>
              </form>
            )}
            {revoked === host ? (
              <div className="followup-card" role="status">
                Also revoke it on {host === 'netlify' ? 'Netlify' : 'Vercel'}.{' '}
                <button className="text-button" onClick={() => openExternal(tokenPages[host])}>
                  Open token page
                </button>
              </div>
            ) : null}
          </Card>
        );
      })}
      {removeHost ? (
        <Dialog
          title={`Remove ${removeHost === 'netlify' ? 'Netlify' : 'Vercel'} token?`}
          onClose={() => setRemoveHost(undefined)}
        >
          <p>Bob Deploy will forget this token.</p>
          <Button onClick={() => void remove()}>Remove token</Button>
        </Dialog>
      ) : null}
    </div>
  );
}

function ServerCard({ projectName, targetId, ip }: { projectName: string; targetId: string; ip?: string }) {
  const info = useTargetInfo(targetId);
  const ipc = useIpc();
  const form = useForm<{ password: string }>({ defaultValues: { password: '' } });
  const [dialogOpen, setDialogOpen] = useState<'passphrase' | 'download'>();
  const [secret, setSecret] = useState<{ value: string; remaining: number }>();
  const [downloaded, setDownloaded] = useState<{ command: string }>();
  useEffect(() => {
    if (!secret) return;
    const timer = window.setInterval(
      () =>
        setSecret((current) =>
          current && current.remaining > 1 ? { ...current, remaining: current.remaining - 1 } : undefined,
        ),
      1_000,
    );
    return () => window.clearInterval(timer);
  }, [secret?.value]);
  if (info.isLoading) return <Skeleton label={`Loading ${projectName}`} />;
  if (info.error) return <ErrorState message={info.error.message} retry={() => void info.refetch()} />;
  const passwordError = (error: { code: string; message: string; details?: Record<string, unknown> }) =>
    error.code === 'BAD_PASSWORD'
      ? 'That password is not right.'
      : error.code === 'TOO_MANY_ATTEMPTS'
        ? `Try again in ${Number(error.details?.retryAfterSeconds ?? 30)} seconds.`
        : error.message;
  const reveal = form.handleSubmit(async ({ password }) => {
    const result = await ipc['security:revealSshPassphrase']({ targetId, password });
    form.reset();
    if (!result.ok) {
      form.setError('password', { message: passwordError(result.error) });
      return;
    }
    setDialogOpen(undefined);
    setSecret({ value: result.data.passphrase, remaining: 30 });
  });
  const download = form.handleSubmit(async ({ password }) => {
    const result = await ipc['security:exportSshKey']({ targetId, password });
    form.reset();
    if (!result.ok) {
      form.setError('password', { message: passwordError(result.error) });
      return;
    }
    const { privateKey, fileName, adminUser, host, sshPort } = result.data;
    const saved = await window.bobDeploy?.saveTextFile({ defaultName: fileName, content: privateKey });
    setDialogOpen(undefined);
    if (!saved) return;
    const port = sshPort === 22 ? '' : ` -p ${sshPort}`;
    const keyPath =
      window.bobDeploy?.platform === 'win32' ? `"$env:USERPROFILE\\.ssh\\${fileName}"` : `~/.ssh/${fileName}`;
    setDownloaded({ command: `ssh -i ${keyPath}${port} ${adminUser}@${host}` });
  });
  return (
    <Card>
      <p className="eyebrow">{projectName}</p>
      <h2>{ip ?? 'Server'}</h2>
      <dl className="settings-details">
        <div>
          <dt>Admin account</dt>
          <dd>{info.data?.adminUser}</dd>
        </div>
        <div>
          <dt>Server identity</dt>
          <dd>{info.data?.hostKeyFingerprint}</dd>
        </div>
      </dl>
      <label className="field">
        <span>Public key</span>
        <textarea readOnly value={info.data?.publicKey ?? ''} rows={3} />
      </label>
      <div className="button-row wrap">
        <Button
          className="button-secondary"
          onClick={() => void navigator.clipboard.writeText(info.data?.publicKey ?? '')}
        >
          <Copy aria-hidden="true" />
          Copy public key
        </Button>
        <Button onClick={() => setDialogOpen('passphrase')}>
          <KeyRound aria-hidden="true" />
          Show key passphrase
        </Button>
        <Button className="button-secondary" onClick={() => setDialogOpen('download')}>
          <Download aria-hidden="true" />
          Download private key
        </Button>
      </div>
      {downloaded ? (
        <div className="secret-reveal" role="status">
          <strong>Private key saved</strong>
          <p>
            Keep it in your <code>.ssh</code> folder. To connect from a terminal (it asks for the key
            passphrase, see “Show key passphrase”):
          </p>
          <output>{downloaded.command}</output>
          <Button
            className="button-secondary"
            onClick={() => void navigator.clipboard.writeText(downloaded.command)}
          >
            <Copy aria-hidden="true" />
            Copy command
          </Button>
          <small>
            This account can only run Bob Deploy’s own maintenance scripts as root. Anyone with this file and
            its passphrase can sign in to your server, so do not share it.
          </small>
        </div>
      ) : null}
      {secret ? (
        <div className="secret-reveal" role="status">
          <strong>Hidden again in {secret.remaining} seconds</strong>
          <output>{secret.value}</output>
          <Button
            className="button-secondary"
            onClick={() => void navigator.clipboard.writeText(secret.value)}
          >
            <Copy aria-hidden="true" />
            Copy
          </Button>
        </div>
      ) : null}
      {dialogOpen ? (
        <Dialog
          title={dialogOpen === 'download' ? 'Download private key' : 'Show key passphrase'}
          onClose={() => {
            form.reset();
            setDialogOpen(undefined);
          }}
        >
          <form
            onSubmit={(event) => {
              void (dialogOpen === 'download' ? download(event) : reveal(event));
            }}
          >
            <PasswordField
              label="Master password"
              autoComplete="current-password"
              autoFocus
              data-dialog-autofocus
              error={form.formState.errors.password?.message}
              {...form.register('password', { required: 'Enter your master password.' })}
            />
            <Button>{dialogOpen === 'download' ? 'Download key' : 'Show passphrase'}</Button>
          </form>
        </Dialog>
      ) : null}
    </Card>
  );
}

function ServerSettings() {
  const projects = useProjects();
  if (projects.isLoading) return <Skeleton label="Loading servers" />;
  if (projects.error)
    return <ErrorState message={projects.error.message} retry={() => void projects.refetch()} />;
  const ownServers = projects.data?.filter((project) => project.target?.kind === 'own_server') ?? [];
  if (!ownServers.length)
    return (
      <EmptyState title="No servers yet" body="Servers and keys appear after an own-server deployment." />
    );
  return (
    <div className="stack">
      {ownServers.map((project) => (
        <ServerCard
          key={project.id}
          projectName={project.name}
          targetId={project.target?.id ?? ''}
          ip={project.target?.ip}
        />
      ))}
    </div>
  );
}

interface IntervalValues {
  health: number;
  resources: number;
  analytics: number;
  maintenance: number;
}

function MonitoringSettings() {
  const settings = useSettings();
  const ipc = useIpc();
  const queryClient = useQueryClient();
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState('');
  const form = useForm<IntervalValues>({
    defaultValues: { health: 60, resources: 60, analytics: 5, maintenance: 6 },
  });
  useEffect(() => {
    const intervals = settings.data?.pollIntervals;
    if (intervals)
      form.reset({
        health: intervals.healthMs / 1_000,
        resources: intervals.resourcesMs / 1_000,
        analytics: intervals.analyticsMs / 60_000,
        maintenance: intervals.maintenanceMs / 3_600_000,
      });
  }, [form, settings.data]);
  if (settings.isLoading) return <Skeleton label="Loading monitoring settings" />;
  if (settings.error)
    return <ErrorState message={settings.error.message} retry={() => void settings.refetch()} />;
  const save = form.handleSubmit(async (values) => {
    const pollIntervals: PollIntervals = {
      healthMs: values.health * 1_000,
      resourcesMs: values.resources * 1_000,
      analyticsMs: values.analytics * 60_000,
      maintenanceMs: values.maintenance * 3_600_000,
    };
    const result = await ipc['settings:set']({ pollIntervals });
    if (result.ok) {
      queryClient.setQueryData(['settings'], result.data);
      setSaved(true);
      setError('');
    } else setError(result.error.message);
  });
  return (
    <Card>
      <h2>Monitoring intervals</h2>
      <p>Choose how often Bob Deploy refreshes information while the app is open.</p>
      <form
        noValidate
        onSubmit={(event) => {
          void save(event);
        }}
      >
        <Field
          label="Health checks (seconds)"
          type="number"
          min={30}
          max={600}
          error={form.formState.errors.health?.message}
          {...form.register('health', {
            valueAsNumber: true,
            min: { value: 30, message: 'Choose 30 to 600 seconds.' },
            max: { value: 600, message: 'Choose 30 to 600 seconds.' },
          })}
        />
        <Field
          label="Server use (seconds)"
          type="number"
          min={30}
          max={600}
          error={form.formState.errors.resources?.message}
          {...form.register('resources', {
            valueAsNumber: true,
            min: { value: 30, message: 'Choose 30 to 600 seconds.' },
            max: { value: 600, message: 'Choose 30 to 600 seconds.' },
          })}
        />
        <Field
          label="Analytics (minutes)"
          type="number"
          min={1}
          max={60}
          error={form.formState.errors.analytics?.message}
          {...form.register('analytics', {
            valueAsNumber: true,
            min: { value: 1, message: 'Choose 1 to 60 minutes.' },
            max: { value: 60, message: 'Choose 1 to 60 minutes.' },
          })}
        />
        <Field
          label="Maintenance (hours)"
          type="number"
          min={1}
          max={24}
          error={form.formState.errors.maintenance?.message}
          {...form.register('maintenance', {
            valueAsNumber: true,
            min: { value: 1, message: 'Choose 1 to 24 hours.' },
            max: { value: 24, message: 'Choose 1 to 24 hours.' },
          })}
        />
        <Button>Save intervals</Button>
        {error ? (
          <p className="form-error" role="alert">
            {error}
          </p>
        ) : null}
        {saved ? (
          <p className="success-line" role="status">
            <Check aria-hidden="true" />
            Monitoring updated
          </p>
        ) : null}
      </form>
    </Card>
  );
}

function AppearanceSettings() {
  const settings = useSettings();
  const ipc = useIpc();
  const queryClient = useQueryClient();
  const [error, setError] = useState('');
  if (settings.isLoading) return <Skeleton label="Loading appearance" />;
  if (settings.error)
    return <ErrorState message={settings.error.message} retry={() => void settings.refetch()} />;
  async function choose(theme: 'system' | 'light' | 'dark') {
    const result = await ipc['settings:set']({ theme });
    if (!result.ok) {
      setError(result.error.message);
      return;
    }
    queryClient.setQueryData(['settings'], result.data);
    document.documentElement.dataset.theme =
      theme === 'dark' || (theme === 'system' && matchMedia('(prefers-color-scheme: dark)').matches)
        ? 'dark'
        : 'light';
  }
  return (
    <Card>
      <h2>Appearance</h2>
      <fieldset className="theme-options">
        <legend>Theme</legend>
        {(['system', 'light', 'dark'] as const).map((theme) => (
          <label key={theme}>
            <input
              type="radio"
              name="theme"
              checked={settings.data?.theme === theme}
              onChange={() => void choose(theme)}
            />
            {theme === 'system' ? 'Use system setting' : theme[0]?.toUpperCase() + theme.slice(1)}
          </label>
        ))}
      </fieldset>
      {error ? (
        <p className="form-error" role="alert">
          {error}
        </p>
      ) : null}
    </Card>
  );
}

function AboutSettings() {
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');
  const bridge = window.bobDeploy;
  return (
    <div className="stack">
      <Card>
        <p className="eyebrow">Bob Deploy</p>
        <h2>Version {bridge?.appVersion ?? 'development'}</h2>
        <div className="button-row wrap">
          <Button
            className="button-secondary"
            onClick={() => {
              void bridge?.openLogsFolder().catch(() => setError('The logs folder could not be opened.'));
            }}
          >
            <FolderOpen aria-hidden="true" />
            Open logs folder
          </Button>
          <Button
            className="button-secondary"
            onClick={() => {
              void bridge
                ?.clearViewerData()
                .then(() => setMessage('Viewer data cleared'))
                .catch(() => setError('Viewer data could not be cleared.'));
            }}
          >
            Clear viewer data
          </Button>
        </div>
        {error ? (
          <p className="form-error" role="alert">
            {error}
          </p>
        ) : null}
      </Card>
      <Card>
        <h2>Third-party licenses</h2>
        <ul className="license-list">
          {thirdPartyLicenses.map((item) => (
            <li key={item.name}>
              <span>{item.name}</span>
              <strong>{item.license}</strong>
            </li>
          ))}
        </ul>
      </Card>
      <Card>
        <h2>Credits</h2>
        <p>
          Recovery passphrases use the Electronic Frontier Foundation large wordlist under the Creative
          Commons Attribution 3.0 United States license.
        </p>
        <button
          type="button"
          className="text-button"
          onClick={() =>
            openExternal('https://www.eff.org/deeplinks/2016/07/new-wordlists-random-passphrases')
          }
        >
          Read about the EFF wordlists
        </button>
      </Card>
      {message ? <Toast>{message}</Toast> : null}
    </div>
  );
}

export function SettingsScreen() {
  const location = useLocation();
  const selected = location.pathname.split('/')[2] || 'account';
  const requestedReturnTo = new URLSearchParams(location.search).get('returnTo');
  const returnTo =
    requestedReturnTo?.startsWith('/p/') && !requestedReturnTo.startsWith('//')
      ? requestedReturnTo
      : undefined;
  const content: Record<string, ReactNode> = {
    account: <AccountSettings />,
    bob: <BobSettings returnTo={returnTo} />,
    hosting: <HostingSettings />,
    servers: <ServerSettings />,
    monitoring: <MonitoringSettings />,
    appearance: <AppearanceSettings />,
    about: <AboutSettings />,
  };
  return (
    <main className="standalone-content settings-page" id="main-content">
      <header className="settings-header">
        <p className="eyebrow">Bob Deploy</p>
        <h1>Settings</h1>
      </header>
      <div className="settings-layout">
        <nav className="settings-nav" aria-label="Settings sections">
          {sections.map(([path, label]) => (
            <NavLink
              key={path}
              to={`/settings/${path}`}
              className={({ isActive }) =>
                isActive || (path === 'account' && selected === 'account') ? 'active' : ''
              }
            >
              {label}
            </NavLink>
          ))}
        </nav>
        <section
          className="settings-content"
          aria-label={sections.find(([path]) => path === selected)?.[1] ?? 'Account'}
        >
          {content[selected] ?? content.account}
        </section>
      </div>
    </main>
  );
}
