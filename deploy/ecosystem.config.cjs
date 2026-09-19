// pm2 processes for Green Agro (ADR-0035), beside the VPS's other pm2 app:
// the web server on loopback behind nginx, and the background worker. Both
// read the repository's .env.
const fs = require('node:fs');
const path = require('node:path');
const { parseEnv } = require('node:util');

const root = path.join(__dirname, '..');
const PORT = '3000'; // loopback only — deploy/nginx-site.conf proxies to it
const env = {
  ...parseEnv(fs.readFileSync(path.join(root, '.env'), 'utf8')),
  NODE_ENV: 'production',
  // The Node that runs pm2 here, whichever PATH the pm2 daemon was started with.
  PATH: `${path.dirname(process.execPath)}:${process.env.PATH ?? ''}`,
};

module.exports = {
  apps: [
    {
      name: 'gsa-web',
      cwd: path.join(root, 'apps/web'),
      script: 'node_modules/.bin/next',
      args: `start --hostname 127.0.0.1 --port ${PORT}`,
      interpreter: 'none',
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
