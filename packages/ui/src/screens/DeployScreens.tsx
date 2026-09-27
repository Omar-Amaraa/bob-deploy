import {
  adminUserSchema,
  domainSchema,
  envKeySchema,
  envValueSchema,
  ipv4Schema,
  jobQuestionSchema,
  portSchema,
  siteNameSchema,
  slugifyAppName,
  type AppError,
  type ErrorCode,
  type JobEvent,
  type JobQuestion,
  type JobStatus,
  type JobStepView,
  type OwnServerInputs,
  type ProjectRecord,
} from '@bob-deploy/contracts';
import { zodResolver } from '@hookform/resolvers/zod';
import { useQuery } from '@tanstack/react-query';
import { Check, ChevronLeft, Eye, EyeOff, KeyRound, Plus, Server, Trash2, Upload } from 'lucide-react';
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { useFieldArray, useForm, type FieldError, type UseFormRegisterReturn } from 'react-hook-form';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { z } from 'zod';
import {
  Button,
  Card,
  EmptyState,
  ErrorState,
  Field,
  PasswordField,
  Pill,
  QuestionCard,
  Skeleton,
  StepList,
} from '../components/ui.js';
import { errorCopy } from '../errors/catalog.js';
import { useIpc } from '../ipc/context.js';
import { unwrap, useAccountStatus, useBobStatus, useHosts, useProjects } from '../ipc/hooks.js';
import { isTestbedSiteUrl } from '../utils/site-url.js';

interface EnvironmentRow {
  key: string;
  value: string;
}

export interface ParsedEnvironment {
  rows: EnvironmentRow[];
  skipped: number;
}

export function parseEnvironment(text: string): ParsedEnvironment {
  const rows: EnvironmentRow[] = [];
  let skipped = 0;
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const separator = line.indexOf('=');
    if (separator < 1) {
      skipped += 1;
      continue;
    }
    const key = line.slice(0, separator).trim();
    let value = line.slice(separator + 1).trim();
    if (
      value.length >= 2 &&
      ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'")))
    ) {
      value = value.slice(1, -1);
    }
    if (!envKeySchema.safeParse(key).success || !envValueSchema.safeParse(value).success) {
      skipped += 1;
      continue;
    }
    rows.push({ key, value });
  }
  return { rows, skipped };
}

const environmentRowsSchema = z
  .array(z.object({ key: envKeySchema, value: envValueSchema }))
  .superRefine((rows, context) => {
    const seen = new Set<string>();
    rows.forEach((row, index) => {
      if (seen.has(row.key)) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: [index, 'key'],
          message: 'Each environment variable name must be unique.',
        });
      }
      seen.add(row.key);
    });
  });

export const ownServerFormSchema = z
  .object({
    domain: domainSchema,
    useSslipFallback: z.boolean(),
    serverIp: ipv4Schema,
    rootUser: z.string().min(1, 'Enter the login name.').max(32, 'Use 32 characters or fewer.'),
    sshPort: portSchema,
    authMethod: z.enum(['password', 'key']),
    password: z.string(),
    privateKeyPath: z.string(),
    keyPassphrase: z.string(),
    adminUser: adminUserSchema,
    acmeEmail: z.string().trim().email('Enter a valid email address.'),
    envRows: environmentRowsSchema,
  })
  .superRefine((values, context) => {
    if (values.authMethod === 'password' && !values.password) {
      context.addIssue({ code: z.ZodIssueCode.custom, path: ['password'], message: 'Enter the password.' });
    }
    if (values.authMethod === 'key' && !values.privateKeyPath) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['privateKeyPath'],
        message: 'Choose the private key file.',
      });
    }
  });

type OwnServerFormValues = z.infer<typeof ownServerFormSchema>;

export const freeHostFormSchema = z.object({
  host: z.enum(['netlify', 'vercel']),
  siteName: siteNameSchema,
  envRows: environmentRowsSchema,
});
type FreeHostFormValues = z.infer<typeof freeHostFormSchema>;

function environmentRecord(rows: EnvironmentRow[]): Record<string, string> {
  return Object.fromEntries(rows.map((row) => [row.key, row.value]));
}

