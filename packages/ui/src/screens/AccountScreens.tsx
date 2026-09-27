import type { BobCheckResult, HostId, PasswordStrength } from '@bob-deploy/contracts';
import { useQueryClient } from '@tanstack/react-query';
import { zxcvbn, zxcvbnOptions } from '@zxcvbn-ts/core';
import * as common from '@zxcvbn-ts/language-common';
import * as english from '@zxcvbn-ts/language-en';
import { Check, CircleX, ExternalLink, Printer, Save, Copy } from 'lucide-react';
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { useForm } from 'react-hook-form';
import { Link, Navigate, useLocation, useNavigate } from 'react-router-dom';
import { Button, Card, Field, PasswordField, Toast } from '../components/ui.js';
import { BrandLogo } from '../components/BrandLogo.js';
import { useIpc } from '../ipc/context.js';
import { useAccountStatus } from '../ipc/hooks.js';

zxcvbnOptions.setOptions({
  dictionary: { ...common.dictionary, ...english.dictionary },
  graphs: common.adjacencyGraphs,
  translations: english.translations,
});

const strengthLabels = ['Very weak', 'Weak', 'Fair', 'Strong', 'Very strong'] as const;
const bobDocs = 'https://bob.ibm.com/docs/shell/getting-started/install-and-setup';
const bobKeys = 'https://bob.ibm.com/docs/ide/account/api-keys';

function openExternal(url: string) {
  if (window.bobDeploy) void window.bobDeploy.openExternal(url);
  else window.open(url, '_blank', 'noopener,noreferrer');
}

export function usePasswordStrength(password: string, userInputs: string[]) {
  const ipc = useIpc();
  const [authoritative, setAuthoritative] = useState<PasswordStrength>();
  const inputsKey = userInputs.join('\u0000');
  const stableInputs = useMemo(() => (inputsKey ? inputsKey.split('\u0000') : []), [inputsKey]);
  const local = useMemo(() => zxcvbn(password, stableInputs), [password, stableInputs]);
  useEffect(() => {
    setAuthoritative(undefined);
    if (!password) return;
    const timer = window.setTimeout(() => {
      void ipc['account:checkPassword']({ password, userInputs: stableInputs }).then((result) => {
        if (result.ok) setAuthoritative(result.data);
      });
    }, 250);
    return () => window.clearTimeout(timer);
  }, [ipc, password, stableInputs]);
  return { local, authoritative };
}

export function StrengthMeter({ password, userInputs }: { password: string; userInputs: string[] }) {
  const { local, authoritative } = usePasswordStrength(password, userInputs);
  const score = local.score;
  const warning = authoritative?.warning ?? local.feedback.warning;
  const suggestion = authoritative?.suggestions[0] ?? local.feedback.suggestions[0];
  return (
    <div className="strength" aria-live="polite" data-password-ok={authoritative?.ok ? 'true' : 'false'}>
      <div className="strength-bars" aria-hidden="true">
        {strengthLabels.map((_, index) => (
          <span key={index} className={index <= score ? 'filled' : ''} />
        ))}
      </div>
      <strong>{password ? strengthLabels[score] : 'Enter a password'}</strong>
      {warning ? <span>{warning}</span> : null}
      {suggestion ? <span>{suggestion}</span> : null}
    </div>
  );
}

interface AccountFormValues {
  displayName: string;
  email: string;
  masterPassword: string;
  confirmPassword: string;
  understood: boolean;
}

