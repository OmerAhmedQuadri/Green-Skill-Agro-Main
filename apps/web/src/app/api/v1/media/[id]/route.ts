import { media } from '@gsa/services';
import { authedRoute } from '@/server/route';

/**
 * Step 4: permission check, then a redirect to a 5-minute signed URL
 * (SECURITY §5). The URL is a bearer capability: never cached, never leaked
 * through Referer.
 */
export const GET = authedRoute<{ id: string }>(async ({ ctx, params }) => new Response(null, {
  status: 302,
  headers: {
    location: await media.mediaDownloadUrl(ctx, params.id),
    'cache-control': 'private, no-store',
    'referrer-policy': 'no-referrer',
  },
}));
