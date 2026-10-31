import { env } from 'cloudflare:workers';
import { getWorkspaceUser, authErrorResponse, AUTH_RESPONSE_HEADERS } from '@/lib/server/auth';
import { validatePostedChanges, validateWorkspaceRecords } from '@/lib/accounting';
import { saveSchema } from '@/lib/workspace-validation';
import type { Workspace } from '@/lib/types';
import { getWorkspaceStore, configuredWorkspaceProvider, workspaceStorageMessage } from '@/lib/server/workspace-store';

export const dynamic = 'force-dynamic';
const json = (value: unknown, status = 200) => Response.json(value, { status, headers: AUTH_RESPONSE_HEADERS });
export async function GET() {
  let user: Awaited<ReturnType<typeof getWorkspaceUser>>;
  try { user = await getWorkspaceUser(); } catch (error) { return authErrorResponse(error); }
  if (!user) return json({ error: 'Sign in to access your private business workspace.' }, 401);
  try {
    const row = await getWorkspaceStore().get(user.userId);
    return json({ data: row?.data ?? null, revision: row?.revision ?? 0, storage: configuredWorkspaceProvider(), user: { name: user.displayName, email: user.email, provider: user.provider, canLinkGoogle: user.canLinkGoogle } });
  } catch (error) { return json({ error: workspaceStorageMessage(error) }, 503); }
}

export async function PUT(request: Request) {
  let user: Awaited<ReturnType<typeof getWorkspaceUser>>;
  try { user = await getWorkspaceUser(); } catch (error) { return authErrorResponse(error); }
  if (!user) return json({ error: 'Sign in before saving business records.' }, 401);
  const origin = request.headers.get('origin');
  if (origin && origin !== new URL(request.url).origin) return json({ error: 'Cross-origin writes are not allowed.' }, 403);
  if (Number(request.headers.get('content-length') || 0) > 8 * 1024 * 1024) return json({ error: 'Workspace is too large.' }, 413);
  let body: unknown;
  try { const raw = await request.text(); if (raw.length > 8 * 1024 * 1024) return json({error:'Workspace is too large.'},413); body = JSON.parse(raw); }
  catch { return json({ error: 'Send valid JSON.' }, 400); }
  const parsed = saveSchema.safeParse(body);
  if (!parsed.success) return json({ error: 'Some business records have invalid fields.', fields: parsed.error.issues.slice(0, 8).map(i => `${i.path.join('.')}: ${i.message}`) }, 400);
  const { revision, action, detail } = parsed.data;
  const incoming = parsed.data.data as Workspace;
  const unique = (items: {id:string}[]) => new Set(items.map(i => i.id)).size === items.length;
  if (![incoming.companies,incoming.shipments,incoming.payments,incoming.imports].every(unique)) return json({error:'Record IDs must be unique within their collection.'},400);
  const companies = new Set(incoming.companies.map(c => c.id));
  if (incoming.shipments.some(s => !companies.has(s.companyId)) || incoming.payments.some(p => !!p.companyId && !companies.has(p.companyId))) return json({error:'Every selected company must exist in this workspace.'},400);
  try {
    const store = getWorkspaceStore();
    const stored = await store.get(user.userId);
    if ((stored?.revision ?? 0) !== revision) return json({ error: 'Your workspace changed in another tab. Reload before saving.', revision: stored?.revision ?? 0 }, 409);
    const previous: Workspace | null = stored?.data ?? null;
    // Recompute postings before a single atomic snapshot write. No partial financial effects are persisted.
    const failures = [...validateWorkspaceRecords(incoming, previous), ...validatePostedChanges(incoming, previous, user.displayName)];
    if (failures.length) return json({ error: 'The records do not match their reviewed accounting effects.', fields: failures }, 400);
    for (const batch of incoming.imports.filter(b => b.status === 'Posted' && !previous?.imports.some(p => p.id === b.id && p.status === 'Posted'))) {
      // Uploaded files are only accepted when they belong to the authenticated owner.
      if (!batch.fileKey?.startsWith(`owners/${encodeURIComponent(user.userId)}/${batch.hash}/`)) return json({error:'The source file does not belong to this workspace or its hash differs.'},403);
      const file = await env.BUCKET?.head(batch.fileKey);
      if (!file || file.customMetadata?.ownerId !== user.userId || file.customMetadata.hash !== batch.hash) return json({error:'The retained source file could not be verified.'},400);
    }
    const now = new Date().toISOString();
    const sourceBatch = incoming.imports.find(b => b.status === 'Posted' && !previous?.imports.some(p => p.id === b.id && p.status === 'Posted'));
    const event = { id: `AUD-${crypto.randomUUID()}`, at: now, action, detail, actor: user.displayName, ...(sourceBatch ? {sourceRef: sourceBatch.id} : {}) };
    const data: Workspace = { ...incoming, audit: [event, ...(previous?.audit ?? [])].slice(0, 50000) };
    const saved = await store.save(user.userId, data, revision);
    if (!saved) return json({ error: 'Your workspace changed. Reload before saving.' }, 409);
    return json({ revision: saved.revision, data: saved.data });
  } catch (error) { return json({ error: workspaceStorageMessage(error) }, 503); }
}