function EnvironmentEditor({
  fields,
  keyRegistration,
  valueRegistration,
  errors,
  append,
  remove,
  replace,
  note,
}: {
  fields: { id: string }[];
  keyRegistration: (index: number) => UseFormRegisterReturn;
  valueRegistration: (index: number) => UseFormRegisterReturn;
  errors?: { key?: FieldError; value?: FieldError }[];
  append: () => void;
  remove: (index: number) => void;
  replace: (rows: EnvironmentRow[]) => void;
  note?: string;
}) {
  const pasteRef = useRef<HTMLTextAreaElement>(null);
  const [revealed, setRevealed] = useState<Set<number>>(() => new Set());
  const [pasteResult, setPasteResult] = useState('');
  return (
    <fieldset className="form-section env-editor">
      <legend>Environment variables</legend>
      <p>{note ?? 'These values are kept private and sent only when the project is published.'}</p>
      {fields.map((field, index) => (
        <div className="env-row" key={field.id}>
          <Field
            label={`Name ${index + 1}`}
            error={errors?.[index]?.key?.message}
            {...keyRegistration(index)}
          />
          <div className="env-value">
            <Field
              label={`Value ${index + 1}`}
              type={revealed.has(index) ? 'text' : 'password'}
              autoComplete="off"
              error={errors?.[index]?.value?.message}
              {...valueRegistration(index)}
            />
            <button
              type="button"
              className="icon-button"
              aria-label={revealed.has(index) ? `Hide value ${index + 1}` : `Show value ${index + 1}`}
              onClick={() =>
                setRevealed((current) => {
                  const next = new Set(current);
                  if (next.has(index)) next.delete(index);
                  else next.add(index);
                  return next;
                })
              }
            >
              {revealed.has(index) ? <EyeOff aria-hidden="true" /> : <Eye aria-hidden="true" />}
            </button>
          </div>
          <button
            type="button"
            className="icon-button"
            aria-label={`Remove environment variable ${index + 1}`}
            onClick={() => remove(index)}
          >
            <Trash2 aria-hidden="true" />
          </button>
        </div>
      ))}
      <Button type="button" className="button-secondary" onClick={append}>
        <Plus aria-hidden="true" />
        Add variable
      </Button>
      <details className="env-paste">
        <summary>Paste from .env</summary>
        <label htmlFor="env-paste-value">Paste KEY=VALUE lines</label>
        <textarea id="env-paste-value" ref={pasteRef} rows={6} autoComplete="off" />
        <Button
          type="button"
          className="button-secondary"
          onClick={() => {
            const parsed = parseEnvironment(pasteRef.current?.value ?? '');
            replace(parsed.rows);
            if (pasteRef.current) pasteRef.current.value = '';
            setPasteResult(
              parsed.skipped
                ? `Added ${parsed.rows.length} and skipped ${parsed.skipped} invalid ${parsed.skipped === 1 ? 'line' : 'lines'}.`
                : `Added ${parsed.rows.length} ${parsed.rows.length === 1 ? 'variable' : 'variables'}.`,
            );
          }}
        >
          Add pasted values
        </Button>
        {pasteResult ? <p role="status">{pasteResult}</p> : null}
      </details>
    </fieldset>
  );
}

function BlockingCard({ children }: { children: ReactNode }) {
  return <Card className="blocking-card">{children}</Card>;
}

function ReviewRow({ label, value }: { label: string; value: ReactNode }) {
  return (
    <div className="review-row">
      <dt>{label}</dt>
      <dd>{value}</dd>
    </div>
  );
}

const setupSteps = [
  'Reach your server',
  'Confirm the server identity',
  'Create the admin account',
  'Secure the server',
  'Prepare the server',
  'Understand your project',
  'Install the project tools',
  'Set up the secure address',
  'Publish your site',
];

function setDeployError(
  error: AppError,
  setField: (name: keyof OwnServerFormValues, message: string) => void,
  setGeneral: (message: string) => void,
) {
  const path = error.message.split(':', 1)[0]?.replace(/^inputs\./, '');
  const fieldByPath: Record<string, keyof OwnServerFormValues> = {
    domain: 'domain',
    serverIp: 'serverIp',
    sshPort: 'sshPort',
    rootUser: 'rootUser',
    adminUser: 'adminUser',
    acmeEmail: 'acmeEmail',
    'rootAuth.password': 'password',
    'rootAuth.privateKeyPath': 'privateKeyPath',
  };
  const mapped = fieldByPath[path ?? ''];
  if (mapped) setField(mapped, error.message.replace(/^[^:]+:\s*/, ''));
  else if (error.code === 'DNS_MISMATCH') setField('domain', error.message);
  else if (error.code === 'SSH_AUTH_FAILED') setField('password', error.message);
  else
    setGeneral(
      error.code === 'JOB_RUNNING'
        ? 'Another task is running for this site. Wait for it to finish.'
        : error.message,
    );
}

