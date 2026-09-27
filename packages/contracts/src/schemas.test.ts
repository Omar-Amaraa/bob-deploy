import { describe, expect, it } from 'vitest';
import type { IpcChannel } from './ipc.js';
import { IPC_CHANNELS } from './ipc.js';
import {
  IPC_INPUT_SCHEMAS,
  IPC_OUTPUT_SCHEMAS,
  accountStatusSchema,
  appSettingsPatchSchema,
  bobCheckResultSchema,
  bobSetupInputSchema,
  bobStatusSchema,
  changePasswordInputSchema,
  createAccountInputSchema,
  deployStartInputSchema,
  freeHostInputsSchema,
  healthStatusSchema,
  hostTokenStatusSchema,
  jobAnswerSchema,
  jobEventSchema,
  maintenanceItemSchema,
  metricSampleSchema,
  ownServerInputsSchema,
  projectCreateInputSchema,
  projectRecordSchema,
  recoverInputSchema,
} from './schemas.js';

describe('createAccountInputSchema', () => {
  it('accepts a valid example', () => {
    expect(
      createAccountInputSchema.safeParse({
        displayName: 'Ada Lovelace',
        email: 'ada@example.com',
        masterPassword: 'correct-horse-battery-Staple-42',
      }).success,
    ).toBe(true);
  });

  it('rejects a blank display name', () => {
    expect(
      createAccountInputSchema.safeParse({
        displayName: '',
        email: 'a@b.com',
        masterPassword: 'x'.repeat(12),
      }).success,
    ).toBe(false);
  });

  it('rejects an invalid email', () => {
    expect(
      createAccountInputSchema.safeParse({
        displayName: 'A',
        email: 'not-an-email',
        masterPassword: 'x'.repeat(12),
      }).success,
    ).toBe(false);
  });

  it('rejects a master password shorter than the policy minimum', () => {
    expect(
      createAccountInputSchema.safeParse({ displayName: 'A', email: 'a@b.com', masterPassword: 'short' })
        .success,
    ).toBe(false);
  });
});

describe('changePasswordInputSchema', () => {
  it('accepts a valid example', () => {
    expect(
      changePasswordInputSchema.safeParse({ currentPassword: 'old', newPassword: 'x'.repeat(12) }).success,
    ).toBe(true);
  });
  it('rejects an empty current password', () => {
    expect(
      changePasswordInputSchema.safeParse({ currentPassword: '', newPassword: 'x'.repeat(12) }).success,
    ).toBe(false);
  });
  it('rejects a too-short new password', () => {
    expect(
      changePasswordInputSchema.safeParse({ currentPassword: 'old', newPassword: 'short' }).success,
    ).toBe(false);
  });
});

describe('recoverInputSchema', () => {
  const code = 'ABCDEFGHJKMNPQRSTVWXYZ0123456789';

  it('accepts a valid example, normalising spacing and case', () => {
    const spaced = code
      .toLowerCase()
      .match(/.{1,4}/g)!
      .join('-');
    const result = recoverInputSchema.safeParse({ recoveryCode: spaced, newPassword: 'x'.repeat(12) });
    expect(result.success).toBe(true);
    if (result.success) expect(result.data.recoveryCode).toBe(code);
  });

  it('rejects a code with invalid characters', () => {
    expect(
      recoverInputSchema.safeParse({ recoveryCode: 'I'.repeat(32), newPassword: 'x'.repeat(12) }).success,
    ).toBe(false);
  });

  it('rejects a code that is the wrong length', () => {
    expect(recoverInputSchema.safeParse({ recoveryCode: 'ABC', newPassword: 'x'.repeat(12) }).success).toBe(
      false,
    );
  });
});

describe('bobSetupInputSchema', () => {
  it('accepts a valid inference-key example', () => {
    expect(
      bobSetupInputSchema.safeParse({ apiKey: 'key', keyType: 'inference', acceptLicense: true }).success,
    ).toBe(true);
  });
  it('rejects an unknown keyType', () => {
    expect(bobSetupInputSchema.safeParse({ keyType: 'nope', acceptLicense: true }).success).toBe(false);
  });
  it('rejects a non-boolean acceptLicense', () => {
    expect(bobSetupInputSchema.safeParse({ keyType: 'inference', acceptLicense: 'yes' }).success).toBe(false);
  });
});

describe('projectCreateInputSchema', () => {
  it('accepts a valid example', () => {
    expect(projectCreateInputSchema.safeParse({ folderPath: '/home/me/app', name: 'My App' }).success).toBe(
      true,
    );
  });
  it('rejects an empty folder path', () => {
    expect(projectCreateInputSchema.safeParse({ folderPath: '', name: 'My App' }).success).toBe(false);
  });
  it('rejects an empty name', () => {
    expect(projectCreateInputSchema.safeParse({ folderPath: '/x', name: '' }).success).toBe(false);
  });
});

