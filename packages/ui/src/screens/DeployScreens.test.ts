// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import type { JobEvent, JobStepView } from '@bob-deploy/contracts';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { createElement } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { App } from '../app/App.js';
import { QuestionCard } from '../components/ui.js';
import { MockCore } from '../mock/MockCore.js';
import {
  freeHostFormSchema,
  ownServerFormSchema,
  parseEnvironment,
  reduceJobEvent,
} from './DeployScreens.js';

afterEach(cleanup);

const validOwnServer = {
  domain: 'site.example.com',
  useSslipFallback: false,
  serverIp: '203.0.113.20',
  rootUser: 'root',
  sshPort: 22,
  authMethod: 'password' as const,
  password: 'one-time-password',
  privateKeyPath: '',
  keyPassphrase: '',
  adminUser: 'deploy',
  acmeEmail: 'owner@example.com',
  envRows: [{ key: 'API_URL', value: 'https://api.example.com' }],
};

describe('deployment form schemas', () => {
  it.each([
    ['domain', { domain: 'Example.com' }],
    ['server IP', { serverIp: '999.1.1.1' }],
    ['provider login', { rootUser: '' }],
    ['server port', { sshPort: 65_536 }],
    ['password', { password: '' }],
    ['admin account', { adminUser: 'root' }],
    ['certificate email', { acmeEmail: 'not-an-email' }],
    ['environment key', { envRows: [{ key: 'lowercase', value: 'ok' }] }],
    ['environment value', { envRows: [{ key: 'TOKEN', value: 'line\nbreak' }] }],
    [
      'duplicate environment key',
      {
        envRows: [
          { key: 'TOKEN', value: 'one' },
          { key: 'TOKEN', value: 'two' },
        ],
      },
    ],
  ])('rejects an invalid %s', (_name, patch) => {
    expect(ownServerFormSchema.safeParse({ ...validOwnServer, ...patch }).success).toBe(false);
  });

  it('requires a key file only for key sign-in', () => {
    const missing = ownServerFormSchema.safeParse({
      ...validOwnServer,
      authMethod: 'key',
      password: '',
      privateKeyPath: '',
    });
    expect(missing.success).toBe(false);
    expect(
      ownServerFormSchema.safeParse({
        ...validOwnServer,
        authMethod: 'key',
        password: '',
        privateKeyPath: 'C:\\Keys\\server',
      }).success,
    ).toBe(true);
  });

  it('validates free-host site names and environment values', () => {
    expect(freeHostFormSchema.safeParse({ host: 'netlify', siteName: 'my-site', envRows: [] }).success).toBe(
      true,
    );
    expect(freeHostFormSchema.safeParse({ host: 'netlify', siteName: 'My site', envRows: [] }).success).toBe(
      false,
    );
  });
});

describe('environment parser', () => {
  it('parses quotes, embedded equals signs, comments and blank lines', () => {
    expect(
      parseEnvironment(`
# production values
API_URL="https://example.com?a=b"
TOKEN='secret value'

PLAIN=yes
`),
    ).toEqual({
      rows: [
        { key: 'API_URL', value: 'https://example.com?a=b' },
        { key: 'TOKEN', value: 'secret value' },
        { key: 'PLAIN', value: 'yes' },
      ],
      skipped: 0,
    });
  });

  it('reports lines that cannot be imported', () => {
    expect(parseEnvironment('NO_EQUALS\nlower=value\nGOOD=ok')).toEqual({
      rows: [{ key: 'GOOD', value: 'ok' }],
      skipped: 2,
    });
  });
});

