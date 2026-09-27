/** Well-known vault keys. Anything not covered by these belongs in SettingsRepo, not the vault. */
export const SECRET_BOB_API_KEY = 'bob.apiKey';
export const SECRET_NETLIFY_TOKEN = 'host.netlify.token';
export const SECRET_VERCEL_TOKEN = 'host.vercel.token';

export function sshPrivateKeySecretKey(targetId: string): string {
  return `target.${targetId}.sshPrivateKey`;
}

export function sshPassphraseSecretKey(targetId: string): string {
  return `target.${targetId}.sshPassphrase`;
}

export function projectEnvSecretKey(projectId: string): string {
  return `project.${projectId}.env`;
}
