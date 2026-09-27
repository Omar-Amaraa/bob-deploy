import type Database from 'better-sqlite3';
import type { TargetRecord } from '@bob-deploy/contracts';
import { newId, nowIso } from '../../util.js';

interface TargetRow {
  id: string;
  project_id: string;
  kind: string;
  app_name: string | null;
  domain: string | null;
  ip: string | null;
  admin_user: string | null;
  ssh_port: number | null;
  secret_ref: string | null;
  site_url: string | null;
  site_id: string | null;
  host_key_fingerprint: string | null;
  port_a: number | null;
  port_b: number | null;
  tls_mode: string;
  created_at: string;
}

function toRecord(row: TargetRow): TargetRecord {
  return {
    id: row.id,
    kind: row.kind as TargetRecord['kind'],
    ...(row.app_name ? { appName: row.app_name } : {}),
    ...(row.domain ? { domain: row.domain } : {}),
    ...(row.ip ? { ip: row.ip } : {}),
    ...(row.admin_user ? { adminUser: row.admin_user } : {}),
    ...(row.ssh_port !== null ? { sshPort: row.ssh_port } : {}),
    ...(row.site_url ? { siteUrl: row.site_url } : {}),
    ...(row.site_id ? { siteId: row.site_id } : {}),
    ...(row.host_key_fingerprint ? { hostKeyFingerprint: row.host_key_fingerprint } : {}),
  };
}

export interface UpsertTargetInput {
  projectId: string;
  kind: TargetRecord['kind'];
  appName?: string;
  domain?: string;
  ip?: string;
  adminUser?: string;
  sshPort?: number;
  secretRef?: string;
  siteUrl?: string;
  siteId?: string;
  hostKeyFingerprint?: string;
  portA?: number;
  portB?: number;
  tlsMode?: 'auto' | 'internal';
}

export class TargetsRepo {
  constructor(private readonly db: Database.Database) {}

  getByProjectId(projectId: string): TargetRecord | undefined {
    const row = this.db.prepare('SELECT * FROM targets WHERE project_id = ?').get(projectId) as
      TargetRow | undefined;
    return row ? toRecord(row) : undefined;
  }

  get(id: string): TargetRecord | undefined {
    const row = this.db.prepare('SELECT * FROM targets WHERE id = ?').get(id) as TargetRow | undefined;
    return row ? toRecord(row) : undefined;
  }

  /** Internal-only port allocation, not part of the TargetRecord contract — proxy_and_https and
   * later update/rollback jobs need these to rebind the blue/green pair without re-allocating. */
  getPorts(id: string): { portA: number; portB: number; tlsMode: 'auto' | 'internal' } | undefined {
    const row = this.db.prepare('SELECT port_a, port_b, tls_mode FROM targets WHERE id = ?').get(id) as
      | { port_a: number | null; port_b: number | null; tls_mode: string }
      | undefined;
    if (!row || row.port_a === null || row.port_b === null) return undefined;
    return { portA: row.port_a, portB: row.port_b, tlsMode: row.tls_mode as 'auto' | 'internal' };
  }

  /** Every own_server target currently bound to a given host:port, across all projects — used to
   * pick a per-server-unique appName slug (two different projects deployed to the same box must
   * not collide on their systemd unit / Caddy site names). */
  listByServer(ip: string, sshPort: number): TargetRecord[] {
    const rows = this.db
      .prepare("SELECT * FROM targets WHERE kind = 'own_server' AND ip = ? AND ssh_port = ?")
      .all(ip, sshPort) as TargetRow[];
    return rows.map(toRecord);
  }

  /** One target per project (UNIQUE(project_id)): inserts on first deploy, replaces on redeploy. */
  upsert(input: UpsertTargetInput, clockNow?: () => Date): TargetRecord {
    const existing = this.getByProjectId(input.projectId);
    const id = existing?.id ?? newId();
    this.db
      .prepare(
        `INSERT INTO targets (id, project_id, kind, app_name, domain, ip, admin_user, ssh_port, secret_ref,
                              site_url, site_id, host_key_fingerprint, port_a, port_b, tls_mode, created_at)
         VALUES (@id, @project_id, @kind, @app_name, @domain, @ip, @admin_user, @ssh_port, @secret_ref,
                 @site_url, @site_id, @host_key_fingerprint, @port_a, @port_b, @tls_mode, @created_at)
         ON CONFLICT(project_id) DO UPDATE SET
           kind = excluded.kind, app_name = excluded.app_name, domain = excluded.domain, ip = excluded.ip,
           admin_user = excluded.admin_user, ssh_port = excluded.ssh_port, secret_ref = excluded.secret_ref,
           site_url = excluded.site_url, site_id = excluded.site_id,
           host_key_fingerprint = excluded.host_key_fingerprint, port_a = excluded.port_a,
           port_b = excluded.port_b, tls_mode = excluded.tls_mode`,
      )
      .run({
        id,
        project_id: input.projectId,
        kind: input.kind,
        app_name: input.appName ?? null,
        domain: input.domain ?? null,
        ip: input.ip ?? null,
        admin_user: input.adminUser ?? null,
        ssh_port: input.sshPort ?? null,
        secret_ref: input.secretRef ?? null,
        site_url: input.siteUrl ?? null,
        site_id: input.siteId ?? null,
        host_key_fingerprint: input.hostKeyFingerprint ?? null,
        port_a: input.portA ?? null,
        port_b: input.portB ?? null,
        tls_mode: input.tlsMode ?? 'auto',
        created_at: nowIso(clockNow),
      });
    const written = this.getByProjectId(input.projectId);
    if (!written) throw new Error('INTERNAL: target vanished immediately after upsert');
    return written;
  }

  /** Partial update: only siteUrl, unlike upsert() which always rewrites every column (so it must
   * never be used for a partial update — the caller would silently null out every other field). */
  setSiteUrl(id: string, siteUrl: string): void {
    this.db.prepare('UPDATE targets SET site_url = ? WHERE id = ?').run(siteUrl, id);
  }

  /** Partial update: the port pair proxy_and_https allocates, once known. */
  setPorts(id: string, portA: number, portB: number): void {
    this.db.prepare('UPDATE targets SET port_a = ?, port_b = ? WHERE id = ?').run(portA, portB, id);
  }

  deleteForProject(projectId: string): void {
    this.db.prepare('DELETE FROM targets WHERE project_id = ?').run(projectId);
  }
}