function CreateAccount({ onCreated }: { onCreated: (code: string) => void }) {
  const ipc = useIpc();
  const queryClient = useQueryClient();
  const {
    register,
    handleSubmit,
    watch,
    reset,
    formState: { errors, isSubmitting },
  } = useForm<AccountFormValues>({
    defaultValues: { displayName: '', email: '', masterPassword: '', confirmPassword: '', understood: false },
  });
  const name = watch('displayName');
  const email = watch('email');
  const password = watch('masterPassword');
  const confirm = watch('confirmPassword');
  const understood = watch('understood');
  const { authoritative } = usePasswordStrength(password, [name, email]);
  const [serverError, setServerError] = useState('');

  const submit = handleSubmit(async (values) => {
    setServerError('');
    const result = await ipc['account:create']({
      displayName: values.displayName.trim(),
      email: values.email.trim(),
      masterPassword: values.masterPassword,
    });
    reset();
    if (!result.ok) {
      setServerError(
        result.error.code === 'WEAK_PASSWORD' ? 'Choose a stronger password.' : result.error.message,
      );
      return;
    }
    void queryClient.invalidateQueries({ queryKey: ['account'] });
    onCreated(result.data.recoveryCode);
  });

  return (
    <OnboardingFrame step={2} title="Create your account">
      <form
        onSubmit={(event) => {
          void submit(event);
        }}
        noValidate
      >
        <Field
          label="Your name"
          autoComplete="name"
          error={errors.displayName?.message}
          {...register('displayName', {
            required: 'Enter your name.',
            minLength: { value: 1, message: 'Enter your name.' },
            maxLength: { value: 60, message: 'Use 60 characters or fewer.' },
          })}
        />
        <Field
          label="Email"
          type="email"
          autoComplete="email"
          help="Used for HTTPS certificate notices. Stays on this computer."
          error={errors.email?.message}
          {...register('email', {
            required: 'Enter your email.',
            pattern: { value: /^[^\s@]+@[^\s@]+\.[^\s@]+$/, message: 'Enter a valid email address.' },
          })}
        />
        <PasswordField
          label="Master password"
          autoComplete="new-password"
          error={errors.masterPassword?.message}
          {...register('masterPassword', {
            required: 'Enter a password.',
            minLength: { value: 12, message: 'Use at least 12 characters.' },
          })}
        />
        <StrengthMeter password={password} userInputs={[name, email]} />
        <ul className="password-checks">
          <li className={password.length >= 12 ? 'met' : ''}>At least 12 characters</li>
          <li className={authoritative?.ok ? 'met' : ''}>Strong enough</li>
        </ul>
        <PasswordField
          label="Confirm password"
          autoComplete="new-password"
          error={errors.confirmPassword?.message}
          {...register('confirmPassword', {
            required: 'Confirm your password.',
            validate: (value) => value === password || 'Passwords do not match.',
          })}
        />
        <label className="check-row">
          <input type="checkbox" {...register('understood')} />I understand Bob Deploy cannot reset this
          password. The recovery code on the next screen is the only way back in.
        </label>
        {serverError ? (
          <p className="form-error" role="alert">
            {serverError}
          </p>
        ) : null}
        <Button
          type="submit"
          disabled={isSubmitting || !authoritative?.ok || confirm !== password || !understood}
        >
          {isSubmitting ? 'Creating account…' : 'Create account'}
        </Button>
      </form>
    </OnboardingFrame>
  );
}

function formatCode(code: string) {
  return code.match(/.{1,4}/g)?.join(' ') ?? code;
}

export function RecoveryCodeScreen({
  code,
  onContinue,
  title = 'Save your recovery code',
  embedded = false,
}: {
  code: string;
  onContinue: () => void;
  title?: string;
  embedded?: boolean;
}) {
  const [confirmation, setConfirmation] = useState('');
  const [copied, setCopied] = useState(false);
  const expected = code.slice(-4).toUpperCase();
  useEffect(() => {
    const warn = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = '';
    };
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, []);
  async function copy() {
    await navigator.clipboard.writeText(code);
    setCopied(true);
    window.setTimeout(() => setCopied(false), 2_000);
  }
  const content = (
    <>
      <p>This is the only way back in if you forget your master password. Keep it somewhere safe.</p>
      <output className="recovery-code" aria-label="Recovery code">
        {formatCode(code)}
      </output>
      <div className="button-row wrap">
        <Button type="button" className="button-secondary" onClick={() => void copy()}>
          <Copy aria-hidden="true" />
          {copied ? 'Copied' : 'Copy'}
        </Button>
        <Button
          type="button"
          className="button-secondary"
          onClick={() =>
            void window.bobDeploy?.saveTextFile({
              defaultName: 'bob-deploy-recovery-code.txt',
              content: `${formatCode(code)}\n`,
            })
          }
        >
          <Save aria-hidden="true" />
          Save as file
        </Button>
        <Button
          type="button"
          className="button-secondary"
          onClick={() =>
            void window.bobDeploy?.printText({ title: 'Bob Deploy recovery code', content: formatCode(code) })
          }
        >
          <Printer aria-hidden="true" />
          Print
        </Button>
      </div>
      <Field
        label="Type the last 4 characters to confirm"
        value={confirmation}
        onChange={(event) => setConfirmation(event.target.value.toUpperCase())}
        maxLength={4}
        autoComplete="off"
      />
      <Button disabled={confirmation !== expected} onClick={onContinue}>
        Continue
      </Button>
    </>
  );
  if (embedded)
    return (
      <Card>
        <h2>{title}</h2>
        {content}
      </Card>
    );
  return (
    <OnboardingFrame step={3} title={title}>
      {content}
    </OnboardingFrame>
  );
}

