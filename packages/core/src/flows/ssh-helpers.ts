import { connectSsh, type PackageKind, type RemoteExec } from '@bob-deploy/ssh-playbooks';
import { sshPrivateKeySecretKey, sshPassphraseSecretKey } from '../account/secret-keys.js';
import type { VaultLike } from './vault.js';

/** Establishes a fresh admin-user SSH session to an already-bootstrapped target, using its stored
 * fingerprint (pinned, no host-key prompt needed) and the admin key stashed in the vault. Shared by
 * every flow that needs to talk to an own_server target after bootstrap (deploy_own_server's
 * release step, update, rollback) — each one reconnects independently, since a live SshSession
 * can't survive the JSON persistence boundary between StepDef runs (ctx.shared is serialized to
 * jobs.inputs_json.shared) or across separate job runs entirely. */
export async function reconnectAsAdmin(
  vault: VaultLike,
  redact: (s: string) => string,
  target: { ip?: string; sshPort?: number; adminUser?: string; hostKeyFingerprint?: string; id: string },
): Promise<RemoteExec & { close(): void }> {
  if (!target.ip || !target.adminUser) throw new Error('INTERNAL: target is missing ip/adminUser.');
  const privateKey = vault.getSecret(sshPrivateKeySecretKey(target.id));
  const passphrase = vault.getSecret(sshPassphraseSecretKey(target.id));
  if (!privateKey || !passphrase) throw new Error('INTERNAL: admin SSH key not found in the vault for this target.');
  return connectSsh({
    host: target.ip,
    port: target.sshPort ?? 22,
    username: target.adminUser,
    auth: { privateKey, passphrase },
    expectedFingerprint: target.hostKeyFingerprint,
    redact,
  });
}

export function packageKindFor(stackType: 'static' | 'node' | 'python'): PackageKind {
  return stackType;
}