function OwnServerWizard({ project, onBack }: { project: ProjectRecord; onBack: () => void }) {
  const ipc = useIpc();
  const navigate = useNavigate();
  const account = useAccountStatus();
  const [reviewing, setReviewing] = useState(false);
  const [generalError, setGeneralError] = useState('');
  const [dnsResult, setDnsResult] = useState<{
    matches: boolean;
    resolved: string[];
    alternative: string;
  }>();
  const [checkingDns, setCheckingDns] = useState(false);
  const {
    register,
    control,
    handleSubmit,
    getValues,
    setError,
    setValue,
    trigger,
    watch,
    resetField,
    formState: { errors, isSubmitting },
  } = useForm<OwnServerFormValues>({
    resolver: zodResolver(ownServerFormSchema),
    defaultValues: {
      domain: '',
      useSslipFallback: false,
      serverIp: '',
      rootUser: 'root',
      sshPort: 22,
      authMethod: 'password',
      password: '',
      privateKeyPath: '',
      keyPassphrase: '',
      adminUser: 'deploy',
      acmeEmail: account.data?.email ?? '',
      envRows: [],
    },
  });
  const environment = useFieldArray({ control, name: 'envRows' });
  const authMethod = watch('authMethod');
  const values = reviewing ? getValues() : undefined;
  useEffect(() => {
    if (account.data?.email && !getValues('acmeEmail')) {
      setValue('acmeEmail', account.data.email, { shouldValidate: true });
    }
  }, [account.data?.email, getValues, setValue]);

  async function checkDns() {
    if (!(await trigger(['domain', 'serverIp']))) return;
    setCheckingDns(true);
    setDnsResult(undefined);
    const { domain, serverIp } = getValues();
    const result = await ipc['dns:check']({ domain, ip: serverIp });
    setCheckingDns(false);
    if (!result.ok) {
      setError('domain', { message: result.error.message });
      return;
    }
    setDnsResult({
      matches: result.data.matches,
      resolved: result.data.resolved,
      alternative: result.data.sslipAlternative,
    });
  }

  const submit = handleSubmit(async (form) => {
    if (!reviewing) {
      setReviewing(true);
      return;
    }
    setGeneralError('');
    const inputs: OwnServerInputs = {
      domain: form.domain,
      useSslipFallback: form.useSslipFallback,
      serverIp: form.serverIp,
      rootUser: form.rootUser,
      sshPort: form.sshPort,
      rootAuth:
        form.authMethod === 'password'
          ? { method: 'password', password: form.password }
          : {
              method: 'key',
              privateKeyPath: form.privateKeyPath,
              ...(form.keyPassphrase ? { keyPassphrase: form.keyPassphrase } : {}),
            },
      adminUser: form.adminUser,
      acmeEmail: form.acmeEmail,
      env: environmentRecord(form.envRows),
    };
    const result = await ipc['deploy:start']({ projectId: project.id, target: 'own_server', inputs });
    resetField('password');
    resetField('keyPassphrase');
    environment.replace([]);
    if (!result.ok) {
      setDeployError(result.error, (name, message) => setError(name, { message }), setGeneralError);
      setReviewing(false);
      return;
    }
    void navigate(`/p/${project.id}/jobs/${result.data.jobId}`);
  });

  if (reviewing && values) {
    return (
      <form
        className="stack"
        onSubmit={(event) => {
          void submit(event);
        }}
      >
        <Card>
          <p className="eyebrow">Review</p>
          <h1>Set up your server</h1>
          <dl className="review-list">
            <ReviewRow label="Project" value={project.name} />
            <ReviewRow label="Domain" value={values.domain} />
            <ReviewRow label="Server" value={`${values.serverIp}:${values.sshPort}`} />
            <ReviewRow label="Provider login" value={values.rootUser} />
            <ReviewRow
              label="Sign-in method"
              value={
                values.authMethod === 'password'
                  ? 'Password ••••'
                  : `Key file ${values.privateKeyPath}${values.keyPassphrase ? ' ••••' : ''}`
              }
            />
            <ReviewRow label="Admin account" value={values.adminUser} />
            <ReviewRow label="Certificate notices" value={values.acmeEmail} />
            <ReviewRow
              label="Environment variables"
              value={values.envRows.length ? values.envRows.map((row) => row.key).join(', ') : 'None'}
            />
          </dl>
        </Card>
        <Card>
          <h2>What Bob Deploy will do</h2>
          <ol className="review-steps">
            {setupSteps.map((step) => (
              <li key={step}>{step}</li>
            ))}
          </ol>
        </Card>
        <div className="button-row">
          <Button type="button" className="button-secondary" onClick={() => setReviewing(false)}>
            <ChevronLeft aria-hidden="true" /> Edit details
          </Button>
          <Button disabled={isSubmitting}>{isSubmitting ? 'Starting…' : 'Start setup'}</Button>
        </div>
      </form>
    );
  }

  return (
    <form
      className="stack deploy-form"
      onSubmit={(event) => {
        void submit(event);
      }}
      noValidate
    >
      <Card>
        <button type="button" className="text-button" onClick={onBack}>
          <ChevronLeft aria-hidden="true" /> Choose another option
        </button>
        <p className="eyebrow">My own server</p>
        <h1>Tell us about your server</h1>
        <Field
          label="Domain"
          help="Add an A record at your domain registrar that points to your server’s IP."
          error={errors.domain?.message}
          {...register('domain')}
        />
        <Field
          label="Server IP"
          help="Shown in your provider’s dashboard."
          error={errors.serverIp?.message}
          {...register('serverIp')}
        />
        <Button
          type="button"
          className="button-secondary"
          disabled={checkingDns}
          onClick={() => void checkDns()}
        >
          {checkingDns ? 'Checking…' : 'Check DNS'}
        </Button>
        {dnsResult ? (
          <div
            className={dnsResult.matches ? 'dns-result dns-success' : 'dns-result dns-failure'}
            role="status"
          >
            <strong>
              {dnsResult.matches
                ? '✓ Your domain points to this server'
                : `✗ Your domain points to ${dnsResult.resolved.join(', ') || 'nothing yet'}. It can take up to a few hours after changing it.`}
            </strong>
            {!dnsResult.matches ? <p>You can use {dnsResult.alternative} until it is ready.</p> : null}
          </div>
        ) : null}
        <label className="checkbox-row">
          <input type="checkbox" {...register('useSslipFallback')} />
          <span>
            <strong>Use a temporary address until DNS works</strong>
            <small>
              Your site will run at your server IP followed by .sslip.io until your domain is ready.
            </small>
          </span>
        </label>
      </Card>
      <Card>
        <h2>Sign in for setup</h2>
        <p>This is used once to set up the server and is never saved.</p>
        <fieldset className="choice-grid compact">
          <legend>Sign-in method</legend>
          <label>
            <input
              type="radio"
              value="password"
              {...register('authMethod', {
                onChange: () => {
                  resetField('privateKeyPath');
                  resetField('keyPassphrase');
                },
              })}
            />
            Password
          </label>
          <label>
            <input
              type="radio"
              value="key"
              {...register('authMethod', {
                onChange: () => resetField('password'),
              })}
            />
            Key file
          </label>
        </fieldset>
        {authMethod === 'password' ? (
          <PasswordField
            label="Password"
            autoComplete="off"
            error={errors.password?.message}
            {...register('password')}
          />
        ) : (
          <>
            <div className="file-field">
              <Field
                label="Key file"
                readOnly
                error={errors.privateKeyPath?.message}
                {...register('privateKeyPath')}
              />
              <Button
                type="button"
                className="button-secondary"
                onClick={() => {
                  void window.bobDeploy
                    ?.pickFile({ title: 'Choose private key' })
                    .then((path) => path && setValue('privateKeyPath', path, { shouldValidate: true }));
                }}
              >
                <KeyRound aria-hidden="true" /> Choose file
              </Button>
            </div>
            <PasswordField
              label="Key passphrase (optional)"
              autoComplete="off"
              {...register('keyPassphrase')}
            />
          </>
        )}
        <details className="more-options">
          <summary>More options</summary>
          <Field
            label="Login name from your provider"
            help="Usually root. Some providers use ubuntu."
            error={errors.rootUser?.message}
            {...register('rootUser')}
          />
          <Field
            label="SSH port"
            type="number"
            min={1}
            max={65535}
            error={errors.sshPort?.message}
            {...register('sshPort', { valueAsNumber: true })}
          />
        </details>
      </Card>
      <Card>
        <h2>Secure admin account</h2>
        <Field
          label="Admin account name"
          help="Bob Deploy creates this account and signs in with a secure key from now on."
          error={errors.adminUser?.message}
          {...register('adminUser')}
        />
        <Field
          label="Certificate email"
          type="email"
          help="Let’s Encrypt uses it for certificate notices."
          error={errors.acmeEmail?.message}
          {...register('acmeEmail')}
        />
      </Card>
      <Card>
        <EnvironmentEditor
          fields={environment.fields}
          keyRegistration={(index) => register(`envRows.${index}.key`)}
          valueRegistration={(index) => register(`envRows.${index}.value`)}
          errors={errors.envRows as { key?: FieldError; value?: FieldError }[] | undefined}
          append={() => environment.append({ key: '', value: '' })}
          remove={environment.remove}
          replace={environment.replace}
        />
      </Card>
      {generalError ? (
        <p className="form-error" role="alert">
          {generalError}
        </p>
      ) : null}
      <Button disabled={isSubmitting}>Review setup</Button>
    </form>
  );
}