function OnboardingFrame({ step, title, children }: { step: number; title: string; children: ReactNode }) {
  return (
    <main className="centered-page" id="main-content">
      <Card className="onboarding-card">
        <div
          className="onboarding-progress"
          role="progressbar"
          aria-label="Onboarding progress"
          aria-valuemin={1}
          aria-valuemax={6}
          aria-valuenow={step}
          aria-valuetext={`Step ${step} of 6`}
        >
          <span style={{ width: `${(step / 6) * 100}%` }} />
        </div>
        <p className="eyebrow">Step {step} of 6</p>
        <h1>{title}</h1>
        {children}
      </Card>
    </main>
  );
}

interface BobFormValues {
  apiKey: string;
  keyType: 'inference' | 'general';
  teamId: string;
  acceptLicense: boolean;
}

function BobSetup({ onContinue }: { onContinue: () => void }) {
  const ipc = useIpc();
  const {
    register,
    handleSubmit,
    watch,
    resetField,
    formState: { isSubmitting },
  } = useForm<BobFormValues>({
    defaultValues: { apiKey: '', keyType: 'inference', teamId: '', acceptLicense: false },
  });
  const keyType = watch('keyType');
  const [binaryPath, setBinaryPath] = useState<string>();
  const [keySaved, setKeySaved] = useState(false);
  const [checks, setChecks] = useState<BobCheckResult[]>([]);
  const [error, setError] = useState('');
  const allPass = checks.length === 4 && checks.every((check) => check.ok);
  async function check() {
    const [status, result] = await Promise.all([ipc['bob:status'](undefined), ipc['bob:check'](undefined)]);
    if (status.ok) {
      setKeySaved(status.data.keySaved);
      setBinaryPath(status.data.binaryPath);
    }
    if (result.ok) setChecks(result.data);
  }
  useEffect(() => {
    void check();
  }, []);
  const submit = handleSubmit(async (values) => {
    setError('');
    const saved = await ipc['bob:save']({
      apiKey: values.apiKey || undefined,
      keyType: values.keyType,
      teamId: values.keyType === 'general' ? values.teamId : undefined,
      binaryPath,
      acceptLicense: values.acceptLicense,
    });
    if (!saved.ok) {
      setError(saved.error.message);
      return;
    }
    resetField('apiKey');
    setKeySaved(saved.data.keySaved);
    const result = await ipc['bob:check'](undefined);
    if (result.ok) setChecks(result.data);
    else setError(result.error.message);
  });
  async function chooseProgram() {
    const path = await window.bobDeploy?.pickFile({ title: 'Choose the Bob program' });
    if (path) setBinaryPath(path);
  }
  const fixes: Record<BobCheckResult['step'], ReactNode> = {
    binary: (
      <>
        <button type="button" className="text-button" onClick={() => openExternal(bobDocs)}>
          Open install guide
        </button>{' '}
        or{' '}
        <button type="button" className="text-button" onClick={() => void chooseProgram()}>
          choose the Bob program manually
        </button>
        .
      </>
    ),
    node: <>Install Node.js 22.15 or newer, then check again.</>,
    license: <>Accept the license terms below.</>,
    auth: <>Your key was not accepted. Check it was created with the Inference scope.</>,
  };
  return (
    <OnboardingFrame step={4} title="Connect Bob">
      <form
        onSubmit={(event) => {
          void submit(event);
        }}
      >
        <section className="form-section">
          <h2>Bob Shell on this computer</h2>
          <p>
            {binaryPath
              ? `Found at ${binaryPath}`
              : 'Bob Shell lets Bob Deploy understand and update your project.'}
          </p>
          <div className="button-row wrap">
            <Button type="button" className="button-secondary" onClick={() => openExternal(bobDocs)}>
              <ExternalLink aria-hidden="true" />
              Open install guide
            </Button>
            <Button type="button" className="button-secondary" onClick={() => void check()}>
              Check again
            </Button>
            <Button type="button" className="button-secondary" onClick={() => void chooseProgram()}>
              Choose the bob program manually
            </Button>
          </div>
        </section>
        <section className="form-section">
          <h2>Your Bob API key</h2>
          {keySaved ? (
            <p className="success-line">
              <Check aria-hidden="true" />
              Key saved{' '}
              <button type="button" className="text-button" onClick={() => setKeySaved(false)}>
                Replace
              </button>
            </p>
          ) : (
            <PasswordField
              label="API key"
              autoComplete="off"
              {...register('apiKey', { required: !keySaved })}
            />
          )}
          <div className="radio-row">
            <label>
              <input type="radio" value="inference" {...register('keyType')} />
              Inference (recommended)
            </label>
            <label>
              <input type="radio" value="general" {...register('keyType')} />
              General
            </label>
          </div>
          {keyType === 'general' ? (
            <Field label="Team ID" {...register('teamId', { required: true })} />
          ) : null}
          <button type="button" className="text-button" onClick={() => openExternal(bobKeys)}>
            Create a key in the Bob portal
          </button>
        </section>
        <label className="check-row">
          <input type="checkbox" {...register('acceptLicense')} />I accept IBM Bob's license terms.
        </label>
        {checks.length ? (
          <ul className="check-results" aria-live="polite">
            {checks.map((item) => (
              <li key={item.step} className={item.ok ? 'passed' : 'failed'}>
                {item.ok ? <Check aria-hidden="true" /> : <CircleX aria-hidden="true" />}
                <div>
                  <strong>{item.message}</strong>
                  {item.value ? <span>{item.value}</span> : null}
                  {!item.ok ? <small>{fixes[item.step]}</small> : null}
                </div>
              </li>
            ))}
          </ul>
        ) : null}
        {error ? (
          <p className="form-error" role="alert">
            {error}
          </p>
        ) : null}
        <div className="button-row">
          <Button type="submit" disabled={isSubmitting}>
            {isSubmitting ? 'Testing…' : 'Test and save'}
          </Button>
          <Button
            type="button"
            className="button-secondary"
            onClick={allPass ? onContinue : undefined}
            disabled={!allPass}
          >
            Continue
          </Button>
          <Button type="button" className="button-secondary" onClick={onContinue}>
            Skip for now
          </Button>
        </div>
      </form>
    </OnboardingFrame>
  );
}

