import express from 'express';

// Bob Deploy's server runs each release under systemd with PORT and HOST set for that instance
// (HOST is 127.0.0.1; Caddy proxies the public domain to it). Always read them from the environment.
const port = Number(process.env.PORT ?? 3000);
const host = process.env.HOST ?? '127.0.0.1';

const app = express();

// Health check: Bob Deploy calls GET / on the new release before switching traffic to it,
// so "/" must answer 200 quickly and without needing a login or a database.
app.get('/', (_req, res) => {
  res.type('html').send('<h1>It works.</h1><p>Deployed by Bob Deploy from examples/own-server/node-express.</p>');
});

app.get('/api/hello', (_req, res) => {
  res.json({ message: 'Hello from the server', time: new Date().toISOString() });
});

app.listen(port, host, () => {
  console.log(`Listening on http://${host}:${port}`);
});
