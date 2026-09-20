#!/usr/bin/env node
/**
 * Completes the standalone build (`output: 'standalone'` in next.config.ts).
 *
 * Next traces the server and its dependencies into `.next/standalone` but
 * deliberately leaves out the static assets, because most deployments serve
 * those from a CDN. We serve them from the same process, so they have to be
 * copied in — without them the app loads and every stylesheet and script 404s.
 *
 * Runs as `postbuild`, so the standalone folder is always complete: the browser
 * tests and the VPS then run the same thing, which is the point (DEVELOPMENT §9).
 */
import { access, cp } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const web = dirname(dirname(fileURLToPath(import.meta.url)));
const standalone = join(web, '.next/standalone/apps/web');

const exists = async (path) => access(path).then(() => true, () => false);

if (!(await exists(standalone))) {
  throw new Error(`no standalone output at ${standalone} — run the build first`);
}

// The hashed chunks, stylesheets and fonts the pages reference.
await cp(join(web, '.next/static'), join(standalone, '.next/static'), { recursive: true });

// `public/` is optional and this app has none today; copy it if one appears.
if (await exists(join(web, 'public'))) {
  await cp(join(web, 'public'), join(standalone, 'public'), { recursive: true });
}

console.log('standalone output completed: static assets copied');
