import { Component } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { clearMocks, mockIPC } from '@tauri-apps/api/mocks';
import { provideTaiga, TuiNotificationService, TuiRoot } from '@taiga-ui/core';
import { TranslocoService } from '@jsverse/transloco';
import { of } from 'rxjs';
import type { ExternalEditorSetting } from '../../../core/ipc/external-edits';
import { ExternalEditorSettings } from './external-editor-settings';

@Component({
  imports: [TuiRoot, ExternalEditorSettings],
  template: '<tui-root><app-external-editor-settings /></tui-root>',
})
class Host {}

describe('ExternalEditorSettings', () => {
  let setting: ExternalEditorSetting;
  let picked: string | null;
  let saveError: { code: string; message: string } | null;
  let saves: ExternalEditorSetting[];
  const alerts = { open: vi.fn(() => of(undefined)) };
  const settle = () => new Promise((r) => setTimeout(r, 0));

  beforeEach(() => {
    vi.clearAllMocks();
    setting = { mode: 'system', appPath: null, noticeSeen: false };
    picked = null;
    saveError = null;
    saves = [];
    mockIPC((cmd, args) => {
      switch (cmd) {
        case 'get_external_editor':
          return setting;
        case 'set_external_editor':
          if (saveError) {
            throw saveError;
          }
          saves.push(args as unknown as ExternalEditorSetting);
          setting = args as unknown as ExternalEditorSetting;
          return setting;
        case 'pick_external_editor':
          return picked;
      }
      return null;
    });
    TestBed.configureTestingModule({
      imports: [Host],
      providers: [provideTaiga(), { provide: TuiNotificationService, useValue: alerts }],
    });
  });

  afterEach(() => clearMocks());

  async function render() {
    const fixture = TestBed.createComponent(Host);
    await fixture.whenStable();
    await settle();
    await fixture.whenStable();
    const byId = <T extends HTMLElement>(id: string) =>
      document.body.querySelector<T>(`[data-testid="${id}"]`);
    const radio = (id: string) => byId(id)!.querySelector('input')!;
    const stable = async () => {
      await settle();
      await fixture.whenStable();
      await settle();
    };
    return { fixture, byId, radio, stable };
  }

  it('shows the current setting: System default, the notice switch on', async () => {
    const { byId, radio } = await render();
    expect(radio('settings-ext-system').checked).toBe(true);
    expect(byId('settings-ext-path')).toBeNull();
    expect(byId<HTMLInputElement>('settings-ext-notice')!.checked).toBe(true);
    const description = byId('settings-ext-description')!;
    expect(description.textContent).toContain('Scripts and programs are never run');
    expect(radio('settings-ext-system').getAttribute('aria-describedby')).toBe(description.id);
    expect(radio('settings-ext-custom').getAttribute('aria-describedby')).toBe(description.id);
  });

  it('follows a switch to French', async () => {
    const { byId, stable } = await render();
    TestBed.inject(TranslocoService).setActiveLang('fr');
    await stable();
    expect(byId('settings-ext-system')!.textContent?.trim()).toBe('Application du système');
    expect(byId('settings-ext-description')!.textContent).toContain(
      'Les scripts et programmes ne sont jamais exécutés',
    );
  });

  it('switches to Custom app with no app chosen yet, then picks one with Browse', async () => {
    const { byId, radio, stable } = await render();
    radio('settings-ext-custom').click();
    await stable();
    expect(saves.at(-1)).toEqual({ mode: 'custom', appPath: null, noticeSeen: false });
    expect(byId('settings-ext-description')!.textContent?.trim()).toBe(
      'Files open with this app; the file is its only argument.',
    );
    const path = byId<HTMLInputElement>('settings-ext-path')!;
    expect(path.value).toBe('');
    expect(path.placeholder).toBe('No app chosen');
    expect(document.body.textContent).toContain("Pick the editor's program file.");
    picked = 'C:\\Tools\\Code.exe';
    byId('settings-ext-browse')!.click();
    await stable();
    expect(saves.at(-1)).toEqual({
      mode: 'custom',
      appPath: 'C:\\Tools\\Code.exe',
      noticeSeen: false,
    });
    expect(byId<HTMLInputElement>('settings-ext-path')!.value).toBe('C:\\Tools\\Code.exe');
  });

  it('keeps the setting when the picker is cancelled, and Clear goes back to System default', async () => {
    setting = { mode: 'custom', appPath: 'C:\\Tools\\Code.exe', noticeSeen: true };
    const { byId, radio, stable } = await render();
    byId('settings-ext-browse')!.click();
    await stable();
    expect(saves).toEqual([]);
    byId('settings-ext-clear')!.click();
    await stable();
    expect(saves.at(-1)).toEqual({ mode: 'system', appPath: null, noticeSeen: true });
    expect(radio('settings-ext-system').checked).toBe(true);
    expect(byId('settings-ext-path')).toBeNull();
  });

  it('shows a refused app as a field error, not a toast', async () => {
    setting = { mode: 'custom', appPath: null, noticeSeen: true };
    const { byId, stable } = await render();
    saveError = { code: 'app_not_editor', message: 'cmd.exe runs or forwards files' };
    picked = '/usr/bin/sh';
    byId('settings-ext-browse')!.click();
    await stable();
    await vi.waitFor(() => expect(byId('settings-ext-error')).not.toBeNull());
    expect(byId('settings-ext-error')?.textContent).toContain(
      "This program runs scripts or commands; it is not an editor. Pick your editor's program file.",
    );
    await vi.waitFor(() =>
      expect(byId('settings-ext-path')!.getAttribute('aria-invalid')).toBe('true'),
    );
    expect(alerts.open).not.toHaveBeenCalled();
    saveError = null;
    picked = '/usr/bin/code';
    byId('settings-ext-browse')!.click();
    await stable();
    expect(byId('settings-ext-error')).toBeNull();
  });

  it('turns the notice off, and restores the switch when the save fails', async () => {
    const { byId, stable } = await render();
    byId<HTMLInputElement>('settings-ext-notice')!.click();
    await stable();
    expect(saves.at(-1)).toEqual({ mode: 'system', appPath: null, noticeSeen: true });
    saveError = { code: 'io', message: 'the config could not be written' };
    byId<HTMLInputElement>('settings-ext-notice')!.click();
    await stable();
    expect(alerts.open).toHaveBeenCalledWith(
      expect.stringContaining('The config could not be written.'),
      expect.objectContaining({ label: 'Setting not saved' }),
    );
    expect(byId<HTMLInputElement>('settings-ext-notice')!.checked).toBe(false);
  });
});
