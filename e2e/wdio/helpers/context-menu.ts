import { screenshot, setThemeMode } from './screenshot';

/** The open app context menu of a surface (`file-row`, `file-pane`, `transfer`, `key`, `edited`…). */
export const contextMenu = (surface: string) =>
  $(`[data-testid="context-menu"][data-surface="${surface}"]`);

/** Taiga dropdowns in the page, once a closing one has finished its leave animation. */
export async function openDropdowns(): Promise<number> {
  await browser.pause(400);
  return browser.execute(() => document.querySelectorAll('tui-dropdown').length);
}

export async function closeContextMenu(surface: string): Promise<void> {
  await browser.keys('Escape');
  await contextMenu(surface).waitForExist({ timeout: 5000, reverse: true });
}

/** Light and dark shots of a context menu opened fresh in each theme (a dropdown keeps its theme). */
export async function shotContextMenu(
  name: string,
  surface: string,
  open: () => Promise<unknown>,
): Promise<string[]> {
  const files: string[] = [];
  for (const mode of ['light', 'dark'] as const) {
    await setThemeMode(mode);
    await browser.pause(400);
    await open();
    await contextMenu(surface).waitForDisplayed({ timeout: 5000 });
    await browser.pause(400);
    files.push(await screenshot(`${name}-${mode}`));
    await closeContextMenu(surface);
  }
  await setThemeMode('system');
  console.log('screenshots', files);
  return files;
}

/** The menu's horizontal edges relative to the pointer it opened at. */
export async function menuEdges(surface: string): Promise<{ left: number; right: number }> {
  const menu = contextMenu(surface);
  const { x } = await menu.getLocation();
  const { width } = await menu.getSize();
  return { left: x, right: x + width };
}
