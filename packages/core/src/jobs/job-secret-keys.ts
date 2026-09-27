/**
 * Well-known keys for the *in-memory-only* per-job JobSecrets map (StepContext.secrets) — distinct
 * from account/secret-keys.ts, which is about the persistent vault. `ctx.inputs` is documented as
 * "parsed non-secret inputs" and is exactly what JobsRepo.create() serializes verbatim into
 * jobs.inputs_json (CLAUDE.md: "Secrets never go to the database"), so anything secret that a
 * DeployStartInput/etc. carries must travel through `secrets` instead — the IPC layer splits it out
 * before calling JobEngine.start(), and JobDefs read it back from here rather than from ctx.inputs.
 */
export const JOB_SECRET_ROOT_PASSWORD = 'rootAuth.password';
export const JOB_SECRET_ROOT_KEY_PASSPHRASE = 'rootAuth.keyPassphrase';
/** JSON-encoded Record<string,string> — the env vars the deploy inputs carried. */
export const JOB_SECRET_ENV_JSON = 'env';
