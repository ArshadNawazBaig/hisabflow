import { HISABFLOW_SUPABASE_URL } from './supabase-workspace.ts';

export const PRIVATE_DOCUMENT_BUCKET = 'hisabflow-documents';
export const MAX_PRIVATE_FILE_BYTES = 20 * 1024 * 1024;
const MIME_TYPES = ['application/pdf', 'text/csv', 'text/plain', 'image/png', 'image/jpeg'];
const HASH = /^[a-f0-9]{64}$/;

export class SupabaseFileError extends Error {
  readonly code: 'configuration' | 'invalid-file' | 'not-found' | 'hash' | 'unavailable';
  constructor(code: 'configuration' | 'invalid-file' | 'not-found' | 'hash' | 'unavailable') {
    super({
      configuration: 'Private file storage is not configured. Please contact the workspace owner.',
      'invalid-file': 'Choose a non-empty PDF, CSV, text file, PNG or JPG under 20 MB.',
      'not-found': 'Document not found.',
      hash: 'The retained document could not be verified. Retry the original file.',
      unavailable: 'Private file storage is temporarily unavailable. Please retry.',
    }[code]);
    this.name = 'SupabaseFileError';
    this.code = code;
  }
}

type FileDescription = { name: string; size: number; type: string; hash: string };
type RetainedFile = { key: string; name: string; hash: string };
export type VerifiedFileHead = {
  customMetadata: { ownerId: string; hash: string; originalName: string };
  httpMetadata: { contentType: string };
};

function checkedOwner(value: string): string {
  if (typeof value !== 'string' || !value.trim() || value.length > 200 || /[\u0000-\u001f\u007f]/.test(value)) throw new SupabaseFileError('invalid-file');
  return value;
}
function safeName(value: string): string {
  return value.replace(/[^\w. -]/g, '_').slice(0, 160) || 'document';
}
function checkedKey(key: string, ownerId: string, expectedHash?: string) {
  checkedOwner(ownerId);
  if (typeof key !== 'string') throw new SupabaseFileError('not-found');
  const [root, owner, hash, name, ...extra] = key.split('/');
  if (root !== 'owners' || owner !== encodeURIComponent(ownerId) || !HASH.test(hash || '') || !name || name === '.' || name === '..' || safeName(name) !== name || extra.length || (expectedHash !== undefined && hash !== expectedHash)) throw new SupabaseFileError('not-found');
  return { key, name, hash };
}
function headersFor(key: string): Record<string, string> {
  if (typeof key !== 'string' || !key) throw new SupabaseFileError('configuration');
  if (/^sb_secret_[A-Za-z0-9_-]+$/.test(key)) return { apikey: key };
  try {
    const parts = key.split('.');
    if (parts.length !== 3 || parts.some(part => !/^[A-Za-z0-9_-]+$/.test(part))) throw new Error();
    const raw = parts[1].replaceAll('-', '+').replaceAll('_', '/');
    if (JSON.parse(atob(raw.padEnd(Math.ceil(raw.length / 4) * 4, '='))).role !== 'service_role') throw new Error();
    return { apikey: key, Authorization: `Bearer ${key}` };
  } catch { throw new SupabaseFileError('configuration'); }
}

async function boundedBytes(response: Response, maximum: number): Promise<Uint8Array<ArrayBuffer>> {
  if (Number(response.headers.get('content-length')) > maximum) {
    await response.body?.cancel().catch(() => {});
    throw new SupabaseFileError('invalid-file');
  }
  if (!response.body) return new Uint8Array(0);
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maximum) { await reader.cancel().catch(() => {}); throw new SupabaseFileError('invalid-file'); }
      chunks.push(value);
    }
  } finally { reader.releaseLock(); }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  return bytes;
}