describe('ownServerInputsSchema', () => {
  const base = {
    domain: 'example.com',
    useSslipFallback: false,
    serverIp: '203.0.113.10',
    sshPort: 22,
    rootUser: 'root',
    rootAuth: { method: 'password' as const, password: 'hunter2' },
    adminUser: 'deploy',
    acmeEmail: 'me@example.com',
    env: { PORT: '3000' },
  };

  it('accepts a valid password-auth example', () => {
    expect(ownServerInputsSchema.safeParse(base).success).toBe(true);
  });

  it('accepts a valid key-auth example', () => {
    expect(
      ownServerInputsSchema.safeParse({
        ...base,
        rootAuth: { method: 'key', privateKeyPath: '/home/me/.ssh/id_ed25519' },
      }).success,
    ).toBe(true);
  });

  it('rejects an invalid domain', () => {
    expect(ownServerInputsSchema.safeParse({ ...base, domain: 'not a domain' }).success).toBe(false);
  });

  it('rejects a private server IP outside testbed mode', () => {
    expect(ownServerInputsSchema.safeParse({ ...base, serverIp: '192.168.1.5' }).success).toBe(false);
  });

  it('rejects an env value containing a newline', () => {
    expect(ownServerInputsSchema.safeParse({ ...base, env: { PORT: '3000\n' } }).success).toBe(false);
  });
});

describe('freeHostInputsSchema', () => {
  it('accepts a valid example', () => {
    expect(freeHostInputsSchema.safeParse({ host: 'netlify', siteName: 'my-site', env: {} }).success).toBe(
      true,
    );
  });
  it('rejects an unknown host', () => {
    expect(freeHostInputsSchema.safeParse({ host: 'heroku', siteName: 'my-site', env: {} }).success).toBe(
      false,
    );
  });
});

describe('deployStartInputSchema', () => {
  it('accepts a valid own_server example', () => {
    expect(
      deployStartInputSchema.safeParse({
        projectId: 'p1',
        target: 'own_server',
        inputs: {
          domain: 'example.com',
          useSslipFallback: false,
          serverIp: '203.0.113.10',
          sshPort: 22,
          rootUser: 'root',
          rootAuth: { method: 'password', password: 'x' },
          adminUser: 'deploy',
          acmeEmail: 'me@example.com',
          env: {},
        },
      }).success,
    ).toBe(true);
  });

  it('accepts a valid free-host example', () => {
    expect(
      deployStartInputSchema.safeParse({
        projectId: 'p1',
        target: 'free',
        inputs: { host: 'vercel', siteName: 'my-site', env: {} },
      }).success,
    ).toBe(true);
  });

  it('rejects an unknown target discriminator', () => {
    expect(deployStartInputSchema.safeParse({ projectId: 'p1', target: 'mystery', inputs: {} }).success).toBe(
      false,
    );
  });

  it('rejects free-host inputs mismatched with the own_server target', () => {
    expect(
      deployStartInputSchema.safeParse({
        projectId: 'p1',
        target: 'own_server',
        inputs: { host: 'netlify', siteName: 'x', env: {} },
      }).success,
    ).toBe(false);
  });
});

describe('jobAnswerSchema', () => {
  it('accepts string and boolean answers', () => {
    expect(jobAnswerSchema.safeParse({ jobId: 'j1', questionId: 'q1', value: 'yes' }).success).toBe(true);
    expect(jobAnswerSchema.safeParse({ jobId: 'j1', questionId: 'q1', value: true }).success).toBe(true);
  });
  it('rejects a numeric answer', () => {
    expect(jobAnswerSchema.safeParse({ jobId: 'j1', questionId: 'q1', value: 42 }).success).toBe(false);
  });
  it('rejects a missing questionId', () => {
    expect(jobAnswerSchema.safeParse({ jobId: 'j1', value: 'yes' }).success).toBe(false);
  });
});

describe('appSettingsPatchSchema', () => {
  it('accepts a partial patch', () => {
    expect(appSettingsPatchSchema.safeParse({ theme: 'dark' }).success).toBe(true);
  });
  it('accepts an empty patch', () => {
    expect(appSettingsPatchSchema.safeParse({}).success).toBe(true);
  });
  it('rejects an out-of-range autoLockMinutes', () => {
    expect(appSettingsPatchSchema.safeParse({ autoLockMinutes: 1 }).success).toBe(false);
  });
  it('rejects an unknown theme', () => {
    expect(appSettingsPatchSchema.safeParse({ theme: 'solarized' }).success).toBe(false);
  });
});

