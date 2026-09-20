import { randomUUID } from 'node:crypto';
import { NextResponse, type NextRequest } from 'next/server';

/**
 * The network boundary (Next.js 16 proxy, Node runtime). Deliberately coarse:
 * a cookie *present* check and a CSRF origin check. Real authentication and
 * authorisation happen in route handlers and services (ADR-0005).
 */
const SESSION_COOKIE = 'gsa_session';
const PUBLIC_PAGES = ['/login', '/forgot-password', '/reset-password'];
const PUBLIC_API = ['/api/v1/auth/sign-in', '/api/v1/auth/password/forgot', '/api/v1/auth/password/reset', '/api/v1/health'];
const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);
// Compared against the configured public origin, not the URL Next.js rebuilds
// from proxy headers — behind nginx that may read http:// while the browser
// sends https:// (SECURITY §2).
const APP_ORIGIN = process.env.APP_URL ? new URL(process.env.APP_URL).origin : null;

/**
 * Photos are read and written straight from the browser against R2 presigned
 * URLs (ADR-0020), so its origin has to be allowed to load images and to be
 * connected to. Nothing else about the bucket is public.
 */
const MEDIA_ORIGIN = (() => {
  try {
    return process.env.S3_ENDPOINT ? new URL(process.env.S3_ENDPOINT).origin : '';
  } catch {
    return '';
  }
})();

const DEV = process.env.NODE_ENV === 'development';

/**
 * SECURITY §7. The nonce is per response and Next.js applies it to its own
 * scripts and styles; `strict-dynamic` then lets those load the rest, so no
 * bundle path has to be listed here.
 *
 * `style-src-attr 'unsafe-inline'` covers React `style={{…}}` attributes, which
 * a nonce cannot reach. One component uses one, to set a progress bar's width.
 * A style attribute cannot execute script; the alternative is a stylesheet
 * rewritten on every render.
 *
 * `'unsafe-eval'` is development only — React evaluates there to rebuild server
 * stacks in the browser. Neither React nor Next.js evaluates in production.
 */
function contentSecurityPolicy(nonce: string): string {
  return [
    "default-src 'self'",
    `script-src 'self' 'nonce-${nonce}' 'strict-dynamic'${DEV ? " 'unsafe-eval'" : ''}`,
    `style-src 'self' 'nonce-${nonce}'`,
    "style-src-attr 'unsafe-inline'",
    `img-src 'self' blob: data:${MEDIA_ORIGIN ? ` ${MEDIA_ORIGIN}` : ''}`,
    `connect-src 'self'${MEDIA_ORIGIN ? ` ${MEDIA_ORIGIN}` : ''}`,
    "font-src 'self'",
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    "frame-ancestors 'none'",
    'upgrade-insecure-requests',
  ].join('; ');
}

/**
 * Camera and location are the app's own (ATT-013, STO-002) and nobody else's;
 * the microphone is never used. HSTS is nginx's, where TLS is terminated.
 */
const HEADERS: Readonly<Record<string, string>> = {
  'permissions-policy': 'camera=(self), geolocation=(self), microphone=()',
  'referrer-policy': 'same-origin',
  'x-content-type-options': 'nosniff',
};

function secured(response: NextResponse, nonce: string): NextResponse {
  response.headers.set('content-security-policy', contentSecurityPolicy(nonce));
  for (const [name, value] of Object.entries(HEADERS)) response.headers.set(name, value);
  return response;
}

function problem(status: number, code: string) {
  return NextResponse.json({ type: `https://greenagro.app/problems/${code.toLowerCase()}`, title: code, status, code }, {
    status, headers: { 'content-type': 'application/problem+json' },
  });
}

export default function proxy(request: NextRequest) {
  const { pathname } = request.nextUrl;
  const isApi = pathname.startsWith('/api/');
  const nonce = Buffer.from(randomUUID()).toString('base64');

  // SECURITY §2: every state-changing API request must come from our own
  // origin and carry a JSON body. The content type is the second lock: the
  // three types a cross-origin HTML form can send — urlencoded, multipart and
  // text/plain — are the ones that travel without a preflight, and none of
  // them is a type this API accepts. Every mutation takes JSON (a spreadsheet
  // arrives base64-encoded inside it), so nothing legitimate is turned away.
  if (isApi && !SAFE_METHODS.has(request.method)) {
    const origin = request.headers.get('origin');
    if (!origin || !APP_ORIGIN || origin !== APP_ORIGIN) return problem(403, 'CSRF_ORIGIN_MISMATCH');
    const contentType = request.headers.get('content-type')?.split(';')[0]?.trim().toLowerCase();
    if (contentType !== 'application/json') return problem(415, 'UNSUPPORTED_MEDIA_TYPE');
  }

  const hasSession = request.cookies.has(SESSION_COOKIE);
  if (isApi) {
    if (!hasSession && !PUBLIC_API.includes(pathname)) return problem(401, 'UNAUTHENTICATED');
    return secured(NextResponse.next(), nonce);
  }
  if (!hasSession && !PUBLIC_PAGES.includes(pathname)) {
    const login = new URL('/login', request.url);
    if (pathname !== '/') login.searchParams.set('next', pathname);
    return secured(NextResponse.redirect(login), nonce);
  }
  // Next.js reads the nonce back off the request's own policy header and
  // applies it while rendering, so it must be set on both.
  const headers = new Headers(request.headers);
  headers.set('content-security-policy', contentSecurityPolicy(nonce));
  headers.set('x-nonce', nonce);
  return secured(NextResponse.next({ request: { headers } }), nonce);
}

export const config = {
  matcher: ['/((?!_next/static|_next/image|favicon.ico|icons/|manifest.webmanifest).*)'],
};
