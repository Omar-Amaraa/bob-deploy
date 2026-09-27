import { createHash } from 'node:crypto';
import { stat, readdir } from 'node:fs/promises';
import { join, relative, sep } from 'node:path';
import { create as tarCreate } from 'tar';

export type PackageKind = 'static' | 'node' | 'python';

export interface PackageResult {
  tarPath: string;
  /** sha256 (hex) of a deterministic manifest (sorted relative path + size per file) — used to
   * detect whether two builds produced byte-identical output, and included in release metadata. */
  folderHash: string;
  fileCount: number;
}

/** Directory/file name exclusions, by stack kind, matching the release procedure's step c exactly:
 * static -> only the outputDir's own contents are packaged (no excludes needed, see packageRelease
 * below); node -> exclude node_modules, .env files and .git; python -> exclude .venv, __pycache__,
 * .env files and .git. */
const EXCLUDE_DIR_NAMES: Record<Exclude<PackageKind, 'static'>, ReadonlySet<string>> = {
  node: new Set(['node_modules', '.git']),
  python: new Set(['.venv', '__pycache__', '.git']),
};

function isExcludedName(name: string, excludedDirNames: ReadonlySet<string>): boolean {
  if (excludedDirNames.has(name)) return true;
  if (name === '.git') return true;
  if (name.startsWith('.env')) return true; // .env, .env.local, .env.production, ...
  return false;
}

/** Walks `root` depth-first, returning every regular file's path relative to `root` (posix-style
 * separators, sorted), skipping any directory/file whose basename is excluded. */
async function listFiles(root: string, excludedDirNames: ReadonlySet<string>): Promise<string[]> {
  const out: string[] = [];
  async function walk(dir: string): Promise<void> {
    const entries = await readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      if (isExcludedName(entry.name, excludedDirNames)) continue;
      const abs = join(dir, entry.name);
      if (entry.isDirectory()) {
        await walk(abs);
      } else if (entry.isFile() || entry.isSymbolicLink()) {
        out.push(relative(root, abs).split(sep).join('/'));
      }
    }
  }
  await walk(root);
  out.sort();
  return out;
}

async function computeFolderHash(root: string, files: readonly string[]): Promise<string> {
  const hash = createHash('sha256');
  for (const file of files) {
    const st = await stat(join(root, file));
    hash.update(`${file}\t${st.size}\n`);
  }
  return hash.digest('hex');
}

/**
 * Release procedure step c: packages `sourceDir` (or, for static, the contents of `sourceDir`
 * itself — pass the outputDir, not the whole staging copy) into a gzip'd tar at `outTarPath`,
 * applying the stack-appropriate exclusions, and computes a folderHash over the resulting file
 * manifest. Static apps get no exclusions (the output dir is assumed to already be exactly what
 * should be served) since the brief describes packaging "outputDir contents" verbatim.
 */
export async function packageRelease(sourceDir: string, kind: PackageKind, outTarPath: string): Promise<PackageResult> {
  const excludedDirNames = kind === 'static' ? new Set<string>() : EXCLUDE_DIR_NAMES[kind];
  const files = await listFiles(sourceDir, excludedDirNames);
  if (files.length === 0) {
    throw new Error(`Nothing to package: ${sourceDir} contained no files after applying exclusions.`);
  }
  const folderHash = await computeFolderHash(sourceDir, files);
  await tarCreate({ gzip: true, file: outTarPath, cwd: sourceDir, portable: true }, files);
  return { tarPath: outTarPath, folderHash, fileCount: files.length };
}
