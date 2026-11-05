import { env } from 'cloudflare:workers';
import { getWorkspaceUser, authErrorResponse, AUTH_RESPONSE_HEADERS } from '@/lib/server/auth';
import { createPrivateFileHandlers } from '@/lib/server/private-files';

export const dynamic = 'force-dynamic';
const handlers = createPrivateFileHandlers({
  getUser: getWorkspaceUser,
  getBucket: () => env.BUCKET,
  authErrorResponse,
  responseHeaders: AUTH_RESPONSE_HEADERS,
});

export const POST = handlers.POST;
export const GET = handlers.GET;
