import path from 'node:path';
import type { NextConfig } from 'next';
import createNextIntlPlugin from 'next-intl/plugin';

// Development reads the repository-root .env; production injects real env vars.
try { process.loadEnvFile(path.join(import.meta.dirname, '../../.env')); } catch { /* absent in production */ }

const withNextIntl = createNextIntlPlugin('./src/i18n/request.ts');

const config: NextConfig = {
  output: 'standalone',
  outputFileTracingRoot: path.join(import.meta.dirname, '../../'),
  // Workspace packages ship TypeScript source.
  transpilePackages: ['@gsa/core', '@gsa/services', '@gsa/contracts', '@gsa/config', '@gsa/db'],
  serverExternalPackages: ['pg'],
  // ADR-0006 (update): nothing operational is cached; cacheComponents stays off.
  poweredByHeader: false,
};

export default withNextIntl(config);
