import { NextResponse, type NextRequest } from 'next/server';

/**
 * The network boundary (Next.js 16 proxy, Node runtime). Deliberately coarse:
 * a cookie *present* check and a CSRF origin check. Real authentication and
 * authorisation happen in route handlers and services (ADR-0005).
 */
const SESSION_COOKIE = 'gsa_session';
const PUBLIC_PAGES = ['/login'];
const PUBLIC_API = ['/api/v1/auth/sign-in', '/api/v1/health'];
const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);
// Compared against the configured public origin, not the URL Next.js rebuilds
// from proxy headers — behind nginx that may read http:// while the browser
// sends https:// (SECURITY §2).
const APP_ORIGIN = process.env.APP_URL ? new URL(process.env.APP_URL).origin : null;

function problem(status: number, code: string) {
  return NextResponse.json({ type: `https://greenagro.app/problems/${code.toLowerCase()}`, title: code, status, code }, {
    status, headers: { 'content-type': 'application/problem+json' },
  });
}

export default function proxy(request: NextRequest) {
  const { pathname } = request.nextUrl;
  const isApi = pathname.startsWith('/api/');

  // SECURITY §2: every state-changing API request must come from our own origin.
  if (isApi && !SAFE_METHODS.has(request.method)) {
    const origin = request.headers.get('origin');
    if (!origin || !APP_ORIGIN || origin !== APP_ORIGIN) return problem(403, 'CSRF_ORIGIN_MISMATCH');
  }

  const hasSession = request.cookies.has(SESSION_COOKIE);
  if (isApi) {
    if (!hasSession && !PUBLIC_API.includes(pathname)) return problem(401, 'UNAUTHENTICATED');
    return NextResponse.next();
  }
  if (!hasSession && !PUBLIC_PAGES.includes(pathname)) {
    const login = new URL('/login', request.url);
    if (pathname !== '/') login.searchParams.set('next', pathname);
    return NextResponse.redirect(login);
  }
  return NextResponse.next();
}

export const config = {
  matcher: ['/((?!_next/static|_next/image|favicon.ico|icons/|manifest.webmanifest).*)'],
};
