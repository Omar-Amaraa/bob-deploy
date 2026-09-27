export interface ExecOptions {
  sudo?: boolean; // runs `sudo -n <cmd>`; only helper scripts are allowed by sudoers
  timeoutMs?: number; // default 120_000
  stdin?: string;
  onOutput?: (chunk: string, stream: 'stdout' | 'stderr') => void; // already redacted
}
export interface ExecResult {
  code: number;
  stdout: string;
  stderr: string;
}
export interface RemoteExec {
  exec(cmd: string, opts?: ExecOptions): Promise<ExecResult>;
  upload(localPath: string, remotePath: string): Promise<void>;
  close(): Promise<void>;
}
