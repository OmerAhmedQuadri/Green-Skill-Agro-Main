// pm2 processes for Green Skill Agro (ADR-0035), beside the VPS's other pm2
// app: the web server on loopback behind nginx, and the background worker.
// Both read the repository's .env.
const fs = require('node:fs');
const path = require('node:path');
const { parseEnv } = require('node:util');

const root = path.join(__dirname, '..');
const PORT = '3000'; // loopback only — deploy/nginx-site.conf proxies to it

const env = {
  ...parseEnv(fs.readFileSync(path.join(root, '.env'), 'utf8')),
  NODE_ENV: 'production',
  /**
   * The standalone server takes its address from the environment and defaults
   * to 0.0.0.0. Left unset it would publish the app *beside* nginx rather than
   * behind it — reachable on :3000 without the proxy, so without the
   * X-Real-IP that the rate limits and every audit row are written from.
   */
  HOSTNAME: '127.0.0.1',
  PORT,
  // The Node that runs pm2 here, whichever PATH the pm2 daemon was started with.
  PATH: `${path.dirname(process.execPath)}:${process.env.PATH ?? ''}`,
};

module.exports = {
  apps: [
    {
      name: 'gsa-web',
      /**
       * The build's own server (`output: 'standalone'`), which is what
       * `pnpm start` and the browser suite run. This used to be `next start`,
       * which Next does not support against a standalone build: the server
       * that shipped was not the server under test, and the static assets
       * `postbuild` copies in are only reachable through this one.
       */
      cwd: path.join(root, 'apps/web/.next/standalone/apps/web'),
      script: 'server.js',
      env,
      max_memory_restart: '1G',
    },
    {
      name: 'gsa-worker',
      cwd: path.join(root, 'apps/worker'),
      script: 'node_modules/.bin/tsx',
      args: 'src/index.ts',
      interpreter: 'none',
      env,
      max_memory_restart: '512M',
    },
  ],
};