/** Private, immutable objects; browser-supplied metadata never proves ownership or content. */
export function createSupabaseFileStore(config: { url: string; secretKey: string; fetcher?: typeof fetch }) {
  if (config.url !== HISABFLOW_SUPABASE_URL) throw new SupabaseFileError('configuration');
  const headers = headersFor(config.secretKey);
  const fetcher = config.fetcher ?? fetch;
  const base = `${HISABFLOW_SUPABASE_URL}/storage/v1`;
  async function objectPath(key: string): Promise<string> {
    const [root, encodedOwner, hash, name] = key.split('/');
    // Supabase rejects literal percent signs in object keys. Keep the logical
    // owner-scoped reference and use a stable, safe physical owner directory.
    const ownerHash = [...new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(decodeURIComponent(encodedOwner))))].map(byte => byte.toString(16).padStart(2, '0')).join('');
    return `${PRIVATE_DOCUMENT_BUCKET}/${[root, ownerHash, hash, name].map(encodeURIComponent).join('/')}`;
  }

  async function request(endpoint: string, method: 'GET' | 'POST', value?: unknown, extraHeaders?: Record<string, string>) {
    try {
      return await fetcher(`${base}${endpoint}`, {
        method, headers: { ...headers, ...extraHeaders, ...(value === undefined ? {} : { 'Content-Type': 'application/json' }) },
        ...(value === undefined ? {} : { body: JSON.stringify(value) }),
        cache: 'no-store', redirect: 'error', signal: AbortSignal.timeout(30_000),
      });
    } catch { throw new SupabaseFileError('unavailable'); }
  }
  async function readJson(response: Response): Promise<Record<string, unknown>> {
    try {
      const value = JSON.parse(new TextDecoder().decode(await boundedBytes(response, 16 * 1024)));
      if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error();
      return value;
    } catch { throw new SupabaseFileError('unavailable'); }
  }
  async function signedUrl(value: unknown, operation: 'upload' | 'download', key: string): Promise<string> {
    try {
      if (typeof value !== 'string') throw new Error();
      const result = new URL(value.startsWith('/') ? `${base}${value}` : value);
      const prefix = operation === 'upload' ? '/storage/v1/object/upload/sign/' : '/storage/v1/object/sign/';
      if (result.origin !== HISABFLOW_SUPABASE_URL || result.username || result.password || !result.pathname.startsWith(`${prefix}${PRIVATE_DOCUMENT_BUCKET}/`) || !result.searchParams.get('token')) throw new Error();
      const trusted = new URL(`${base}${operation === 'upload' ? '/object/upload/sign/' : '/object/sign/'}${await objectPath(key)}`);
      trusted.searchParams.set('token', result.searchParams.get('token')!);
      return trusted.toString();
    } catch { throw new SupabaseFileError('unavailable'); }
  }
  async function verifyHead(key: string, ownerId: string, expectedHash?: string): Promise<VerifiedFileHead | null> {
    const file = checkedKey(key, ownerId, expectedHash);
    const response = await request(`/object/authenticated/${await objectPath(key)}`, 'GET');
    if (!response.ok) {
      if (response.status === 404) { await response.body?.cancel().catch(() => {}); return null; }
      if (response.status === 400) {
        const failure = await readJson(response);
        if (String(failure.statusCode) === '404' || failure.error === 'not_found') return null;
      }
      throw new SupabaseFileError('unavailable');
    }
    let bytes: Uint8Array<ArrayBuffer>;
    try { bytes = await boundedBytes(response, MAX_PRIVATE_FILE_BYTES); }
    catch (error) { throw error instanceof SupabaseFileError ? error : new SupabaseFileError('unavailable'); }
    if (!bytes.byteLength) throw new SupabaseFileError('invalid-file');
    const hash = [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))].map(byte => byte.toString(16).padStart(2, '0')).join('');
    if (hash !== file.hash) throw new SupabaseFileError('hash');
    const contentType = response.headers.get('content-type')?.split(';')[0] || 'application/octet-stream';
    return { customMetadata: { ownerId, hash, originalName: file.name }, httpMetadata: { contentType } };
  }
  async function beginUpload(ownerId: string, description: FileDescription): Promise<RetainedFile & { signedUrl?: string; contentType?: string }> {
    checkedOwner(ownerId);
    const { name, size, type, hash } = description;
    if (typeof name !== 'string' || !name || name.length > 1000 || typeof type !== 'string' || !Number.isSafeInteger(size) || size < 1 || size > MAX_PRIVATE_FILE_BYTES || !HASH.test(hash) || (!MIME_TYPES.includes(type) && !/\.(pdf|csv|txt|png|jpe?g)$/i.test(name))) throw new SupabaseFileError('invalid-file');
    const filename = safeName(name);
    const key = `owners/${encodeURIComponent(ownerId)}/${hash}/${filename}`;
    if (await verifyHead(key, ownerId, hash)) return { key, name: filename, hash };
    const response = await request(`/object/upload/sign/${await objectPath(key)}`, 'POST', {}, { 'x-upsert': 'false' });
    if (!response.ok) throw new SupabaseFileError('unavailable');
    const data = await readJson(response);
    return { key, name: filename, hash, signedUrl: await signedUrl(data.url, 'upload', key), contentType: MIME_TYPES.includes(type) ? type : 'application/octet-stream' };
  }
  async function completeUpload(ownerId: string, value: { key: string; hash: string }): Promise<RetainedFile> {
    const file = checkedKey(value.key, ownerId, value.hash);
    if (!HASH.test(value.hash) || !(await verifyHead(file.key, ownerId, value.hash))) throw new SupabaseFileError('not-found');
    return file;
  }
  async function signedDownload(key: string, ownerId: string): Promise<string> {
    const file = checkedKey(key, ownerId);
    if (!(await verifyHead(key, ownerId))) throw new SupabaseFileError('not-found');
    const response = await request(`/object/sign/${await objectPath(key)}`, 'POST', { expiresIn: 60 });
    if (!response.ok) throw new SupabaseFileError('unavailable');
    const data = await readJson(response);
    const result = new URL(await signedUrl(data.signedURL, 'download', key));
    result.searchParams.set('download', file.name);
    return result.toString();
  }
  return { beginUpload, completeUpload, verifyHead, signedDownload };
}