describe('DNS check', () => {
  it('shows the resolved address and temporary alternative when the domain is not ready', async () => {
    const core = new MockCore('live-own-server', { delay: 0, dnsResolved: ['198.51.100.8'] });
    render(createElement(App, { transport: core, initialEntries: ['/p/project-own/deploy'] }));
    fireEvent.click(await screen.findByRole('button', { name: /My own server/ }));
    fireEvent.change(screen.getByRole('textbox', { name: 'Domain' }), {
      target: { value: 'new.example.com' },
    });
    fireEvent.change(screen.getByRole('textbox', { name: 'Server IP' }), {
      target: { value: '203.0.113.20' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Check DNS' }));
    expect(await screen.findByText(/Your domain points to 198\.51\.100\.8/)).toBeVisible();
    expect(screen.getByText(/203\.0\.113\.20\.sslip\.io/)).toBeVisible();
    core.dispose();
  });
});

describe('job event reducer', () => {
  const steps: JobStepView[] = [
    { id: 'prepare', name: 'Prepare project', kind: 'agent', status: 'pending', attempt: 1 },
  ];
  const initial = {
    steps,
    events: [],
    lastSeq: 0,
    status: 'running' as const,
  };
  const event = (seq: number, type: JobEvent['type'], data?: Record<string, unknown>): JobEvent => ({
    jobId: 'job-1',
    seq,
    ts: '2026-09-26T10:00:00.000Z',
    type,
    stepId: 'prepare',
    message: type,
    data,
  });

  it('orders late events, deduplicates sequence numbers and derives the final state', () => {
    const doneFirst = reduceJobEvent(
      initial,
      event(3, 'done', { status: 'succeeded', siteUrl: 'https://site.test' }),
    );
    const startedLate = reduceJobEvent(doneFirst, event(1, 'step_started'));
    const finishedLate = reduceJobEvent(startedLate, event(2, 'step_finished'));
    const duplicate = reduceJobEvent(finishedLate, event(2, 'step_finished'));
    expect(finishedLate.events.map(({ seq }) => seq)).toEqual([1, 2, 3]);
    expect(finishedLate.steps[0]?.status).toBe('succeeded');
    expect(finishedLate.status).toBe('succeeded');
    expect(finishedLate.siteUrl).toBe('https://site.test');
    expect(duplicate).toBe(finishedLate);
  });

  it('tracks questions, answers, errors and rollback completion', () => {
    const question = {
      questionId: 'confirm',
      kind: 'confirm' as const,
      title: 'Continue?',
      body: 'Check this first.',
    };
    let state = reduceJobEvent(initial, event(1, 'question', question));
    expect(state.pendingQuestion).toEqual(question);
    state = reduceJobEvent(state, event(2, 'answer', { questionId: 'confirm', display: 'Yes' }));
    expect(state.pendingQuestion).toBeUndefined();
    state = reduceJobEvent(state, event(3, 'error', { code: 'BUILD_FAILED' }));
    state = reduceJobEvent(state, event(4, 'done', { status: 'rolled_back' }));
    expect(state.errorCode).toBe('BUILD_FAILED');
    expect(state.status).toBe('rolled_back');
  });
});

describe('job questions', () => {
  it('answers confirm and choice questions', () => {
    const answer = vi.fn();
    const { rerender } = render(
      createElement(QuestionCard, {
        question: { questionId: 'confirm', kind: 'confirm', title: 'Continue?', body: 'Ready?' },
        onAnswer: answer,
      }),
    );
    fireEvent.click(screen.getByRole('button', { name: 'Continue' }));
    expect(answer).toHaveBeenLastCalledWith(true);
    rerender(
      createElement(QuestionCard, {
        question: {
          questionId: 'choice',
          kind: 'choice',
          title: 'Choose one',
          body: 'Pick a version.',
          options: [{ id: 'safe', label: 'Safe version' }],
        },
        onAnswer: answer,
      }),
    );
    fireEvent.click(screen.getByRole('radio', { name: 'Safe version' }));
    fireEvent.click(screen.getByRole('button', { name: 'Continue' }));
    expect(answer).toHaveBeenLastCalledWith('safe');
  });

  it('answers text and clears secret questions', () => {
    const answer = vi.fn();
    const { rerender } = render(
      createElement(QuestionCard, {
        question: { questionId: 'text', kind: 'text', title: 'Version name', body: 'Enter a name.' },
        onAnswer: answer,
      }),
    );
    fireEvent.input(screen.getByLabelText('Version name'), { target: { value: 'spring' } });
    fireEvent.click(screen.getByRole('button', { name: 'Continue' }));
    expect(answer).toHaveBeenLastCalledWith('spring');
    rerender(
      createElement(QuestionCard, {
        question: {
          questionId: 'secret',
          kind: 'secret',
          title: 'One-time password',
          body: 'Enter it.',
        },
        onAnswer: answer,
      }),
    );
    const secret = screen.getByLabelText('One-time password');
    fireEvent.input(secret, { target: { value: 'hidden-value' } });
    fireEvent.click(screen.getByRole('button', { name: 'Continue' }));
    expect(answer).toHaveBeenLastCalledWith('hidden-value');
    expect(secret).toHaveValue('');
  });
});