describe('output schemas', () => {
  it('accountStatusSchema accepts a minimal example and rejects a bad one', () => {
    expect(
      accountStatusSchema.safeParse({
        exists: true,
        unlocked: true,
        onboardingComplete: true,
        autoLockMinutes: 15,
      }).success,
    ).toBe(true);
    expect(accountStatusSchema.safeParse({ exists: 'yes' }).success).toBe(false);
  });

  it('jobEventSchema accepts a minimal example and rejects a bad one', () => {
    expect(
      jobEventSchema.safeParse({
        jobId: 'j1',
        seq: 1,
        ts: new Date().toISOString(),
        type: 'step_started',
        message: 'go',
      }).success,
    ).toBe(true);
    expect(
      jobEventSchema.safeParse({ jobId: 'j1', seq: 1, ts: 'x', type: 'not_a_type', message: 'go' }).success,
    ).toBe(false);
  });

  it('metricSampleSchema accepts a minimal example and rejects a bad one', () => {
    expect(
      metricSampleSchema.safeParse({
        projectId: 'p1',
        kind: 'cpu',
        value: 10,
        unit: '%',
        ts: new Date().toISOString(),
      }).success,
    ).toBe(true);
    expect(
      metricSampleSchema.safeParse({ projectId: 'p1', kind: 'unknown', value: 10, unit: '%', ts: 'x' })
        .success,
    ).toBe(false);
  });

  it('healthStatusSchema accepts a minimal example and rejects a bad one', () => {
    expect(healthStatusSchema.safeParse({ up: true, failedServices: [], stale: false }).success).toBe(true);
    expect(healthStatusSchema.safeParse({ up: 'yes', failedServices: [], stale: false }).success).toBe(false);
  });

  it('maintenanceItemSchema accepts a minimal example and rejects a bad one', () => {
    expect(
      maintenanceItemSchema.safeParse({
        id: 'm1',
        projectId: 'p1',
        kind: 'disk_nearly_full',
        severity: 'warning',
        title: 'Disk almost full',
        detail: '90% used',
        detectedAt: new Date().toISOString(),
      }).success,
    ).toBe(true);
    expect(maintenanceItemSchema.safeParse({ id: 'm1', kind: 'unknown' }).success).toBe(false);
  });

  it('projectRecordSchema accepts a minimal example and rejects a bad one', () => {
    expect(
      projectRecordSchema.safeParse({
        id: 'p1',
        name: 'My App',
        folderPath: '/x',
        createdAt: new Date().toISOString(),
        status: 'not_deployed',
      }).success,
    ).toBe(true);
    expect(projectRecordSchema.safeParse({ id: 'p1', name: 'My App', status: 'not_a_status' }).success).toBe(
      false,
    );
  });

  it('bobStatusSchema accepts a minimal example and rejects a bad one', () => {
    expect(
      bobStatusSchema.safeParse({
        configured: false,
        keySaved: false,
        teamIdSet: false,
        licenseAccepted: false,
      }).success,
    ).toBe(true);
    expect(bobStatusSchema.safeParse({ configured: 'no' }).success).toBe(false);
  });

  it('bobCheckResultSchema accepts a minimal example and rejects a bad one', () => {
    expect(bobCheckResultSchema.safeParse({ step: 'binary', ok: true, message: 'found' }).success).toBe(true);
    expect(bobCheckResultSchema.safeParse({ step: 'unknown', ok: true, message: 'found' }).success).toBe(
      false,
    );
  });

  it('hostTokenStatusSchema accepts a minimal example and rejects a bad one', () => {
    expect(hostTokenStatusSchema.safeParse({ host: 'netlify', connected: false }).success).toBe(true);
    expect(hostTokenStatusSchema.safeParse({ host: 'heroku', connected: false }).success).toBe(false);
  });
});

describe('IPC_INPUT_SCHEMAS / IPC_OUTPUT_SCHEMAS', () => {
  it('has exactly one input schema per channel', () => {
    const keys = Object.keys(IPC_INPUT_SCHEMAS) as IpcChannel[];
    expect(keys.sort()).toEqual([...IPC_CHANNELS].sort());
  });

  it('parses void inputs for status-style channels', () => {
    expect(IPC_INPUT_SCHEMAS['account:status'].safeParse(undefined).success).toBe(true);
    expect(IPC_INPUT_SCHEMAS['projects:list'].safeParse(undefined).success).toBe(true);
  });

  it('rejects a bad payload for a representative channel', () => {
    expect(IPC_INPUT_SCHEMAS['dns:check'].safeParse({ domain: 'bad domain', ip: 'x' }).success).toBe(false);
  });

  it('only registers output schemas for real channels', () => {
    const outputChannels = Object.keys(IPC_OUTPUT_SCHEMAS) as IpcChannel[];
    for (const channel of outputChannels) {
      expect(IPC_CHANNELS).toContain(channel);
    }
  });
});
