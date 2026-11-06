import { env } from 'cloudflare:workers';
import { getWorkspaceUser, authErrorResponse, AUTH_RESPONSE_HEADERS } from '@/lib/server/auth';
import { createPrivateFileHandlers } from '@/lib/server/private-files';
import { createVercelFileHandlers } from '@/lib/server/vercel-files';
import { createSupabaseFileStore } from '@/lib/server/supabase-files';

export const dynamic = 'force-dynamic';
const cloudflareHandlers = createPrivateFileHandlers({
  getUser: getWorkspaceUser,
  getBucket: () => env.BUCKET,
  authErrorResponse,
  responseHeaders: AUTH_RESPONSE_HEADERS,
});
const vercelHandlers = createVercelFileHandlers({
  getUser: getWorkspaceUser,
  getStore: () => createSupabaseFileStore({url: env.SUPABASE_URL || '', secretKey: env.SUPABASE_SECRET_KEY || ''}),
  authErrorResponse,
  responseHeaders: AUTH_RESPONSE_HEADERS,
});

export const POST = (request: Request) => env.BUCKET ? cloudflareHandlers.POST(request) : vercelHandlers.POST(request);
export const GET = (request: Request) => env.BUCKET ? cloudflareHandlers.GET(request) : vercelHandlers.GET(request);
