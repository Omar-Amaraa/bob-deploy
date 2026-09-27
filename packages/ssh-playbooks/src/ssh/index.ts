export { connectSsh, type ConnectSshDeps } from './session.js';
export { ConnectionPool } from './pool.js';
export { shellQuote } from './shell-quote.js';
export { SshError, classifyConnectError } from './errors.js';
export { fingerprintOf, makeHostVerifier } from './host-verifier.js';
export type {
  SshConnectOptions,
  SshSession,
  RemoteExec,
  ExecOptions,
  ExecResult,
  ExecOutputChunk,
  SshPasswordAuth,
  SshKeyAuth,
} from './types.js';