function FreeHostWizard({ project, onBack }: { project: ProjectRecord; onBack: () => void }) {
  const ipc = useIpc();
  const navigate = useNavigate();
  const hosts = useHosts();
  const [reviewing, setReviewing] = useState(false);
  const [generalError, setGeneralError] = useState('');
  const suggestedSiteName = slugifyAppName(project.name);
  const {
    register,
    control,
    handleSubmit,
    getValues,
    resetField,
    setError,
    watch,
    formState: { errors, isSubmitting },
  } = useForm<FreeHostFormValues>({
    resolver: zodResolver(freeHostFormSchema),
    defaultValues: {
      host: 'netlify',
      siteName: suggestedSiteName.length >= 3 ? suggestedSiteName : `site-${suggestedSiteName}`,
      envRows: [],
    },
  });
  const environment = useFieldArray({ control, name: 'envRows' });
  const selectedHost = watch('host');
  const connection = hosts.data?.find((host) => host.host === selectedHost);
  const values = reviewing ? getValues() : undefined;
  const submit = handleSubmit(async (form) => {
    if (!connection?.connected) return;
    if (!reviewing) {
      setReviewing(true);
      return;
    }
    setGeneralError('');
    const result = await ipc['deploy:start']({
      projectId: project.id,
      target: 'free',
      inputs: { host: form.host, siteName: form.siteName, env: environmentRecord(form.envRows) },
    });
    environment.replace([]);
    resetField('siteName', { defaultValue: form.siteName });
    if (!result.ok) {
      if (result.error.code === 'HOST_AUTH_FAILED') setError('host', { message: result.error.message });
      else if (result.error.code === 'VALIDATION' && result.error.message.includes('siteName')) {
        setError('siteName', { message: result.error.message.replace(/^[^:]+:\s*/, '') });
      } else {
        setGeneralError(
          result.error.code === 'JOB_RUNNING'
            ? 'Another task is running for this site. Wait for it to finish.'
            : result.error.message,
        );
      }
      setReviewing(false);
      return;
    }
    void navigate(`/p/${project.id}/jobs/${result.data.jobId}`);
  });

  if (hosts.isLoading) return <Skeleton label="Loading hosting accounts" />;
  if (hosts.error) return <ErrorState message={hosts.error.message} retry={() => void hosts.refetch()} />;
  if (reviewing && values) {
    return (
      <form className="stack" onSubmit={(event) => void submit(event)}>
        <Card>
          <p className="eyebrow">Review</p>
          <h1>Publish with free hosting</h1>
          <dl className="review-list">
            <ReviewRow label="Project" value={project.name} />
            <ReviewRow label="Host" value={values.host === 'netlify' ? 'Netlify' : 'Vercel'} />
            <ReviewRow label="Site name" value={values.siteName} />
            <ReviewRow
              label="Environment variables"
              value={values.envRows.length ? values.envRows.map((row) => row.key).join(', ') : 'None'}
            />
          </dl>
        </Card>
        <div className="button-row">
          <Button type="button" className="button-secondary" onClick={() => setReviewing(false)}>
            Edit details
          </Button>
          <Button disabled={isSubmitting}>{isSubmitting ? 'Starting…' : 'Deploy'}</Button>
        </div>
      </form>
    );
  }
  return (
    <form className="stack deploy-form" onSubmit={(event) => void submit(event)} noValidate>
      <Card>
        <button type="button" className="text-button" onClick={onBack}>
          <ChevronLeft aria-hidden="true" /> Choose another option
        </button>
        <p className="eyebrow">Free hosting</p>
        <h1>Choose where to publish</h1>
        <fieldset className="choice-grid">
          <legend>Host</legend>
          {(['netlify', 'vercel'] as const).map((host) => {
            const status = hosts.data?.find((item) => item.host === host);
            return (
              <label key={host}>
                <input type="radio" value={host} {...register('host')} />
                <span>
                  <strong>{host === 'netlify' ? 'Netlify' : 'Vercel'}</strong>
                  <small>
                    {status?.connected
                      ? `Connected as ${status.accountName ?? 'your account'}`
                      : 'Not connected'}
                  </small>
                </span>
              </label>
            );
          })}
        </fieldset>
        {errors.host ? (
          <p className="field-error" role="alert">
            {errors.host.message}
          </p>
        ) : null}
        {!connection?.connected ? (
          <BlockingCard>
            <h2>Connect {selectedHost === 'netlify' ? 'Netlify' : 'Vercel'} first</h2>
            <p>Add a token before publishing to this host.</p>
            <Link className="button link-button" to="/settings/hosting">
              Connect
            </Link>
          </BlockingCard>
        ) : null}
        <Field label="Site name" error={errors.siteName?.message} {...register('siteName')} />
      </Card>
      <Card>
        <EnvironmentEditor
          fields={environment.fields}
          keyRegistration={(index) => register(`envRows.${index}.key`)}
          valueRegistration={(index) => register(`envRows.${index}.value`)}
          errors={errors.envRows as { key?: FieldError; value?: FieldError }[] | undefined}
          append={() => environment.append({ key: '', value: '' })}
          remove={environment.remove}
          replace={environment.replace}
          note="Used when building your site."
        />
      </Card>
      {generalError ? (
        <p className="form-error" role="alert">
          {generalError}
        </p>
      ) : null}
      <Button disabled={isSubmitting || !connection?.connected}>Review deployment</Button>
    </form>
  );
}

