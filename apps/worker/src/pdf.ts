import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import type { sales } from '@gsa/services';
import { chromium, type Browser } from 'playwright-core';

const require = createRequire(import.meta.url);
const fontDir = dirname(require.resolve('@fontsource/ibm-plex-sans-arabic/LICENSE'));

/**
 * ADR-0037: the document's font travels inside it — IBM Plex Sans Arabic
 * (the interface's face), Arabic and Latin subsets, as data URLs — so the
 * PDF does not depend on what fonts the server has.
 */
function embeddedFonts(): string {
  const blocks: string[] = [];
  for (const weight of [400, 600, 700]) {
    const css = readFileSync(join(fontDir, `${weight}.css`), 'utf8');
    for (const block of css.split('@font-face').slice(1)) {
      const file = /url\(\.\/files\/([^)]+?\.woff2)\)/.exec(block)?.[1];
      const range = /unicode-range:\s*([^;]+);/.exec(block)?.[1];
      if (!file || !range || !/-(arabic|latin|latin-ext)-\d+-normal\.woff2$/.test(file)) continue;
      const data = readFileSync(join(fontDir, 'files', file)).toString('base64');
      blocks.push(`@font-face { font-family: 'IBM Plex Sans Arabic'; font-style: normal; font-weight: ${weight}; src: url(data:font/woff2;base64,${data}) format('woff2'); unicode-range: ${range}; }`);
    }
  }
  return blocks.join('\n');
}

/**
 * ADR-0019: HTML → PDF in headless Chromium, which shapes Arabic correctly.
 * The browser starts when there is something to print and is closed after
 * each pass. The page runs no script and may fetch nothing — everything it
 * needs is inline.
 */
export function chromiumRenderer(): sales.PdfRenderer & { close(): Promise<void> } {
  let browser: Browser | null = null;
  const fontCss = embeddedFonts();
  return {
    fontCss,
    async render(html) {
      // --no-sandbox: the worker runs as root under pm2 (ADR-0035), where Chromium's sandbox will not start.
      browser ??= await chromium.launch({ args: ['--no-sandbox', '--disable-dev-shm-usage'] });
      const context = await browser.newContext({ javaScriptEnabled: false });
      try {
        await context.route(/^(https?|file|ftp|ws):/, (route) => route.abort());
        const page = await context.newPage();
        await page.setContent(html, { waitUntil: 'load' });
        return await page.pdf({ format: 'A4', printBackground: true, preferCSSPageSize: true });
      } finally {
        await context.close();
      }
    },
    async close() {
      await browser?.close();
      browser = null;
    },
  };
}