interface HostValues {
  token: string;
  teamId: string;
}
function HostCard({ host }: { host: HostId }) {
  const ipc = useIpc();
  const {
    register,
    handleSubmit,
    reset,
    formState: { isSubmitting },
  } = useForm<HostValues>({ defaultValues: { token: '', teamId: '' } });
  const [account, setAccount] = useState('');
  const [error, setError] = useState('');
  const submit = handleSubmit(async (values) => {
    setError('');
    const result = await ipc['hosts:saveToken']({
      host,
      token: values.token,
      teamId: values.teamId || undefined,
    });
    reset();
    if (!result.ok) {
      setError(
        result.error.code === 'HOST_AUTH_FAILED' ? 'That token was not accepted.' : result.error.message,
      );
      return;
    }
    setAccount(result.data.accountName ?? 'Connected');
  });
  const isNetlify = host === 'netlify';
  return (
    <Card className="host-card">
      <h2>{isNetlify ? 'Netlify' : 'Vercel'}</h2>
      {account ? (
        <p className="success-line">
          <Check aria-hidden="true" />
          Connected as {account}
        </p>
      ) : (
        <form
          onSubmit={(event) => {
            void submit(event);
          }}
        >
          <PasswordField label="Token" autoComplete="off" {...register('token', { required: true })} />
          {!isNetlify ? <Field label="Team ID (optional)" {...register('teamId')} /> : null}
          <Button disabled={isSubmitting}>{isSubmitting ? 'Connecting…' : 'Connect'}</Button>
        </form>
      )}
      {error ? (
        <p className="form-error" role="alert">
          {error}
        </p>
      ) : null}
      <button
        className="text-button"
        type="button"
        onClick={() =>
          openExternal(
            isNetlify
              ? 'https://app.netlify.com/user/applications#personal-access-tokens'
              : 'https://vercel.com/account/tokens',
          )
        }
      >
        Create a {isNetlify ? 'personal access token' : 'token'}
      </button>
    </Card>
  );
}

