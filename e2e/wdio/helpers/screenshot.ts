import { mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';

export const SCREENSHOT_DIR = resolve(__dirname, '..', '..', '.work', 'screenshots');

export async function screenshot(name: string): Promise<string> {
  mkdirSync(SCREENSHOT_DIR, { recursive: true });
  const file = join(SCREENSHOT_DIR, `${name}.png`);
  await browser.saveScreenshot(file);
  return file;
}

export type Mode = 'system' | 'light' | 'dark';

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

const optionShown = (mode: string) =>
  browser.execute((m: string) => !!document.querySelector(`[data-testid="theme-${m}"]`), mode);

/**
 * Picks a theme from the header theme menu. JS clicks reach the menu even while a modal dialog
 * covers the header.
 */
export async function setThemeMode(mode: Mode): Promise<void> {
  if (!(await optionShown(mode))) {
    await browser.execute(() => {
      document.querySelector<HTMLElement>('[data-testid="theme-toggle"]')?.click();
    });
    await browser.waitUntil(() => optionShown(mode), {
      timeout: 5000,
      timeoutMsg: 'the theme menu did not open',
    });
  }
  await browser.execute((m: string) => {
    document.querySelector<HTMLElement>(`[data-testid="theme-${m}"]`)?.click();
  }, mode);
  const closed = () => browser.waitUntil(async () => !(await optionShown(mode)), { timeout: 5000 });
  // Seen in full runs: the menu occasionally stays open after the pick; the toggle closes it.
  if (
    !(await closed().then(
      () => true,
      () => false,
    ))
  ) {
    await browser.execute(() => {
      document.querySelector<HTMLElement>('[data-testid="theme-toggle"]')?.click();
    });
    await closed();
  }
}

const selectMode = setThemeMode;

const refocus = () =>
  browser.execute(() =>
    (
      (window as unknown as { __shotFocus?: Element | null }).__shotFocus as HTMLElement | null
    )?.focus(),
  );

async function settle(keepFocus = false): Promise<void> {
  if (keepFocus) {
    await refocus();
  } else {
    // Blurring an empty input would mark it touched and show its validation error.
    await browser.execute(() => {
      const active = document.activeElement as HTMLElement | null;
      if (!active?.matches('input, textarea')) active?.blur();
    });
  }
  await browser.action('pointer').move({ x: 1, y: 1, origin: 'viewport' }).perform();
  await browser.pause(400);
}

const dialogOpen = () => browser.execute(() => !!document.querySelector('tui-dialog'));

/**
 * The theme menu cannot open while a modal dialog holds the focus, so under a dialog the theme is
 * painted the way the app does it: `tuiTheme` on tui-root, header and aside, and the chrome colour
 * token on `html`. The app state is untouched; painting the original theme back restores it.
 */
const paintTheme = (mode: string) =>
  browser.execute((m: string) => {
    const root = document.querySelector('tui-root');
    const chrome = ['header[tuiNavigationHeader]', 'aside[tuiNavigationAside]'];
    for (const el of [root, ...chrome.map((sel) => document.querySelector(sel))])
      el?.setAttribute('tuiTheme', m);
    if (root) {
      const color = getComputedStyle(root).getPropertyValue('--tui-background-base-alt').trim();
      document.documentElement.style.setProperty('--tui-theme-color', color);
    }
  }, mode);

/**
 * Light and dark shots. By default the focused element is blurred (hints would cover the page);
 * `keepFocus` puts the focus back before each shot instead, for keyboard focus rings.
 */
export async function screenshotThemes(
  name: string,
  { keepFocus = false }: { keepFocus?: boolean } = {},
): Promise<string[]> {
  await browser.execute(() => {
    (window as unknown as { __shotFocus?: Element | null }).__shotFocus = document.activeElement;
  });
  const modal = await dialogOpen();
  const previous = await storedMode();
  const original = await effectiveTheme();
  const files: string[] = [];
  for (const mode of ['light', 'dark'] as const) {
    if (modal) await paintTheme(mode);
    else await selectMode(mode);
    await browser.waitUntil(async () => (await effectiveTheme()) === mode, { timeout: 5000 });
    await settle(keepFocus);
    files.push(await screenshot(`${name}-${mode}`));
  }
  if (modal) await paintTheme(original);
  else await selectMode(previous);
  await settle();
  await refocus();
  return files;
}

/**
 * Screenshots in both themes with a menu freshly opened from `toggleId` in each theme, closed
 * after each shot (an open dropdown keeps the theme it was opened in).
 */
export async function shotWithMenu(
  name: string,
  toggleId: string,
  optionId: string,
): Promise<string[]> {
  const option = $(`[data-testid="${optionId}"]`);
  const previous = await storedMode();
  const files: string[] = [];
  for (const mode of ['light', 'dark'] as const) {
    await setThemeMode(mode);
    await browser.waitUntil(async () => (await effectiveTheme()) === mode, { timeout: 5000 });
    await $(`[data-testid="${toggleId}"]`).click();
    await option.waitForDisplayed({ timeout: 10000 });
    await browser.pause(400);
    files.push(await screenshot(`${name}-${mode}`));
    // A JS click on the theme menu is no outside click: close this menu with its own toggle.
    await $(`[data-testid="${toggleId}"]`).click();
    await option.waitForExist({ timeout: 10000, reverse: true });
  }
  await setThemeMode(previous);
  console.log('screenshots', files);
  return files;
}