export function DeployWizard() {
  const { projectId = '' } = useParams();
  const projects = useProjects();
  const bob = useBobStatus();
  const [target, setTarget] = useState<'own' | 'free'>();
  if (projects.isLoading || bob.isLoading) return <Skeleton label="Loading deployment options" />;
  if (projects.error || bob.error) {
    const error = projects.error ?? bob.error;
    return (
      <ErrorState
        message={error?.message ?? 'Could not load deployment options.'}
        retry={() => {
          void projects.refetch();
          void bob.refetch();
        }}
      />
    );
  }
  const project = projects.data?.find((item) => item.id === projectId);
  if (!project) return <EmptyState title="Project not found" body="Choose another project." />;
  if (!bob.data?.configured) {
    return (
      <BlockingCard>
        <h1>Connect Bob first</h1>
        <p>Bob needs to be connected before it can prepare and publish this project.</p>
        <Link className="button link-button" to="/settings/bob">
          Open Bob settings
        </Link>
      </BlockingCard>
    );
  }
  if (target === 'own') return <OwnServerWizard project={project} onBack={() => setTarget(undefined)} />;
  if (target === 'free') return <FreeHostWizard project={project} onBack={() => setTarget(undefined)} />;
  return (
    <div className="stack">
      <div>
        <p className="eyebrow">Put project online</p>
        <h1>Where should {project.name} run?</h1>
      </div>
      <div className="target-grid">
        <button className="target-card" onClick={() => setTarget('own')}>
          <Server aria-hidden="true" />
          <strong>My own server</strong>
          <span>Best for apps with a backend. You rent a small server (VPS) from a provider.</span>
        </button>
        <button className="target-card" onClick={() => setTarget('free')}>
          <Upload aria-hidden="true" />
          <strong>Free hosting</strong>
          <span>Best for simple sites. Uses your Netlify or Vercel account.</span>
        </button>
      </div>
    </div>
  );
}

