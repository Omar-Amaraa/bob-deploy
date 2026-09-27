export interface SshPasswordAuth {
  password: string;
}
export interface SshKeyAuth {
  privateKey: string;
  passphrase?: string;
}

export interface SshConnectOptions {
  host: string;
  port: number;
  username: string;
  auth: SshPasswordAuth | SshKeyAuth;
  /** Pinned 'SHA256:...' fingerprint (OpenSSH format). If set and the server's key doesn't match,
   * fails with SSH_HOSTKEY_MISMATCH without ever prompting. */
  expectedFingerprint?: string;
  /** TOFU prompt for a first connection with no pinned fingerprint. false -> SSH_HOSTKEY_REJECTED. */
  onUnknownHostKey?: (fingerprint: string) => Promise<boolean>;
  /** Default 20000. */
  readyTimeoutMs?: number;
  redact: (s: string) => string;
}

export interface ExecOutputChunk {
  stream: 'stdout' | 'stderr';
  text: string;
}

export interface ExecOptions {
  sudo?: boolean;
  /** Default 120000. */
  timeoutMs?: number;
  stdin?: string;
  onOutput?: (chunk: ExecOutputChunk) => void;
}

export interface ExecResult {
  code: number;
  stdout: string;
  stderr: string;
  stdoutTruncated: boolean;
  stderrTruncated: boolean;
}

/** What core (and playbook code) actually depends on — never throws on a non-zero exit; callers
 * check `code`. Only connection-level failures (mapped AppError codes) reject. */
export interface RemoteExec {
  exec(cmd: string, opts?: ExecOptions): Promise<ExecResult>;
  upload(localPath: string, remotePath: string): Promise<void>;
  close(): void;
}

export interface SshSession extends RemoteExec {
  readonly fingerprint: string;
  readonly username: string;
  onClose(cb: () => void): void;
}