function HostingSetup({ onContinue }: { onContinue: () => void }) {
  return (
    <OnboardingFrame step={5} title="Free hosting (optional)">
      <p>Connect an account now, or skip this until your first deployment.</p>
      <div className="host-grid">
        <HostCard host="netlify" />
        <HostCard host="vercel" />
      </div>
      <Button className="button-secondary" onClick={onContinue}>
        Skip for now
      </Button>
    </OnboardingFrame>
  );
}

function AllSet() {
  const ipc = useIpc();
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const [error, setError] = useState('');
  async function finish() {
    const result = await ipc['account:completeOnboarding'](undefined);
    if (!result.ok) {
      setError(result.error.message);
      return;
    }
    queryClient.setQueryData(['account'], result.data);
    void navigate('/projects/new', { replace: true });
  }
  return (
    <OnboardingFrame step={6} title="All set">
      <p>Bob Deploy is ready. Add a project folder to put your first site online.</p>
      {error ? (
        <p className="form-error" role="alert">
          {error}
        </p>
      ) : null}
      <Button onClick={() => void finish()}>Add your first project</Button>
    </OnboardingFrame>
  );
}

export function OnboardingFlow() {
  const location = useLocation();
  const navigate = useNavigate();
  const account = useAccountStatus();
  const [recoveryCode, setRecoveryCode] = useState('');
  const step = location.pathname.split('/')[2] ?? '';
  if (!step && account.data?.exists) return <Navigate to="/welcome/bob" replace />;
  if (!step)
    return (
      <main className="centered-page" id="main-content">
        <Card className="welcome-card">
          <BrandLogo />
          <p className="eyebrow">Bob Deploy</p>
          <h1>Put your AI-built site online in a few clicks.</h1>
          <p>Set up a local account, connect Bob, and publish without editing configuration files.</p>
          <Link className="button link-button" to="/welcome/account">
            Get started
          </Link>
        </Card>
      </main>
    );
  if (step === 'account')
    return (
      <CreateAccount
        onCreated={(code) => {
          setRecoveryCode(code);
          void navigate('/welcome/recovery');
        }}
      />
    );
  if (step === 'recovery' && recoveryCode)
    return (
      <RecoveryCodeScreen
        code={recoveryCode}
        onContinue={() => {
          setRecoveryCode('');
          void navigate('/welcome/bob');
        }}
      />
    );
  if (step === 'bob')
    return (
      <BobSetup
        onContinue={() => {
          void navigate('/welcome/hosting');
        }}
      />
    );
  if (step === 'hosting')
    return (
      <HostingSetup
        onContinue={() => {
          void navigate('/welcome/done');
        }}
      />
    );
  if (step === 'done') return <AllSet />;
  return (
    <CreateAccount
      onCreated={(code) => {
        setRecoveryCode(code);
        void navigate('/welcome/recovery');
      }}
    />
  );
}

