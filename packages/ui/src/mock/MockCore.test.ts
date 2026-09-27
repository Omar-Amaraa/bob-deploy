import {
  IPC_CHANNELS,
  IPC_OUTPUT_SCHEMAS,
  type IpcChannel,
  type Result,
} from '@bob-deploy/contracts';
import { describe, expect, it } from 'vitest';
import { MockCore } from './MockCore.js';

const inputs: Record<IpcChannel, unknown> = {
  'account:status': undefined,
  'account:checkPassword': { password: 'A long password 123!' },
  'account:create': { displayName: 'Ada', email: 'ada@example.test', masterPassword: 'A long password 123!' },
  'account:unlock': { password: 'correct horse battery staple' },
  'account:lock': undefined,
  'account:touch': undefined,
  'account:changePassword': { currentPassword: 'correct horse battery staple', newPassword: 'A different password 123!' },
  'account:recover': { recoveryCode: '0123456789ABCDEFGHJKMNPQRSTVWXYZ', newPassword: 'A different password 123!' },
  'account:regenerateRecoveryCode': { password: 'correct horse battery staple' },
  'account:completeOnboarding': undefined,
  'bob:status': undefined,
  'bob:save': { apiKey: 'not-stored', keyType: 'inference', acceptLicense: true },
  'bob:check': undefined,
  'bob:clear': undefined,
  'hosts:status': undefined,
  'hosts:saveToken': { host: 'netlify', token: 'not-stored' },
  'hosts:revokeToken': { host: 'netlify' },
  'settings:get': undefined,
  'settings:set': { theme: 'dark' },
  'security:targetInfo': { targetId: 'project-own-target' },
  'security:revealSshPassphrase': { targetId: 'project-own-target', password: 'correct horse battery staple' },
  'security:exportSshKey': { targetId: 'project-own-target', password: 'correct horse battery staple' },
  'projects:list': undefined,
  'projects:create': { folderPath: 'C:\\Projects\\another', name: 'Another' },
  'projects:get': { projectId: 'project-own' },
  'projects:remove': { projectId: 'missing', deleteHistory: false },
  'projects:getEnvKeys': { projectId: 'project-own' },
  'projects:setEnv': { projectId: 'project-own', env: { PUBLIC_URL: 'https://example.test' } },
  'snapshots:list': { projectId: 'project-own' },
  'snapshots:restore': { projectId: 'project-own', snapshotId: 'snapshot-1' },
  'dns:check': { domain: 'example.test', ip: '192.0.2.18' },
  'deploy:start': { projectId: 'project-own', target: 'free', inputs: { host: 'netlify', siteName: 'example', env: {} } },
  'update:start': { projectId: 'project-own' },
  'rollback:start': { projectId: 'project-own' },
  'releases:list': { projectId: 'project-own' },
  'job:list': { projectId: 'project-own' },
  'job:get': { jobId: 'missing' },
  'job:subscribe': { jobId: 'missing', fromSeq: 0 },
  'job:unsubscribe': { jobId: 'missing' },
  'job:answer': { jobId: 'missing', questionId: 'question', value: true },
  'job:cancel': { jobId: 'missing' },
  'metrics:latest': { projectId: 'project-own', kinds: ['memory', 'cpu'] },
  'metrics:series': { projectId: 'project-own', kind: 'memory', range: '24h' },
  'health:get': { projectId: 'project-own' },
  'analytics:get': { projectId: 'project-own', range: '24h' },
  'maintenance:list': { projectId: 'project-own' },
  'maintenance:run': { projectId: 'project-own', actionId: 'apply_security_updates' },
  'problem:signal': { projectId: 'project-own', note: 'The contact form does nothing.' },
  'problems:list': { projectId: 'project-own' },
};

describe('MockCore contract', () => {
  it.each(IPC_CHANNELS)('implements %s with a Result envelope', async (channel) => {
    const core = new MockCore('live-own-server', { delay: 0 });
    const raw = await core.invoke(channel, inputs[channel]);
    expect(raw).toBeTypeOf('object');
    expect(raw).toHaveProperty('ok');
    const result = raw as Result<unknown>;
    if (result.ok) {
      const schema = IPC_OUTPUT_SCHEMAS[channel];
      if (schema) expect(schema.safeParse(result.data).success).toBe(true);
    } else {
      expect(result.error.message).not.toBe('');
    }
    core.dispose();
  });
});
