/**
 * Shared helper for s01.int.test.ts and s06.int.test.ts: runs the same real bootstrap flow
 * bootstrap.int.test.ts already proves works (reach_server -> create_admin -> lock_down ->
 * firewall_and_patches) against a live testbed container, with an instrumented `redact` wired into
 * the SSH session so every line of output the server ever sends back is captured twice: once raw
 * (before redaction — proving the credential really did flow through this channel, so the test
 * isn't vacuous) and once through a real Redactor pre-loaded with every testbed/test-secrets.json
 * value (what an actual log line or job event would look like). S1/S6 both reduce to the same
 * assertion on the same run: the raw capture contains the root password (sanity), the redacted
 * capture contains none of the six test secrets in any form.
 *
 * NOT EXECUTED IN THIS SANDBOX: no route to a container registry to pull the testbed's base images
 * (same blocker recorded against every *.int.test.ts file since A4 — see docs/HANDOFF.md).
 */
import { resetTestbed, testbedTarget, reachServerStep, createAdminStep, lockDownStep, firewallAndPatchesStep, type SshSession } from '@bob-deploy/ssh-playbooks';
import { utils as ssh2Utils } from 'ssh2';
import { Redactor } from '../../redactor.js';
import { allTestSecretValues, findSecretsInText } from './secrets.js';

export interface TestbedSecretScanResult {
  /** True if the raw (pre-redaction) capture contains the root password — sanity check that the
   * credential genuinely flowed through this SSH session at some point during the run. */
  rawCaptureSawRootPassword: boolean;
  /** Any of the six test secrets (or an encoded form) found in the *redacted* capture — what
   * would actually reach a log line, job event, or crash report in the real app. Must be empty. */
  redactedCaptureHits: string[];
}

function generateAdminKeypair() {
  return ssh2Utils.generateKeyPairSync('ed25519', { comment: 'bd-s1-s6-security-suite' });
}

export async function runBootstrapAndScanOutput(): Promise<TestbedSecretScanResult> {
  await resetTestbed('ubuntu2404');
  const target = testbedTarget('ubuntu2404');
  const adminUser = 'bdsecsuite';
  const { public: publicKey, private: privateKey } = generateAdminKeypair();

  const secrets = allTestSecretValues();
  const redactor = new Redactor();
  for (const s of secrets) redactor.add(s);

  const raw: string[] = [];
  const redact = (s: string): string => {
    raw.push(s);
    return redactor.redact(s);
  };

  const reach = await reachServerStep.run({
    host: target.host,
    port: target.sshPort,
    auth: { password: target.rootPassword },
    onUnknownHostKey: () => Promise.resolve(true),
    redact,
  });
  if (!reach.ok) throw new Error(`reachServerStep failed: ${reach.code}`);
  const rootSession: SshSession = reach.data.session;

  let adminSession: SshSession | undefined;
  try {
    await createAdminStep.run({ session: rootSession, sudo: false, adminUser, publicKey });
    const lockDown = await lockDownStep.run({
      rootSession,
      rootSudo: false,
      adminUser,
      host: target.host,
      port: target.sshPort,
      adminAuth: { privateKey },
      redact,
    });
    if (!lockDown.ok) throw new Error(`lockDownStep failed: ${lockDown.code}`);
    adminSession = lockDown.data.adminSession;
    await firewallAndPatchesStep.run({ session: adminSession, adminUser });
  } finally {
    adminSession?.close();
    rootSession.close();
  }

  const rawText = raw.join('\n');
  // Re-derive the redacted view from the same captured lines (rather than trusting whatever the
  // session already redacted in place) so this assertion is against the Redactor's real output,
  // not against session.ts's own correctness — the two are meant to be the same text, but this
  // keeps the two concerns separately checkable.
  const redactedText = raw.map((s) => redactor.redact(s)).join('\n');

  return {
    rawCaptureSawRootPassword: rawText.includes(target.rootPassword),
    redactedCaptureHits: findSecretsInText(redactedText, secrets),
  };
}
