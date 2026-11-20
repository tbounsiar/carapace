import { signal } from '@angular/core';
import { type ComponentFixture, TestBed } from '@angular/core/testing';
import { provideTaiga } from '@taiga-ui/core';
import type { UpdateState } from '../../../core/ipc/updates';
import { type RestartImpact, UpdateFlow } from '../update-flow';
import { UpdateStore } from '../update-store';
import { UpdateNotice } from './update-notice';

const STATE: UpdateState = {
  current: '0.2.0',
  autoCheck: true,
  skippedVersion: null,
  lastCheck: null,
  available: null,
  downloaded: false,
  installKind: 'inPlace',
};

describe('UpdateNotice', () => {
  let fixture: ComponentFixture<UpdateNotice>;
  let store: UpdateStore;
  const impact = signal<RestartImpact>({ connections: 0, transfers: 0, dialog: false });
  const flow = {
    impact,
    windows: false,
    update: vi.fn(),
    later: vi.fn(),
    skip: vi.fn(),
    cancel: vi.fn(),
    restartNow: vi.fn(),
    openReleasePage: vi.fn(),
  };
  const el = () => fixture.nativeElement as HTMLElement;
  const q = (id: string) => el().querySelector<HTMLElement>(`[data-testid="${id}"]`);
  const text = (id: string) => q(id)?.textContent?.replace(/\s+/g, ' ').trim();

  async function render(windows = false): Promise<void> {
    flow.windows = windows;
    await TestBed.configureTestingModule({
      imports: [UpdateNotice],
      providers: [provideTaiga(), { provide: UpdateFlow, useValue: flow }],
    }).compileComponents();
    store = TestBed.inject(UpdateStore);
    store.state.set(STATE);
    store.offer.set({ version: '0.3.0', date: null });
    store.phase.set('available');
    fixture = TestBed.createComponent(UpdateNotice);
    document.body.appendChild(fixture.nativeElement);
    await fixture.whenStable();
  }

  beforeEach(() => {
    vi.clearAllMocks();
    impact.set({ connections: 0, transfers: 0, dialog: false });
  });

  afterEach(() => fixture?.nativeElement.remove());

  it('Available: version, release notes, Update, Later and Skip', async () => {
    await render();
    expect(el().dataset['state']).toBe('available');
    expect(el().dataset['mode']).toBe('inPlace');
    expect(text('update-notice-title')).toBe('Carapace 0.3.0 is available');
    expect(el().textContent).toContain('You have 0.2.0.');
    q('update-notice-notes')!.click();
    q('update-notice-install')!.click();
    // Flat action text is about 2.5:1 on the dark info background; grayscale reads at 8:1.
    expect(q('update-notice-later')!.getAttribute('data-appearance')).toBe('flat-grayscale');
    q('update-notice-later')!.click();
    // A minor action: subtitle type, not the title font of the notice heading.
    expect(q('update-notice-skip')!.parentElement!.hasAttribute('tuiSubtitle')).toBe(true);
    q('update-notice-skip')!.click();
    expect(flow.openReleasePage).toHaveBeenCalled();
    expect(flow.update).toHaveBeenCalled();
    expect(flow.later).toHaveBeenCalled();
    expect(flow.skip).toHaveBeenCalled();
    expect(q('update-notice-download')).toBeNull();
  });

  it('download-only: Download replaces Update, with the explanation', async () => {
    await render();
    store.state.set({ ...STATE, installKind: 'downloadOnly' });
    await fixture.whenStable();
    expect(el().dataset['mode']).toBe('downloadOnly');
    expect(q('update-notice-install')).toBeNull();
    expect(q('update-notice-download')).not.toBeNull();
    expect(el().textContent).toContain('This installation cannot update itself.');
  });

  it('Downloading: bar with value and sizes, Cancel; unknown total is indeterminate', async () => {
    await render();
    store.phase.set('downloading');
    store.progress.set({ downloaded: 512 * 1024, total: 2 * 1024 * 1024 });
    await fixture.whenStable();
    expect(text('update-notice-title')).toBe('Downloading Carapace 0.3.0');
    const bar = q('update-notice-progress') as HTMLProgressElement;
    expect(bar.getAttribute('aria-label')).toBe('Download progress');
    expect(bar.value).toBe(512 * 1024);
    expect(text('update-notice-progress-text')).toMatch(/ of /);
    expect(bar.getAttribute('aria-valuetext')).toBe(text('update-notice-progress-text'));
    q('update-notice-cancel')!.click();
    expect(flow.cancel).toHaveBeenCalled();
    store.progress.set({ downloaded: 1024, total: null });
    await fixture.whenStable();
    expect(q('update-notice-progress')!.hasAttribute('value')).toBe(false);
    expect(text('update-notice-progress-text')).toMatch(/downloaded$/);
  });

  it('Verifying: no buttons', async () => {
    await render();
    store.phase.set('verifying');
    await fixture.whenStable();
    expect(el().textContent).toContain('Checking the signature…');
    expect(el().querySelector('button')).toBeNull();
  });

  it('Ready: only the impact lines that apply, Restart now and Later', async () => {
    await render();
    impact.set({ connections: 2, transfers: 0, dialog: true });
    store.phase.set('ready');
    await fixture.whenStable();
    expect(text('update-notice-title')).toBe('Carapace 0.3.0 is ready to install');
    const lines = [...q('update-notice-impact')!.querySelectorAll('[data-impact]')].map((l) => [
      l.getAttribute('data-impact'),
      l.textContent?.trim(),
    ]);
    expect(lines).toEqual([
      ['connections', '2 open connections and their terminals will be closed.'],
      ['dialog', 'The open dialog will be closed without saving.'],
    ]);
    q('update-notice-restart')!.click();
    expect(flow.restartNow).toHaveBeenCalled();
  });

  it('Installing: the platform line, no buttons', async () => {
    await render(true);
    store.phase.set('installing');
    await fixture.whenStable();
    expect(text('update-notice-title')).toBe('Installing Carapace 0.3.0…');
    expect(el().textContent).toContain('Carapace closes while the installer runs');
    expect(el().querySelector('button')).toBeNull();
    fixture.destroy();
    fixture.nativeElement.remove();
    TestBed.resetTestingModule();
    await render(false);
    store.phase.set('installing');
    await fixture.whenStable();
    expect(el().textContent).toContain('Carapace restarts when the update is installed.');
  });

  it('moves the focus to the next state when the focused button disappears', async () => {
    await render();
    q('update-notice-install')!.focus();
    store.phase.set('downloading');
    await fixture.whenStable();
    expect(document.activeElement).toBe(q('update-notice-cancel'));
    store.phase.set('verifying');
    await fixture.whenStable();
    expect(document.activeElement).toBe(q('update-notice-title'));
  });

  it('never takes the focus on its own', async () => {
    await render();
    expect(el().contains(document.activeElement)).toBe(false);
  });
});
