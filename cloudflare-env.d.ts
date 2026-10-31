declare namespace Cloudflare {
  interface Env {
    DB?: D1Database;
    BUCKET?: R2Bucket;
    WORKSPACE_STORAGE_PROVIDER?: 'd1' | 'supabase';
    SUPABASE_URL?: string;
    SUPABASE_SECRET_KEY?: string;
  }
}
