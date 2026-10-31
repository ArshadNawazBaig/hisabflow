import { access, mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const configFile = path.resolve(root, process.argv[2] || '.cloudflare/config.json');
const buildDirectory = path.join(root, 'dist/server');
const outputFile = path.join(root, '.cloudflare/wrangler.deploy.json');
const projectUrl = 'https://coeazyvaghocoxuzngcc.supabase.co';

function requireValue(condition, message) {
  if (!condition) throw new Error(message);
}

function checkedOrigin(value) {
  let url;
  try { url = new URL(value); } catch { throw new Error('Set appOrigin to the actual HTTPS address of the new deployment.'); }
  requireValue(url.protocol === 'https:' && !url.username && !url.password && url.pathname === '/' && !url.search && !url.hash,
    'appOrigin must be an HTTPS origin without a path, credentials, query, or fragment.');
  requireValue(/^(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,}$/i.test(url.hostname)
    && !/(?:^|\.)(?:chatgpt\.site|localhost|example|invalid|test)$/i.test(url.hostname)
    && !/replace|placeholder|your-worker/i.test(url.hostname),
  'Set appOrigin to the new hosting address, outside the old chatgpt.site service.');
  return url.origin;
}

function inside(directory, candidate) {
  const resolved = path.resolve(directory, candidate);
  requireValue(resolved.startsWith(directory + path.sep), 'The generated build references a path outside its deployment directory.');
  return resolved;
}

try {
  requireValue(process.argv.length <= 3, 'Usage: node scripts/prepare-cloudflare.mjs [account-config.json]');
  let config;
  try { config = JSON.parse(await readFile(configFile, 'utf8')); }
  catch { throw new Error('Create .cloudflare/config.json from cloudflare.config.example.json and fill in the new account details.'); }
  requireValue(config && typeof config === 'object' && !Array.isArray(config), 'The account configuration must be a JSON object.');
  const allowed = new Set(['accountId', 'workerName', 'databaseId', 'databaseName', 'bucketName', 'appOrigin', 'supabasePublishableKey']);
  requireValue(Object.keys(config).every(key => allowed.has(key)), 'The account configuration contains unsupported fields. Keep secret keys out of this file.');
  requireValue(Object.values(config).every(value => typeof value === 'string' && value.length > 0 && value === value.trim()), 'Every account setting must be a non-empty string without surrounding whitespace.');
  requireValue(/^[a-f0-9]{32}$/i.test(config.accountId || '') && !/^0+$/.test(config.accountId), 'Set accountId to the actual Cloudflare account ID.');
  requireValue(/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(config.workerName || ''), 'Set workerName to a valid Cloudflare Worker name.');
  requireValue(/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(config.databaseId || '')
    && !['00000000-0000-4000-8000-000000000000', '00000000-0000-0000-0000-000000000000'].includes(config.databaseId), 'Set databaseId to the actual new D1 database UUID.');
  requireValue(/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/.test(config.databaseName || ''), 'Set databaseName to the actual new D1 database name.');
  requireValue(/^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/.test(config.bucketName || '')
    && !config.bucketName.includes('..') && !/^\d+\.\d+\.\d+\.\d+$/.test(config.bucketName), 'Set bucketName to the actual private R2 bucket name.');
  requireValue(/^sb_publishable_[A-Za-z0-9_-]+$/.test(config.supabasePublishableKey || ''), 'Set supabasePublishableKey to the selected project’s publishable key, never its secret key.');
  const appOrigin = checkedOrigin(config.appOrigin);
  let generated;
  try { generated = JSON.parse(await readFile(path.join(buildDirectory, 'wrangler.json'), 'utf8')); }
  catch { throw new Error('Run npm run build successfully before preparing the deployment.'); }
  requireValue(typeof generated.main === 'string' && typeof generated.assets?.directory === 'string', 'The framework build is missing its Worker entrypoint or static assets.');
  const main = inside(buildDirectory, generated.main);
  const assetsDirectory = path.resolve(buildDirectory, generated.assets.directory);
  requireValue(assetsDirectory.startsWith(path.join(root, 'dist') + path.sep), 'The static assets must remain inside dist.');
  await Promise.all([access(main), access(assetsDirectory)]);
  requireValue(/^\d{4}-\d{2}-\d{2}$/.test(generated.compatibility_date || ''), 'The framework build is missing its compatibility date.');

  // Copy only build/runtime fields; no account, service, connector, or old vars
  // are inherited from the former hosting service.
  const deployment = {
    name: config.workerName,
    account_id: config.accountId,
    main,
    compatibility_date: generated.compatibility_date,
    compatibility_flags: generated.compatibility_flags || [],
    no_bundle: generated.no_bundle ?? true,
    ...(generated.rules ? { rules: generated.rules } : {}),
    ...(generated.observability ? { observability: generated.observability } : {}),
    workers_dev: true,
    preview_urls: false,
    assets: { ...generated.assets, directory: assetsDirectory },
    d1_databases: [{ binding: 'DB', database_name: config.databaseName, database_id: config.databaseId, migrations_dir: path.join(root, 'drizzle') }],
    r2_buckets: [{ binding: 'BUCKET', bucket_name: config.bucketName }],
    vars: {
      HISABFLOW_APP_ORIGIN: appOrigin,
      SUPABASE_URL: projectUrl,
      SUPABASE_PUBLISHABLE_KEY: config.supabasePublishableKey,
      WORKSPACE_STORAGE_PROVIDER: 'supabase',
    },
  };
  await mkdir(path.dirname(outputFile), { recursive: true });
  await writeFile(outputFile, JSON.stringify(deployment, null, 2) + '\n', { mode: 0o600 });
  process.stdout.write('Prepared .cloudflare/wrangler.deploy.json for the supplied account. No resources were created and nothing was deployed.\n');
} catch (error) {
  process.stderr.write((error instanceof Error ? error.message : 'Cloudflare deployment preparation failed.') + '\n');
  process.exitCode = 1;
}
