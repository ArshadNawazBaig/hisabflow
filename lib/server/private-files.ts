import { readBoundedFormData, RequestBodyTooLargeError } from './request-body.ts';
import { workspaceOwnerFailure } from './workspace-access.ts';

const MAX_FILE_BYTES = 20 * 1024 * 1024;
const ALLOWED_TYPES = ['application/pdf', 'text/csv', 'text/plain', 'image/png', 'image/jpeg'];

type FileAccess = {
  getUser: () => Promise<{ userId: string } | null>;
  getBucket: () => Pick<R2Bucket, 'put' | 'get'> | undefined;
  authErrorResponse: (error: unknown) => Response;
  responseHeaders: Record<string, string>;
};

/** Request-scoped authentication and bucket access keep every document owner-scoped. */
export function createPrivateFileHandlers(access: FileAccess) {
  const json = (value: unknown, status = 200) => Response.json(value, { status, headers: access.responseHeaders });

  async function POST(request: Request): Promise<Response> {
    let user: { userId: string } | null;
    try { user = await access.getUser(); } catch (error) { return access.authErrorResponse(error); }
    if (!user) return json({ error: 'Sign in to upload private documents.' }, 401);
    const bucket = access.getBucket();
    if (!bucket) return json({ error: 'Private file storage is not available yet.' }, 503);
    const origin = request.headers.get('origin');
    if ((origin && origin !== new URL(request.url).origin) || request.headers.get('sec-fetch-site') === 'cross-site') {
      return json({ error: 'Cross-origin uploads are not allowed.' }, 403);
    }
    if (request.headers.has('X-Workspace-Owner')) {
      const ownerFailure = workspaceOwnerFailure(request, user.userId);
      if (ownerFailure) return json({ error: ownerFailure.error, code: ownerFailure.code }, ownerFailure.status);
    }
    let form: FormData;
    try {
      form = await readBoundedFormData(request, 21 * 1024 * 1024);
    } catch (error) {
      if (error instanceof RequestBodyTooLargeError) return json({ error: 'Files must be under 20 MB.' }, 413);
      return json({ error: 'Send a valid file upload.' }, 400);
    }
    try {
      const file = form.get('file');
      if (!(file instanceof File) || file.size === 0 || file.size > MAX_FILE_BYTES) return json({ error: 'Choose a non-empty file under 20 MB.' }, 400);
      if (!ALLOWED_TYPES.includes(file.type) && !/\.(pdf|csv|txt|png|jpe?g)$/i.test(file.name)) return json({ error: 'Upload a PDF, CSV, text file, PNG or JPG.' }, 400);
      const bytes = await file.arrayBuffer();
      const hash = [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))].map(n => n.toString(16).padStart(2, '0')).join('');
      const safeName = file.name.replace(/[^\w. -]/g, '_').slice(0, 160) || 'document';
      const key = `owners/${encodeURIComponent(user.userId)}/${hash}/${safeName}`;
      await bucket.put(key, bytes, {
        httpMetadata: { contentType: ALLOWED_TYPES.includes(file.type) ? file.type : 'application/octet-stream' },
        customMetadata: { ownerId: user.userId, originalName: safeName, hash },
      });
      return json({ key, name: safeName, hash });
    } catch {
      return json({ error: 'The private file could not be uploaded. Please retry.' }, 503);
    }
  }

  async function GET(request: Request): Promise<Response> {
    let user: { userId: string } | null;
    try { user = await access.getUser(); } catch (error) { return access.authErrorResponse(error); }
    if (!user) return json({ error: 'Sign in to view private documents.' }, 401);
    const bucket = access.getBucket();
    if (!bucket) return json({ error: 'Private file storage is not available yet.' }, 503);
    const key = new URL(request.url).searchParams.get('key');
    if (!key || !key.startsWith(`owners/${encodeURIComponent(user.userId)}/`)) return json({ error: 'Document not found.' }, 404);
    try {
      const file = await bucket.get(key);
      if (!file || file.customMetadata?.ownerId !== user.userId) return json({ error: 'Document not found.' }, 404);
      const originalName = file.customMetadata.originalName || key.split('/').pop() || 'document';
      const safeName = originalName.replace(/[^\w. -]/g, '_').slice(0, 160) || 'document';
      return new Response(file.body, { headers: {
        ...access.responseHeaders,
        'Content-Type': file.httpMetadata?.contentType || 'application/octet-stream',
        'Content-Disposition': `attachment; filename="${safeName}"`,
        'X-Content-Type-Options': 'nosniff',
      } });
    } catch {
      return json({ error: 'The private file could not be retrieved. Please retry.' }, 503);
    }
  }

  return { POST, GET };
}
