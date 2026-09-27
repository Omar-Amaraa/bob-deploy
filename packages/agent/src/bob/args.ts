import type { BobKeyType } from '@bob-deploy/contracts';

export interface BobArgsConfig {
  keyType: BobKeyType;
  teamId?: string;
}

export interface BobRunOptions {
  workspace: string;
  maxTurns: number;
}

/**
 * Bob Shell 2.x's non-interactive contract, verified against `bob run --help` and the README
 * shipped with bobshell 2.0.1. The prompt itself is sent on stdin so Windows' cmd.exe argument
 * length limit cannot truncate project/build context.
 */
export function buildBobArgs(config: BobArgsConfig, options: BobRunOptions): string[] {
  const args = [
    'run',
    '--format',
    'stream-json',
    '--workspace',
    options.workspace,
    '--mode',
    'agent',
    '--trust',
    '--accept-license',
    '--disable-mcp',
    '--disable-subagents',
    '--max-turns',
    String(options.maxTurns),
  ];
  if (config.keyType === 'general' && config.teamId) {
    args.push('--team-id', config.teamId);
  }
  return args;
}
