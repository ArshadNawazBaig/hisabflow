import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, copyFile, writeFile, rm, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

test('built local startup reuses root credentials, pins loopback, and enables explicit local auth', async () => {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), 'hisabflow local start ')));
  try {
    await mkdir(path.join(root, 'scripts'), { recursive: true });
    await mkdir(path.join(root, 'node_modules/wrangler/bin'), { recursive: true });
    for (const name of ['start-local.mjs', 'sites-env.mjs', 'tool-environment.mjs']) await copyFile(new URL(`../scripts/${name}`, import.meta.url), path.join(root, 'scripts', name));
    await writeFile(path.join(root, 'node_modules/wrangler/bin/wrangler.js'), 'if(require.main !== module) throw new Error("Launch as the main module"); process.stdout.write(JSON.stringify({args:process.argv.slice(2),cwd:process.cwd()}));');
    const start = () => spawnSync(process.execPath, [path.join(root, 'scripts/start-local.mjs')], { encoding: 'utf8', cwd: tmpdir() });
    const missing = start();
    assert.notEqual(missing.status, 0); assert.match(missing.stderr, /Build the app first/);
    await mkdir(path.join(root, 'dist/server'), { recursive: true });
    await writeFile(path.join(root, 'dist/server/wrangler.json'), '{}');
    await writeFile(path.join(root, '.env'), 'SUPABASE_SECRET_KEY=synthetic-not-a-credential');
    const run = start(); assert.equal(run.status, 0, run.stderr);
    const result = JSON.parse(run.stdout), value = flag => result.args[result.args.indexOf(flag) + 1];
    assert.equal(result.cwd, root);
    assert.equal(value('--env-file'), path.join(root, '.env'));
    assert.equal(value('--ip'), '127.0.0.1'); assert.equal(value('--port'), '5173');
    assert.ok(result.args.includes('--local')); assert.ok(!result.args.includes('--remote'));
    assert.equal(value('--var'), 'HISABFLOW_LOCAL_RUNTIME:1');
    assert.ok(!run.stdout.includes('synthetic-not-a-credential'), 'Credential values never enter command arguments.');
    await writeFile(path.join(root, '.dev.vars'), 'SUPABASE_SECRET_KEY=preferred-synthetic-value');
    const preferred = start(); assert.equal(preferred.status, 0, preferred.stderr);
    const args = JSON.parse(preferred.stdout).args;
    assert.equal(args[args.indexOf('--env-file') + 1], path.join(root, '.dev.vars'));
  } finally { await rm(root, { recursive: true, force: true }); }
});
