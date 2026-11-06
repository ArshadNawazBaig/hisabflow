import { createSupabaseFileStore, SupabaseFileError } from './supabase-files.ts';
import { readBoundedBody, RequestBodyTooLargeError } from './request-body.ts';
import { workspaceOwnerFailure } from './workspace-access.ts';

type FileAccess = {
  getUser: () => Promise<{ userId: string } | null>;
  getStore: () => ReturnType<typeof createSupabaseFileStore>;
  authErrorResponse: (error: unknown) => Response;
  responseHeaders: Record<string, string>;
};

export function createVercelFileHandlers(access: FileAccess) {
  const json = (value: unknown, status = 200) => Response.json(value, { status, headers: access.responseHeaders });
  const failed = (error: unknown) => json({ error: error instanceof SupabaseFileError ? error.message : 'Private file storage is temporarily unavailable. Please retry.' }, error instanceof SupabaseFileError ? error.code === 'not-found' ? 404 : error.code === 'invalid-file' || error.code === 'hash' ? 400 : 503 : 503);

  async function POST(request: Request) {
    let user: { userId: string } | null;
    try { user = await access.getUser(); } catch (error) { return access.authErrorResponse(error); }
    if (!user) return json({ error: 'Sign in to upload private documents.' }, 401);
    if (request.headers.get('origin') !== new URL(request.url).origin || request.headers.get('sec-fetch-site') === 'cross-site') return json({ error: 'Cross-origin uploads are not allowed.' }, 403);
    const ownerFailure = workspaceOwnerFailure(request, user.userId);
    if (ownerFailure) return json({ error: ownerFailure.error, code: ownerFailure.code }, ownerFailure.status);
    try {
      if (!request.headers.get('content-type')?.startsWith('application/json')) return json({ error: 'Send valid upload details.' }, 400);
      const value = JSON.parse(new TextDecoder().decode(await readBoundedBody(request, 4096)));
      if (!value || typeof value !== 'object' || Array.isArray(value)) return json({ error: 'Send valid upload details.' }, 400);
      const store = access.getStore();
      if (value.action === 'begin') return json(await store.beginUpload(user.userId, value));
      if (value.action === 'complete') return json(await store.completeUpload(user.userId, value));
      return json({ error: 'Send valid upload details.' }, 400);
    } catch (error) {
      if (error instanceof SyntaxError || error instanceof RequestBodyTooLargeError) return json({ error: 'Send valid upload details.' }, 400);
      return failed(error);
    }
  }
  async function GET(request: Request) {
    let user: { userId: string } | null;
    try { user = await access.getUser(); } catch (error) { return access.authErrorResponse(error); }
    if (!user) return json({ error: 'Sign in to view private documents.' }, 401);
    const key = new URL(request.url).searchParams.get('key');
    if (!key) return json({ error: 'Document not found.' }, 404);
    try {
      return new Response(null, { status: 303, headers: { ...access.responseHeaders, Location: await access.getStore().signedDownload(key, user.userId), 'Referrer-Policy': 'no-referrer' } });
    } catch (error) { return failed(error); }
  }
  return { POST, GET };
}
