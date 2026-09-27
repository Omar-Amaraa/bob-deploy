# Deploying to your own server: project format

Bob Deploy asks Bob to review every project, but it also has its own detection rules.
When those rules are **at least 90% sure**, the deploy goes through even if Bob is slow, fails or
returns something unexpected. Every folder here is built to hit that bar. Copy the one closest to
your project and keep its layout.

Anything that is not a website (a CLI tool, a script, a bot with no HTTP server) cannot be deployed
this way: there is no page for Caddy to serve and nothing for the health check to call.

## Pick your type

| Folder | Use it for | Must have at the project root |
|---|---|---|
| `static-html/` | Plain HTML/CSS/JS, no build | `index.html`. No `package.json`, no `requirements.txt`, no `Procfile`, no `.php` |
| `vite-site/` | A site built with Vite (also CRA, Astro, Next with `output: 'export'`) | `package.json` with `vite` in dependencies and a `build` script, `package-lock.json` |
| `node-express/` | A Node server (Express, Fastify, Koa) | `package.json` with the framework in `dependencies` and a `start` script, `package-lock.json` |
| `python-flask/` | A Flask app | `requirements.txt` with `flask`, `app.py` containing `app = Flask(__name__)` |
| `python-fastapi/` | A FastAPI app | `requirements.txt` with `fastapi`, `main.py` containing `app = FastAPI()` |

## Rules for apps with a server (Node / Python)

1. **Listen on `PORT` and `HOST` from the environment.** The server runs two copies of your app
   (blue/green) on ports it picks itself and sets `PORT` and `HOST=127.0.0.1` for each. Caddy sends
   the public domain to whichever copy is live. A hard-coded port breaks the health check.
2. **`GET /` must answer 200 (or a redirect) within about a minute of starting**, without a login,
   a database or an API key. A new version only goes live after that check passes; otherwise the
   old version stays.
3. **Start command.** Only these are allowed on the server:
   - Node: `npm start` (runs your `start` script; Bob Deploy uses this whenever a `start` script exists)
   - Flask: `.venv/bin/gunicorn app:app --bind 127.0.0.1:$PORT`
   - FastAPI: `.venv/bin/uvicorn main:app --host 127.0.0.1 --port $PORT`

   That is why the file and variable names above (`app.py`/`app`, `main.py`/`app`) are fixed.
4. **Dependencies.** Node: commit `package-lock.json` (the server runs `npm ci --omit=dev`, so
   anything needed at runtime goes in `dependencies`, not `devDependencies`). Python: pin versions
   in `requirements.txt`; the server creates `.venv` and installs gunicorn/uvicorn itself.
5. **Runtime version.** Node: put the major version in `.nvmrc` (e.g. `20`); default is 20.
   Python: the server's `python3` is used (3.12 on Ubuntu 24.04).
6. **Secrets.** Never rely on a `.env` file being uploaded (it is excluded). Enter environment
   variables in the deploy form; they are stored encrypted and written to the server for the app.

## Rules for static sites

- The page must work when served from the domain root (`/`), e.g. `href="/assets/style.css"`.
- With a build step, the build output goes to the framework's default folder (`dist/` for Vite and
  Astro, `build/` for CRA, `out/` for Next export). Bob Deploy builds on your computer and uploads
  only that folder, so Node must be installed locally.

## Testing on the Docker testbed

1. `node testbed/reset.mjs ubuntu2404` from the repo root, and wait for `(healthy)` in `docker ps`.
2. Start the app in real + testbed mode, from `packages/app-shell`:
   `$env:BOB_DEPLOY_MOCK="0"; $env:BOB_DEPLOY_TESTBED="1"; pnpm dev`
3. Deploy form: domain `something.bd.test`, IP `127.0.0.1`, SSH port **2222**, user `root`,
   password `rootPassword` from `testbed/test-secrets.json`.
4. Add `127.0.0.1 something.bd.test` to your hosts file and open `https://something.bd.test:8443`
   (accept the self-signed certificate warning).

`packages/agent/src/detect/examples.test.ts` checks that every folder here is still detected with
at least 90% confidence and a valid start command, so a template can't silently stop deploying.
