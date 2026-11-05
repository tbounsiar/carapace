import { signal } from '@angular/core';
import { type ComponentFixture, TestBed } from '@angular/core/testing';
import { provideTaiga } from '@taiga-ui/core';
import { TranslocoService } from '@jsverse/transloco';
import { ConfigService } from '../../../core/ipc/config';
import { fakeConfig, host } from '../../../core/ipc/config.fixture';
import { KeyStore } from '../../../core/ipc/key-store';
import { DataTransferActions } from '../../data-transfer/data-transfer-actions';
import { DataSettings } from './data-settings';

describe('DataSettings', () => {
  let fixture: ComponentFixture<DataSettings>;
  let config: ReturnType<typeof fakeConfig>;
  const keys = signal<unknown[]>([]);
  const importing = signal(false);
  const actions = { importing, exportData: vi.fn(), importData: vi.fn() };
  const button = (id: string) =>
    (fixture.nativeElement as HTMLElement).querySelector<HTMLButtonElement>(
      `[data-testid="${id}"]`,
    )!;

  async function setup(): Promise<void> {
    await TestBed.configureTestingModule({
      imports: [DataSettings],
      providers: [
        provideTaiga(),
        { provide: ConfigService, useValue: config },
        { provide: KeyStore, useValue: { keys, ensureLoaded: () => Promise.resolve() } },
        { provide: DataTransferActions, useValue: actions },
      ],
    }).compileComponents();
    fixture = TestBed.createComponent(DataSettings);
    await fixture.whenStable();
  }

  beforeEach(() => {
    vi.clearAllMocks();
    keys.set([]);
    importing.set(false);
    config = fakeConfig();
  });

  it('starts an export or an import', async () => {
    config.nodes.set([host('h1', 'vps')]);
    await setup();
    expect(fixture.nativeElement.textContent).toContain(
      'Passwords and other secrets are never included.',
    );
    button('settings-export').click();
    button('settings-import').click();
    expect(actions.exportData).toHaveBeenCalledWith();
    expect(actions.importData).toHaveBeenCalled();
  });

  it('follows a switch to French', async () => {
    config.nodes.set([host('h1', 'vps')]);
    await setup();
    TestBed.inject(TranslocoService).setActiveLang('fr');
    await fixture.whenStable();
    expect(fixture.nativeElement.textContent).toContain('ne sont jamais inclus');
    expect(button('settings-export').textContent?.trim()).toBe('Exporter…');
    expect(button('settings-import').textContent?.trim()).toBe('Importer…');
  });

  it('disables Export when there is nothing to export, never Import', async () => {
    await setup();
    expect(button('settings-export').disabled).toBe(true);
    expect(button('settings-import').disabled).toBe(false);
    expect(fixture.nativeElement.textContent).toContain('Nothing to export yet.');
    keys.set([{ id: 'k1' }]);
    await fixture.whenStable();
    expect(button('settings-export').disabled).toBe(false);
  });

  it('disables both while the data loads', async () => {
    config.loaded.set(false);
    await setup();
    expect(button('settings-export').disabled).toBe(true);
    expect(button('settings-import').disabled).toBe(true);
  });

  it('shows the import loader while the picker is open', async () => {
    await setup();
    importing.set(true);
    await fixture.whenStable();
    expect(button('settings-import').querySelector('tui-loader')).not.toBeNull();
  });
});