interface JobViewState {
  steps: JobStepView[];
  events: JobEvent[];
  lastSeq: number;
  pendingQuestion?: JobQuestion;
  status: JobStatus;
  siteUrl?: string;
  errorCode?: ErrorCode;
}

function rebuildJobState(base: JobViewState, events: JobEvent[]): JobViewState {
  const unique = [...new Map(events.map((event) => [event.seq, event])).values()].sort(
    (a, b) => a.seq - b.seq,
  );
  const steps = base.steps.map((step) => ({ ...step }));
  let pendingQuestion = base.pendingQuestion;
  let status = base.status;
  let siteUrl = base.siteUrl;
  let errorCode = base.errorCode;
  for (const event of unique) {
    const step = steps.find((item) => item.id === event.stepId);
    if (event.type === 'step_started' && step) step.status = 'running';
    if (event.type === 'step_finished' && step) step.status = 'succeeded';
    if (event.type === 'error') {
      if (step) step.status = 'failed';
      const code = event.data?.code;
      if (typeof code === 'string') errorCode = code as ErrorCode;
    }
    if (event.type === 'question') {
      const parsed = jobQuestionSchema.safeParse(event.data);
      if (parsed.success) pendingQuestion = parsed.data;
      status = 'waiting_user';
    }
    if (event.type === 'answer') {
      pendingQuestion = undefined;
      status = 'running';
    }
    if (event.type === 'done') {
      const doneStatus = event.data?.status;
      if (typeof doneStatus === 'string') status = doneStatus as JobStatus;
      if (typeof event.data?.siteUrl === 'string') siteUrl = event.data.siteUrl;
      pendingQuestion = undefined;
    }
  }
  return {
    ...base,
    steps,
    events: unique,
    lastSeq: unique.at(-1)?.seq ?? base.lastSeq,
    pendingQuestion,
    status,
    siteUrl,
    errorCode,
  };
}