interface UnlockValues {
  password: string;
}
export function UnlockScreen() {
  const ipc = useIpc();
  const queryClient = useQueryClient();
  const account = useAccountStatus();
  const navigate = useNavigate();
  const location = useLocation();
  const {
    register,
    handleSubmit,
    reset,
    formState: { isSubmitting },
  } = useForm<UnlockValues>({ defaultValues: { password: '' } });
  const [error, setError] = useState('');
  const [remaining, setRemaining] = useState(account.data?.retryAfterSeconds ?? 0);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const passwordRegistration = register('password', { required: true });
  useEffect(() => {
    inputRef.current?.focus();
  }, []);
  useEffect(() => {
    if (remaining <= 0) return;
    const timer = window.setInterval(() => setRemaining((value) => Math.max(0, value - 1)), 1_000);
    return () => window.clearInterval(timer);
  }, [remaining > 0]);
  const submit = handleSubmit(async ({ password }) => {
    const result = await ipc['account:unlock']({ password });
    reset();
    if (!result.ok) {
      if (result.error.code === 'TOO_MANY_ATTEMPTS')
        setRemaining(Number(result.error.details?.retryAfterSeconds ?? 30));
      setError(result.error.code === 'BAD_PASSWORD' ? 'That password is not right.' : result.error.message);
      return;
    }
    queryClient.setQueryData(['account'], result.data);
    const destination = (location.state as { from?: string } | null)?.from ?? '/';
    void navigate(destination, { replace: true });
  });
  return (
    <main className="centered-page" id="main-content">
      <Card className="welcome-card">
        <BrandLogo />
        <p className="eyebrow">Bob Deploy</p>
        <h1>Welcome back{account.data?.displayName ? `, ${account.data.displayName}` : ''}</h1>
        <form
          onSubmit={(event) => {
            void submit(event);
          }}
        >
          <PasswordField
            label="Master password"
            autoComplete="current-password"
            error={error}
            {...passwordRegistration}
            ref={(element) => {
              passwordRegistration.ref(element);
              inputRef.current = element;
            }}
          />
          <Button disabled={isSubmitting || remaining > 0}>
            {remaining > 0 ? `Try again in 0:${String(remaining).padStart(2, '0')}` : 'Unlock'}
          </Button>
        </form>
        <Link to="/recover">Forgot your password?</Link>
      </Card>
    </main>
  );
}

interface RecoverValues {
  recoveryCode: string;
  newPassword: string;
  confirmPassword: string;
}
export function RecoverScreen() {
  const ipc = useIpc();
  const navigate = useNavigate();
  const [newCode, setNewCode] = useState('');
  const {
    register,
    handleSubmit,
    watch,
    reset,
    formState: { errors, isSubmitting },
  } = useForm<RecoverValues>({ defaultValues: { recoveryCode: '', newPassword: '', confirmPassword: '' } });
  const password = watch('newPassword');
  const confirm = watch('confirmPassword');
  const { authoritative } = usePasswordStrength(password, []);
  const [serverError, setServerError] = useState('');
  const submit = handleSubmit(async (values) => {
    const result = await ipc['account:recover']({
      recoveryCode: values.recoveryCode.replace(/[\s-]/g, '').toUpperCase(),
      newPassword: values.newPassword,
    });
    reset();
    if (!result.ok) {
      setServerError(
        result.error.code === 'BAD_RECOVERY_CODE' ? 'That recovery code is not right.' : result.error.message,
      );
      return;
    }
    setNewCode(result.data.recoveryCode);
  });
  if (newCode)
    return (
      <RecoveryCodeScreen
        code={newCode}
        title="Save your new recovery code"
        onContinue={() => {
          setNewCode('');
          void navigate('/unlock');
        }}
      />
    );
  return (
    <main className="centered-page" id="main-content">
      <Card className="onboarding-card">
        <h1>Recover your account</h1>
        <p>Enter your recovery code and choose a new master password.</p>
        <form
          onSubmit={(event) => {
            void submit(event);
          }}
        >
          <Field
            label="Recovery code"
            autoComplete="off"
            error={errors.recoveryCode?.message}
            {...register('recoveryCode', { required: 'Enter your recovery code.' })}
          />
          <PasswordField
            label="New password"
            autoComplete="new-password"
            {...register('newPassword', { required: true, minLength: 12 })}
          />
          <StrengthMeter password={password} userInputs={[]} />
          <PasswordField
            label="Confirm new password"
            autoComplete="new-password"
            error={errors.confirmPassword?.message}
            {...register('confirmPassword', {
              validate: (value) => value === password || 'Passwords do not match.',
            })}
          />
          {serverError ? (
            <p role="alert" className="form-error">
              {serverError}
            </p>
          ) : null}
          <Button disabled={isSubmitting || !authoritative?.ok || confirm !== password}>
            Reset password
          </Button>
        </form>
      </Card>
    </main>
  );
}

export function LockedToast() {
  return <Toast>Locked after inactivity</Toast>;
}
