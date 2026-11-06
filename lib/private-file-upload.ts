type RetainedFile = { key: string; name?: string; hash: string };
type UploadPayload = { key?: string; name?: string; hash?: string; error?: string; signedUrl?: string; contentType?: string };
const SUPABASE_ORIGIN = 'https://coeazyvaghocoxuzngcc.supabase.co';

/** Vercel requests carry upload details only; document bytes go to private storage. */
export async function uploadPrivateFile(file: File, ownerId?: string): Promise<RetainedFile> {
  const headers: Record<string, string> = ownerId ? { 'X-Workspace-Owner': encodeURIComponent(ownerId) } : {};
  if (typeof process === 'undefined' || process.env.NEXT_PUBLIC_HISABFLOW_HOSTING !== 'vercel') {
    const form = new FormData(); form.append('file', file);
    const response = await fetch('/api/files', { method: 'POST', headers, body: form });
    const payload = await response.json().catch(() => ({})) as UploadPayload;
    if (!response.ok || !payload.key) throw new Error(payload.error || 'The original file could not be retained. Please retry.');
    return payload as RetainedFile;
  }
  if (!file.size || file.size > 20 * 1024 * 1024) throw new Error('Choose a non-empty file under 20 MB.');
  const hash = [...new Uint8Array(await crypto.subtle.digest('SHA-256', await file.arrayBuffer()))].map(byte => byte.toString(16).padStart(2, '0')).join('');
  async function details(value: Record<string, unknown>) {
    const response = await fetch('/api/files', { method: 'POST', headers: { ...headers, 'Content-Type': 'application/json' }, body: JSON.stringify(value) });
    const payload = await response.json().catch(() => ({})) as UploadPayload;
    if (!response.ok) throw new Error(payload.error || 'The original file could not be retained. Please retry.');
    return payload;
  }
  const pending = await details({ action: 'begin', name: file.name, size: file.size, type: file.type, hash });
  if (!pending.key || pending.hash !== hash) throw new Error('The private upload could not be authorized.');
  if (pending.signedUrl) {
    const signed = new URL(pending.signedUrl);
    if (signed.origin !== SUPABASE_ORIGIN || signed.username || signed.password || !signed.pathname.startsWith('/storage/v1/object/upload/sign/hisabflow-documents/') || !signed.searchParams.get('token')) throw new Error('The private upload could not be authorized.');
    const upload = await fetch(signed, { method: 'PUT', headers: { 'Content-Type': pending.contentType || 'application/octet-stream', 'x-upsert': 'false', 'cache-control': 'no-store' }, body: file, credentials: 'omit', redirect: 'error' });
    // A simultaneous exact-file upload may have won; completion verifies stored bytes.
    if (!upload.ok && ![400, 409].includes(upload.status)) throw new Error('The original file could not be uploaded. Please retry.');
  }
  const retained = await details({ action: 'complete', key: pending.key, hash });
  if (!retained.key || retained.hash !== hash) throw new Error('The retained document could not be verified. Retry the original file.');
  return retained as RetainedFile;
}
