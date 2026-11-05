import { existsSync } from 'node:fs';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { projectRoot } from './sites-env.mjs';

const config = path.join(projectRoot, 'dist/server/wrangler.json');
if (!existsSync(config)) throw new Error('Build the app first with npm run build, then run npm start.');

// The compiled config lives in dist/server, so Wrangler otherwise looks for
// credentials there. Reuse the private root file without copying its contents.
const envFile = ['.dev.vars', '.env'].map(name => path.join(projectRoot, name)).find(existsSync);
const cli = fileURLToPath(new URL('../node_modules/wrangler/bin/wrangler.js', import.meta.url));
const args = [cli, 'dev', '--config', config,
  '--local', '--persist-to', path.join(projectRoot, '.wrangler/state'),
  '--ip', '127.0.0.1', '--port', '5173', '--inspector-port', '0',
  '--var', 'HISABFLOW_LOCAL_RUNTIME:1',
  ...(envFile ? ['--env-file', envFile] : []), ...process.argv.slice(2)];
// Wrangler's CommonJS launcher runs only as the main module.
const child = spawn(process.execPath, args, { cwd: projectRoot, stdio: 'inherit' });
for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => child.kill(signal));
child.once('error', error => { console.error(`Could not start the local app: ${error.message}`); process.exitCode = 1; });
child.once('exit', code => { process.exitCode = code ?? 1; });
