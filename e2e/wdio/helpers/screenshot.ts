import { mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';

export const SCREENSHOT_DIR = resolve(__dirname, '..', '..', '.work', 'screenshots');

export async function screenshot(name: string): Promise<string> {
  mkdirSync(SCREENSHOT_DIR, { recursive: true });
  const file = join(SCREENSHOT_DIR, `${name}.png`);
  await browser.saveScreenshot(file);
  return file;
}
