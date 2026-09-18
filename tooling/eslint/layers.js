/**
 * The package dependency rule (ARCHITECTURE §2): arrows only point downwards.
 * pnpm's strict node_modules already blocks imports of undeclared packages;
 * these rules additionally block declared-but-forbidden ones and give the
 * reason in the error.
 */
const FRAMEWORK = ['next', 'next/*', 'react', 'react/*', 'react-dom', 'react-dom/*'];
const DATABASE = ['@gsa/db', 'drizzle-orm', 'drizzle-orm/*', 'pg', 'pg-boss'];
const IO = ['node:*', 'fs', 'fs/*', 'path', 'crypto', 'http', 'https', 'net', 'child_process'];

/** ADR-0017: a bounded context is imported only through its index. */
export const crossContext = {
  group: ['../*/*', '../../*/*'],
  message: 'ADR-0017: import another context only through its index.ts, never its internals.',
};

export const layers = {
  core: [
    { group: ['@gsa/*'], message: 'ARCHITECTURE §2: core imports nothing from the project.' },
    { group: [...FRAMEWORK, ...DATABASE, ...IO], message: 'ADR-0017: core is pure — no framework, database or I/O.' },
    crossContext,
  ],
  config: [{ group: ['@gsa/*'], message: 'ARCHITECTURE §2: config imports nothing from the project.' }],
  contracts: [{ group: ['@gsa/*'], message: 'ARCHITECTURE §2: contracts import nothing from the project.' }],
  db: [{ group: ['@gsa/*'], message: 'ARCHITECTURE §2: db holds schema only — no business logic, no project imports.' }],
  services: [
    { group: [...FRAMEWORK, '@gsa/web', '@gsa/worker', '@gsa/ui'], message: 'ARCHITECTURE §2: services never depend on apps, React or Next.' },
    crossContext,
  ],
  ui: [{ group: [...DATABASE, '@gsa/services', '@gsa/config'], message: 'ARCHITECTURE §2: ui components do not fetch data.' }],
  web: [{ group: DATABASE, message: 'ARCHITECTURE §2: the web app reaches the database only through @gsa/services.' }],
  // The worker runs pg-boss itself; everything else reaches the database through services.
  worker: [{ group: [...DATABASE.filter((d) => d !== 'pg-boss'), ...FRAMEWORK], message: 'ARCHITECTURE §2: the worker reaches the database only through @gsa/services.' }],
};
