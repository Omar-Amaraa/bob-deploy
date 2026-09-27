import { readFile, readdir, access } from 'node:fs/promises';
import { join } from 'node:path';
import type { StackInfo } from '@bob-deploy/contracts';

export interface HeuristicResult {
  stack: Partial<StackInfo>;
  confidence: number;
  evidence: string[];
}

interface PackageJson {
  scripts?: Record<string, string>;
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  engines?: Record<string, string>;
}

async function readJsonIfExists<T>(path: string): Promise<T | undefined> {
  try {
    return JSON.parse(await readFile(path, 'utf8')) as T;
  } catch {
    return undefined;
  }
}

async function readTextIfExists(path: string): Promise<string | undefined> {
  try {
    return await readFile(path, 'utf8');
  } catch {
    return undefined;
  }
}

async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

function hasDep(pkg: PackageJson | undefined, name: string): boolean {
  return Boolean(pkg?.dependencies?.[name] ?? pkg?.devDependencies?.[name]);
}

/** package.json-driven JS/TS framework heuristics, checked in a fixed priority order. */
async function detectFromPackageJson(dir: string, pkg: PackageJson): Promise<HeuristicResult | undefined> {
  const evidence: string[] = ['found package.json'];
  const scripts = pkg.scripts ?? {};

  // Next.js: node app, needsBackend unless next.config.* sets output: 'export'.
  if (hasDep(pkg, 'next')) {
    evidence.push('dependency on "next"');
    let staticExport = false;
    for (const cfgName of ['next.config.js', 'next.config.mjs', 'next.config.ts']) {
      const cfg = await readTextIfExists(join(dir, cfgName));
      if (cfg && /output\s*:\s*['"]export['"]/.test(cfg)) {
        staticExport = true;
        evidence.push(`${cfgName} sets output: 'export'`);
        break;
      }
    }
    if (staticExport) {
      return {
        stack: {
          type: 'static',
          framework: 'nextjs',
          installCmd: 'npm ci',
          buildCmd: scripts.build ?? 'next build',
          outputDir: 'out',
          needsBackend: false,
        },
        confidence: 0.9,
        evidence,
      };
    }
    return {
      stack: {
        type: 'node',
        framework: 'nextjs',
        installCmd: 'npm ci',
        buildCmd: scripts.build ?? 'next build',
        startCmd: scripts.start ?? 'npm run start',
        needsBackend: true,
      },
      confidence: 0.9,
      evidence,
    };
  }

  // Static-output frameworks.
  const staticFrameworks: Array<{ dep: string; framework: string; outputDir: string }> = [
    { dep: 'vite', framework: 'vite', outputDir: 'dist' },
    { dep: 'react-scripts', framework: 'cra', outputDir: 'build' },
    { dep: 'astro', framework: 'astro', outputDir: 'dist' },
  ];
  for (const { dep, framework, outputDir } of staticFrameworks) {
    if (hasDep(pkg, dep)) {
      evidence.push(`dependency on "${dep}"`);
      return {
        stack: {
          type: 'static',
          framework,
          installCmd: 'npm ci',
          buildCmd: scripts.build ?? `npm run build`,
          outputDir,
          needsBackend: false,
        },
        confidence: 0.9,
        evidence,
      };
    }
  }

  // Node backend frameworks.
  const nodeFrameworks = ['express', 'fastify', 'koa', '@remix-run/serve', '@remix-run/node', 'svelte', 'nuxt'];
  for (const dep of nodeFrameworks) {
    if (hasDep(pkg, dep)) {
      evidence.push(`dependency on "${dep}"`);
      // An explicit `start` script plus a lockfile is the documented own-server layout
      // (examples/own-server/node-express): nothing left for Bob to guess, so trust it outright.
      const hasLock = await exists(join(dir, 'package-lock.json'));
      if (scripts.start) evidence.push('package.json has a "start" script');
      if (hasLock) evidence.push('found package-lock.json');
      return {
        stack: {
          type: 'node',
          framework: dep.replace('@remix-run/', 'remix-'),
          installCmd: 'npm ci',
          buildCmd: scripts.build,
          startCmd: scripts.start ? 'npm start' : 'npm run start',
          needsBackend: true,
        },
        confidence: scripts.start && hasLock ? 0.9 : 0.8,
        evidence,
      };
    }
  }

  // No recognised framework dependency, but package.json + index.html at root looks like a plain
  // static site with a build step; otherwise fall back to a generic Node app if there's a start script.
  if (await exists(join(dir, 'index.html'))) {
    evidence.push('index.html at project root');
    return {
      stack: { type: 'static', installCmd: scripts.build ? 'npm ci' : undefined, buildCmd: scripts.build, outputDir: '.', needsBackend: false },
      confidence: 0.4,
      evidence,
    };
  }
  if (scripts.start) {
    evidence.push('package.json has a "start" script, no recognised framework');
    return {
      stack: { type: 'node', installCmd: 'npm ci', buildCmd: scripts.build, startCmd: scripts.start, needsBackend: true },
      confidence: 0.3,
      evidence,
    };
  }
  return undefined;
}

/** requirements.txt / pyproject.toml-driven Python framework heuristics. */
async function detectFromPython(dir: string): Promise<HeuristicResult | undefined> {
  const requirements = await readTextIfExists(join(dir, 'requirements.txt'));
  const pyproject = await readTextIfExists(join(dir, 'pyproject.toml'));
  const deps = `${requirements ?? ''}\n${pyproject ?? ''}`.toLowerCase();
  if (!requirements && !pyproject) return undefined;

  const evidence: string[] = [requirements ? 'found requirements.txt' : 'found pyproject.toml'];

  if (/\bdjango\b/.test(deps)) {
    evidence.push('dependency on "django"');
    const hasManage = await exists(join(dir, 'manage.py'));
    if (hasManage) evidence.push('found manage.py');
    return {
      stack: {
        type: 'python',
        framework: 'django',
        installCmd: '.venv/bin/pip install -r requirements.txt',
        startCmd: 'gunicorn mysite.wsgi:application',
        needsBackend: true,
        notes: ['startCmd module path assumes a project named "mysite"; verify against manage.py before use'],
      },
      confidence: 0.6,
      evidence,
    };
  }

  if (/\bfastapi\b/.test(deps)) {
    evidence.push('dependency on "fastapi"');
    const mainPy = await readTextIfExists(join(dir, 'main.py'));
    const definesApp = Boolean(mainPy && /^\s*app\s*=\s*FastAPI\(/m.test(mainPy));
    if (definesApp) evidence.push('main.py defines "app"');
    return {
      stack: {
        type: 'python',
        framework: 'fastapi',
        installCmd: '.venv/bin/pip install -r requirements.txt',
        // uvicorn ignores $PORT on its own; the server's systemd unit sets PORT/HOST per instance.
        startCmd: '.venv/bin/uvicorn main:app --host 127.0.0.1 --port $PORT',
        needsBackend: true,
      },
      confidence: definesApp ? 0.9 : 0.85,
      evidence,
    };
  }

  if (/\bflask\b/.test(deps)) {
    evidence.push('dependency on "flask"');
    const appPy = await readTextIfExists(join(dir, 'app.py'));
    const definesApp = Boolean(appPy && /^\s*app\s*=\s*Flask\(/m.test(appPy));
    if (definesApp) evidence.push('app.py defines "app"');
    return {
      stack: {
        type: 'python',
        framework: 'flask',
        installCmd: '.venv/bin/pip install -r requirements.txt',
        startCmd: '.venv/bin/gunicorn app:app --bind 127.0.0.1:$PORT',
        needsBackend: true,
      },
      confidence: definesApp ? 0.9 : 0.85,
      evidence,
    };
  }

  return {
    stack: { type: 'python', installCmd: '.venv/bin/pip install -r requirements.txt', needsBackend: true },
    confidence: 0.3,
    evidence,
  };
}

async function detectRuntimeVersion(dir: string, pkg: PackageJson | undefined): Promise<string | undefined> {
  const nvmrc = await readTextIfExists(join(dir, '.nvmrc'));
  if (nvmrc) return nvmrc.trim().replace(/^v/, '');
  const engineNode = pkg?.engines?.node;
  if (engineNode) {
    const match = /(\d+)/.exec(engineNode);
    if (match) return match[1];
  }
  return undefined;
}

/**
 * Deterministic, non-AI stack detection: reads package.json / requirements.txt / pyproject.toml /
 * Procfile / index.html and returns a best-effort partial StackInfo with a confidence score and the
 * evidence used, so a caller can decide whether to trust it outright (>= 0.9, per the brief) or fall
 * back to asking Bob with these findings as hints.
 */
export async function detectHeuristic(dir: string): Promise<HeuristicResult> {
  const pkg = await readJsonIfExists<PackageJson>(join(dir, 'package.json'));

  if (pkg) {
    const result = await detectFromPackageJson(dir, pkg);
    if (result) {
      const runtimeVersion = await detectRuntimeVersion(dir, pkg);
      if (runtimeVersion) {
        result.stack.runtimeVersion = runtimeVersion;
        result.evidence.push(`runtime version hint: ${runtimeVersion}`);
      }
      return result;
    }
  }

  const pythonResult = await detectFromPython(dir);
  if (pythonResult) return pythonResult;

  if (await exists(join(dir, 'index.html'))) {
    // No package.json / Python markers reached here; a root index.html with no Procfile or PHP
    // next to it is a plain static site (examples/own-server/static-html), nothing to ask Bob.
    const rootEntries = await readdir(dir).catch(() => [] as string[]);
    const serverSide = rootEntries.some((name) => name === 'Procfile' || name.toLowerCase().endsWith('.php'));
    return {
      stack: { type: 'static', outputDir: '.', needsBackend: false },
      confidence: serverSide ? 0.5 : 0.9,
      evidence: ['index.html at project root, no other markers'],
    };
  }

  const procfile = await readTextIfExists(join(dir, 'Procfile'));
  if (procfile) {
    return {
      stack: { needsBackend: true, notes: [`Procfile present: ${procfile.trim()}`] },
      confidence: 0.2,
      evidence: ['found Procfile but no other recognised markers'],
    };
  }

  return { stack: {}, confidence: 0, evidence: ['no recognised project markers found'] };
}
