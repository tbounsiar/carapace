import { mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';

export const SCREENSHOT_DIR = resolve(__dirname, '..', '..', '.work', 'screenshots');

export async function screenshot(name: string): Promise<string> {
  mkdirSync(SCREENSHOT_DIR, { recursive: true });
  const file = join(SCREENSHOT_DIR, `${name}.png`);
  await browser.saveScreenshot(file);
  return file;
}

type Mode = 'system' | 'light' | 'dark';

const effectiveTheme = () =>
  browser.execute(() => document.querySelector('tui-root')?.getAttribute('tuiTheme') ?? '');

const storedMode = () =>
  browser.execute((): string => {
    try {
      return localStorage.getItem('carapace.theme') ?? 'system';
    } catch {
      return 'system';
    }
  }) as Promise<Mode>;

// A JS click reaches the toggle even while a modal dialog covers the header.
const selectMode = (mode: Mode) =>
  browser.execute((m: string) => {
    document.querySelector<HTMLElement>(`[data-testid="theme-${m}"]`)?.click();
  }, mode);

async function settle(): Promise<void> {
  // Blurring an empty input would mark it touched and show its validation error.
  await browser.execute(() => {
    const active = document.activeElement as HTMLElement | null;
    if (!active?.matches('input, textarea')) active?.blur();
  });
  await browser.action('pointer').move({ x: 1, y: 1, origin: 'viewport' }).perform();
  await browser.pause(400);
}

export async function screenshotThemes(name: string): Promise<string[]> {
  await browser.execute(() => {
    (window as unknown as { __shotFocus?: Element | null }).__shotFocus = document.activeElement;
  });
  const previous = await storedMode();
  const files: string[] = [];
  for (const mode of ['light', 'dark'] as const) {
    await selectMode(mode);
    await browser.waitUntil(async () => (await effectiveTheme()) === mode, { timeout: 5000 });
    await settle();
    files.push(await screenshot(`${name}-${mode}`));
  }
  await selectMode(previous);
  await settle();
  await browser.execute(() =>
    (
      (window as unknown as { __shotFocus?: Element | null }).__shotFocus as HTMLElement | null
    )?.focus(),
  );
  return files;
}