export function reduceJobEvent(state: JobViewState, event: JobEvent): JobViewState {
  if (event.jobId && state.events.some((item) => item.seq === event.seq)) return state;
  return rebuildJobState(state, [...state.events, event]);
}

function ChangePanel({ events }: { events: JobEvent[] }) {
  const changes = events.flatMap((event): Record<string, unknown>[] => {
    const change = event.type === 'change' ? event.data?.change : undefined;
    return change && typeof change === 'object' ? [change as Record<string, unknown>] : [];
  });
  if (!changes.length) return null;
  const files = changes.filter((change) => change.kind === 'file');
  const commands = changes.filter((change) => change.kind === 'command');
  return (
    <Card>
      <h2>What Bob changed</h2>
      {files.length ? (
        <ul className="change-list">
          {files.map((change, index) => (
            <li key={`${String(change.path)}-${index}`}>
              <Pill>{String(change.action)}</Pill>
              <code>{String(change.path)}</code>
            </li>
          ))}
        </ul>
      ) : null}
      {commands.length ? (
        <div className="command-list">
          {commands.map((change, index) => (
            <div key={`${String(change.cmd)}-${index}`}>
              <code>{String(change.cmd)}</code>
              <span>Exit code {String(change.code)}</span>
            </div>
          ))}
        </div>
      ) : null}
    </Card>
  );
}

function JobError({ code, fallback }: { code?: ErrorCode; fallback?: string }) {
  if (!code) return fallback ? <p>{fallback}</p> : null;
  const copy = errorCopy({ code, message: fallback ?? '' });
  return (
    <div>
      <strong>{copy.title}</strong>
      <p>{fallback || copy.body}</p>
      {copy.action === 'Open logs' ? (
        <Button className="button-secondary" onClick={() => void window.bobDeploy?.openLogsFolder()}>
          Open logs
        </Button>
      ) : null}
    </div>
  );
}

