/** Server-only environment used by the standard Next.js build. */
export const env: Cloudflare.Env = {
  WORKSPACE_STORAGE_PROVIDER: 'supabase',
  SUPABASE_URL: process.env.SUPABASE_URL,
  SUPABASE_SECRET_KEY: process.env.SUPABASE_SECRET_KEY,
  SUPABASE_PUBLISHABLE_KEY: process.env.SUPABASE_PUBLISHABLE_KEY,
  HISABFLOW_APP_ORIGIN: process.env.HISABFLOW_APP_ORIGIN,
  HISABFLOW_LOCAL_RUNTIME: process.env.HISABFLOW_LOCAL_RUNTIME,
};
