// The copies of the app on the VPS (ADR-0058): staging and production, side
// by side, each in its own folder with its own .env. APP_INSTANCE in that
// .env says which copy a folder is; everything else follows from it, here.
//
//   node deploy/instance.cjs <repo folder> <field>    e.g. `node deploy/instance.cjs . port`
//
// pm2's ecosystem.config.cjs requires it; the shell scripts call it.
const fs = require('node:fs');
const path = require('node:path');
const { parseEnv } = require('node:util');

/** Loopback ports: the app's (nginx proxies to it) and its database's. */
const INSTANCES = {
  staging: { port: 3000, dbPort: 5432, branch: 'staging' },
  production: { port: 3001, dbPort: 5433, branch: 'main' },
};

function instance(root) {
  const env = parseEnv(fs.readFileSync(path.join(root, '.env'), 'utf8'));
  const name = env.APP_INSTANCE ?? '';
  const known = INSTANCES[name];
  if (!known) throw new Error(`APP_INSTANCE in ${path.join(root, '.env')} must be staging or production — it is "${name}"`);
  return {
    name, ...known,
    project: `green-agro-${name}`, // Docker Compose: the database container and its volume
    web: `gsa-${name}-web`,
    worker: `gsa-${name}-worker`,
  };
}

module.exports = { INSTANCES, instance };

if (require.main === module) {
  const [root = '.', field = 'name'] = process.argv.slice(2);
  try {
    const value = instance(root)[field];
    if (value === undefined) throw new Error(`no such field: ${field}`);
    process.stdout.write(`${value}\n`);
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exit(1);
  }
}
