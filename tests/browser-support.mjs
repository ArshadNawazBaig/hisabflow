import { existsSync } from 'node:fs';

// Use an explicit browser when provided, system Chrome on macOS, or Playwright's
// installed Chromium on Linux/Windows (including CI).
export function browserLaunchOptions() {
  const systemChrome = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
  const executablePath = process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE
    || (process.platform === 'darwin' && existsSync(systemChrome) ? systemChrome : undefined);
  return { headless: true, ...(executablePath ? { executablePath } : {}) };
}
