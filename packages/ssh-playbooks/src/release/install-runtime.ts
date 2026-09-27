import type { StackInfo, AgentEvent, AgentRunner, AgentTask } from '@bob-deploy/contracts';
import { installPlanSchema } from '@bob-deploy/agent';
import type { RemoteExec } from '../ssh/types.js';
import { HELPER_SCRIPTS, type GeneratedScript } from '../generated/scripts.js';
import { runScript } from '../playbook/run-script.js';
import { mapBdErrorCode } from '../playbook/error-mapping.js';
import { stepFail, stepOk, type PlaybookStep, type PlaybookStepOutcome } from '../playbook/types.js';
import { filterAptPackages } from './apt-allowlist.js';

function scriptByName(name: string): GeneratedScript {
  const found = HELPER_SCRIPTS.find((s) => s.name === name);
  if (!found) throw new Error(`No generated helper script named "${name}" (this is a bug).`);
  return found;
}

export interface InstallRuntimeInput {
  session: RemoteExec;
  stack: StackInfo;
  /** Only consulted for node/python; static apps skip Bob entirely (brief: "skip for static"). */
  agentRunner?: AgentRunner;
  projectDir: string;
  allowedCommands?: string[];
  timeoutMs?: number;
  /** Receives Bob's live progress while he plans the install. */
  onAgentEvent?: (event: AgentEvent) => void;
}

export interface InstallRuntimeOutput {
  /** Undefined for static apps, which install no runtime at all. */
  runtime?: { name: 'node' | 'python'; version: string };
  installedAptPackages: string[];
  droppedAptPackages: string[];
}

async function runBobPlanInstall(
  runner: AgentRunner,
  cwd: string,
  stack: StackInfo,
  allowedCommands: string[],
  timeoutMs: number,
  onAgentEvent?: (event: AgentEvent) => void,
): Promise<{ runtime: { name: 'node' | 'python'; version: string } | null; aptPackages: string[] } | { error: string }> {
  const task: AgentTask = {
    kind: 'plan_install',
    cwd,
    instructions: '',
    context: { hints: { stack } },
    allowedCommands,
    maxTurns: 3,
    timeoutMs,
  };
  let lastResult: { ok: boolean; data?: unknown; summary: string } | undefined;
  for await (const event of runner.run(task)) {
    onAgentEvent?.(event);
    if (event.type === 'result') lastResult = event;
  }
  if (!lastResult) return { error: 'Bob returned no result for plan_install.' };
  if (!lastResult.ok) return { error: lastResult.summary || 'Bob failed to plan the install.' };
  const parsed = installPlanSchema.safeParse(lastResult.data);
  if (!parsed.success) {
    return { error: `Bob's plan_install result did not match the expected shape: ${parsed.error.message}` };
  }
  return parsed.data;
}

/** Default runtime version to request when Bob (or the plan) doesn't pin one. */
function defaultVersionFor(runtime: 'node' | 'python'): string {
  return runtime === 'node' ? '20' : '3.11';
}

/**
 * Step 7 (Flow 1): install_runtime. Bob plans (skipped entirely for static apps); the plan's
 * aptPackages are filtered against APT_PACKAGE_ALLOWLIST before anything is installed as root
 * (dropped ones are returned so the caller can log them plainly); bd-install-runtime and
 * bd-install-apt-packages run via sudo; the installed runtime's major version is verified against
 * what was requested.
 */
export const installRuntimeStep: PlaybookStep<InstallRuntimeInput, InstallRuntimeOutput> = {
  id: 'install_runtime',
  title: 'Install the runtime',
  async run(input): Promise<PlaybookStepOutcome<InstallRuntimeOutput>> {
    if (input.stack.type === 'static') {
      return stepOk({ installedAptPackages: [], droppedAptPackages: [] });
    }

    let requestedRuntime: { name: 'node' | 'python'; version: string } = {
      name: input.stack.type,
      version: input.stack.runtimeVersion ?? defaultVersionFor(input.stack.type),
    };
    let aptPackages: string[] = [];

    if (input.agentRunner) {
      const plan = await runBobPlanInstall(
        input.agentRunner,
        input.projectDir,
        input.stack,
        input.allowedCommands ?? [],
        input.timeoutMs ?? 180000,
        input.onAgentEvent,
      );
      if ('error' in plan) {
        return stepFail('BUILD_FAILED', `Could not plan the runtime install: ${plan.error}`);
      }
      if (plan.runtime) requestedRuntime = plan.runtime;
      aptPackages = plan.aptPackages;
    }

    const { allowed, dropped } = filterAptPackages(aptPackages);

    const runtimeResult = await runScript(
      input.session,
      scriptByName('bd-install-runtime'),
      [requestedRuntime.name, requestedRuntime.version],
      { sudo: true, timeoutMs: 300000 },
    );
    if (!runtimeResult.outcome.ok) {
      return stepFail(mapBdErrorCode(runtimeResult.outcome.code), runtimeResult.outcome.message, {
        stderr: runtimeResult.exec.stderr,
      });
    }

    const resolvedVersion = runtimeResult.outcome.data['version'] ?? '';
    const requestedMajor = requestedRuntime.version.split('.')[0];
    const resolvedMajor = resolvedVersion.replace(/^v/, '').split('.')[0];
    if (requestedMajor !== resolvedMajor) {
      return stepFail(
        'BUILD_FAILED',
        `Installed ${requestedRuntime.name} ${resolvedVersion} but ${requestedRuntime.version} was requested (major version mismatch).`,
      );
    }

    if (allowed.length > 0) {
      const packagesB64 = Buffer.from(allowed.join('\n'), 'utf8').toString('base64');
      const aptResult = await runScript(input.session, scriptByName('bd-install-apt-packages'), [packagesB64], {
        sudo: true,
        timeoutMs: 300000,
      });
      if (!aptResult.outcome.ok) {
        return stepFail(mapBdErrorCode(aptResult.outcome.code), aptResult.outcome.message, {
          stderr: aptResult.exec.stderr,
        });
      }
    }

    return stepOk({
      runtime: { name: requestedRuntime.name, version: resolvedVersion },
      installedAptPackages: allowed,
      droppedAptPackages: dropped,
    });
  },
};
