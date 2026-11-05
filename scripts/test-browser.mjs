import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const suites = ['controls', 'company-actions', 'pdf', 'workspace', 'workspace-mobile', 'company-advance', 'modal-layout', 'import-actions', 'infinite-hook', 'infinite-lists', 'pwa'];
for (const suite of suites) {
  const result = spawnSync(process.execPath, ['--experimental-strip-types', `tests/${suite}-browser.mjs`], {
    cwd: root, stdio: 'inherit', timeout: 180000,
  });
  if (result.error) console.error(result.error.message);
  if (result.error || result.status !== 0) process.exit(result.status || 1);
}
