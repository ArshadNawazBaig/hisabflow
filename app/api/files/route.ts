import { env } from 'cloudflare:workers';
import { getChatGPTUser } from '../../chatgpt-auth';

export const dynamic = 'force-dynamic';
const json = (value:unknown,status=200) => Response.json(value,{status,headers:{'Cache-Control':'no-store'}});
export async function POST(request: Request) {
  const user = await getChatGPTUser();
  if (!user) return json({error:'Sign in to upload private documents.'},401);
  if (!env.BUCKET) return json({error:'Private file storage is not available yet.'},503);
  const origin = request.headers.get('origin');
  if (origin && origin !== new URL(request.url).origin) return json({error:'Cross-origin uploads are not allowed.'},403);
  if (Number(request.headers.get('content-length') || 0) > 21 * 1024 * 1024) return json({error:'Files must be under 20 MB.'},413);
  try {
    const form = await request.formData();
    const file = form.get('file');
    if (!(file instanceof File) || file.size === 0 || file.size > 20 * 1024 * 1024) return json({error:'Choose a non-empty file under 20 MB.'},400);
    const allowed = ['application/pdf','text/csv','text/plain','image/png','image/jpeg'];
    if (!allowed.includes(file.type) && !/\.(pdf|csv|txt|png|jpe?g)$/i.test(file.name)) return json({error:'Upload a PDF, CSV, text file, PNG or JPG.'},400);
    const bytes = await file.arrayBuffer();
    const hash = [...new Uint8Array(await crypto.subtle.digest('SHA-256',bytes))].map(n=>n.toString(16).padStart(2,'0')).join('');
    const safeName = file.name.replace(/[^\w. -]/g,'_').slice(0,160);
    const key = `owners/${encodeURIComponent(user.userId)}/${hash}/${safeName}`;
    await env.BUCKET.put(key,bytes,{httpMetadata:{contentType:allowed.includes(file.type)?file.type:'application/octet-stream'},customMetadata:{ownerId:user.userId,originalName:safeName,hash}});
    return json({key,name:safeName,hash});
  } catch { return json({error:'The private file could not be uploaded. Please retry.'},503); }
}
export async function GET(request: Request) {
  const user = await getChatGPTUser();
  if (!user) return json({error:'Sign in to view private documents.'},401);
  if (!env.BUCKET) return json({error:'Private file storage is not available yet.'},503);
  const key = new URL(request.url).searchParams.get('key');
  if (!key || !key.startsWith(`owners/${encodeURIComponent(user.userId)}/`)) return json({error:'Document not found.'},404);
  const file = await env.BUCKET.get(key);
  if (!file || file.customMetadata?.ownerId !== user.userId) return json({error:'Document not found.'},404);
  return new Response(file.body,{headers:{'Content-Type':file.httpMetadata?.contentType || 'application/octet-stream','Content-Disposition':`attachment; filename="${file.customMetadata.originalName.replace(/["\r\n]/g,'_')}"`,'Cache-Control':'private, no-store','X-Content-Type-Options':'nosniff'}});
}