export function JobScreen() {
  const { projectId = '', jobId = '' } = useParams();
  const ipc = useIpc();
  const navigate = useNavigate();
  const jobQuery = useQuery({
    queryKey: ['job', jobId],
    queryFn: async () => unwrap(await ipc['job:get']({ jobId })),
    enabled: Boolean(jobId),
  });
  const [state, setState] = useState<JobViewState>();
  const [showDetails, setShowDetails] = useState(false);
  const [actionError, setActionError] = useState('');
  const lastSeq = useRef(0);
  useEffect(() => {
    if (!jobQuery.data || state) return;
    const initial: JobViewState = {
      steps: jobQuery.data.steps,
      events: [],
      lastSeq: 0,
      pendingQuestion: jobQuery.data.pendingQuestion,
      status: jobQuery.data.job.status,
    };
    setState(initial);
  }, [jobQuery.data, state]);
  useEffect(() => {
    if (!jobId || !state) return;
    const unsubscribeEvents = ipc.on('job:events', (event) => {
      if (event.jobId !== jobId) return;
      lastSeq.current = Math.max(lastSeq.current, event.seq);
      setState((current) => (current ? reduceJobEvent(current, event) : current));
    });
    void ipc['job:subscribe']({ jobId, fromSeq: lastSeq.current });
    return () => {
      unsubscribeEvents();
      void ipc['job:unsubscribe']({ jobId });
    };
  }, [ipc, jobId, Boolean(state)]);

  if (jobQuery.error)
    return <ErrorState message={jobQuery.error.message} retry={() => void jobQuery.refetch()} />;
  if (jobQuery.isLoading || !state) return <Skeleton label="Loading task" />;
  const job = jobQuery.data?.job;
  if (!job) return <EmptyState title="Task not found" body="Return to the project home and try again." />;
  const active = ['queued', 'running', 'waiting_user'].includes(state.status);
  const logsByStep = new Map<string, JobEvent[]>();
  for (const event of state.events.filter((item) => item.type === 'step_log')) {
    if (!event.stepId) continue;
    logsByStep.set(event.stepId, [...(logsByStep.get(event.stepId) ?? []), event]);
  }
  const lastError = [...state.events].reverse().find((event) => event.type === 'error');
  const done = [...state.events].reverse().find((event) => event.type === 'done');

  async function answer(value: string | boolean) {
    const question = state?.pendingQuestion;
    if (!question) return;
    setActionError('');
    const result = await ipc['job:answer']({ jobId, questionId: question.questionId, value });
    if (!result.ok) {
      setActionError(result.error.message);
      return;
    }
    setState((current) =>
      current ? { ...current, pendingQuestion: undefined, status: 'running' } : current,
    );
  }

  async function startUpdate() {
    setActionError('');
    const result = await ipc['update:start']({ projectId });
    if (!result.ok) {
      setActionError(
        result.error.code === 'JOB_RUNNING'
          ? 'Another task is running for this site. Wait for it to finish.'
          : result.error.message,
      );
      return;
    }
    void navigate(`/p/${projectId}/jobs/${result.data.jobId}`);
  }

  return (
    <div className="stack job-screen">
      <Card>
        <div className="status-heading">
          <div>
            <p className="eyebrow">Bob’s task</p>
            <h1>{job.summary ?? job.kind.replaceAll('_', ' ')}</h1>
          </div>
          <Pill
            tone={
              state.status === 'succeeded'
                ? 'good'
                : state.status === 'failed' || state.status === 'rolled_back'
                  ? 'bad'
                  : 'warning'
            }
          >
            {state.status.replace('_', ' ')}
          </Pill>
        </div>
        <StepList steps={state.steps} />
        <div className="job-step-logs">
          {state.steps.map((step) => {
            const logs = logsByStep.get(step.id) ?? [];
            if (!logs.length) return null;
            return (
              <details key={step.id} open={step.status === 'running' || step.status === 'failed'}>
                <summary>{step.name} messages</summary>
                <ul>
                  {logs.map((event) => (
                    <li key={event.seq}>{event.message}</li>
                  ))}
                </ul>
              </details>
            );
          })}
        </div>
        {state.events.some((event) => event.data && event.type !== 'change' && event.type !== 'question') ? (
          <>
            <Button className="button-secondary" onClick={() => setShowDetails((value) => !value)}>
              {showDetails ? 'Hide details' : 'Show details'}
            </Button>
            {showDetails ? (
              <pre className="job-details">
                {JSON.stringify(
                  state.events
                    .filter((event) => event.data)
                    .map((event) => ({ seq: event.seq, type: event.type, data: event.data })),
                  null,
                  2,
                )}
              </pre>
            ) : null}
          </>
        ) : null}
      </Card>
      {state.pendingQuestion ? (
        <QuestionCard question={state.pendingQuestion} onAnswer={(value) => void answer(value)} />
      ) : null}
      {actionError ? (
        <p className="form-error" role="alert">
          {actionError}
        </p>
      ) : null}
      <ChangePanel events={state.events} />
      {active ? (
        <Button
          className="button-secondary danger-button"
          onClick={() => {
            if (window.confirm('Cancel this task?'))
              void ipc['job:cancel']({ jobId }).then((result) => {
                if (result.ok)
                  setState((current) => (current ? { ...current, status: 'cancelled' } : current));
                else setActionError(result.error.message);
              });
          }}
        >
          Cancel task
        </Button>
      ) : null}
      {!active ? (
        <Card className={state.status === 'succeeded' ? 'done-banner' : 'error-state'} role="status">
          {state.status === 'succeeded' ? (
            <>
              <Check aria-hidden="true" />
              <h2>Your site is ready</h2>
              {state.siteUrl ? (
                <Button
                  onClick={() => {
                    if (isTestbedSiteUrl(state.siteUrl!)) void navigate(`/p/${projectId}/viewer`);
                    else void window.bobDeploy?.openExternal(state.siteUrl!);
                  }}
                >
                  Open site
                </Button>
              ) : null}
              {job.kind === 'deploy_own_server' ? (
                <Button className="button-secondary" onClick={() => void navigate('/settings/servers')}>
                  <KeyRound aria-hidden="true" />
                  Download SSH key
                </Button>
              ) : null}
            </>
          ) : (
            <>
              <h2>
                {state.status === 'rolled_back'
                  ? 'The previous version is still live'
                  : 'Bob could not finish this task'}
              </h2>
              <JobError code={state.errorCode} fallback={lastError?.message ?? done?.message} />
            </>
          )}
          <div className="button-row">
            <Link className="button link-button button-secondary" to={`/p/${projectId}/home`}>
              Back to home
            </Link>
            {job.kind === 'update' ? <Button onClick={() => void startUpdate()}>Update again</Button> : null}
          </div>
        </Card>
      ) : null}
    </div>
  );
}
