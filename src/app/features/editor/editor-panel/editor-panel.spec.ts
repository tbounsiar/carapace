import { Component, input, signal } from '@angular/core';
import { type ComponentFixture, TestBed } from '@angular/core/testing';
import { provideTaiga, TuiRoot } from '@taiga-ui/core';
import { LanguageService } from '../../../core/i18n/language';
import { ConfigService } from '../../../core/ipc/config';
import { fakeConfig, host } from '../../../core/ipc/config.fixture';
import type { EditorDoc } from '../editor-docs';
import type { EditorStats } from '../editor-factory';
import type { LanguageId } from '../language';
import { EditorPanel } from './editor-panel';

@Component({
  imports: [EditorPanel, TuiRoot],
  template: '<tui-root><app-editor-panel [doc]="doc()" /></tui-root>',
})
class Host {
  readonly doc = input.required<EditorDoc>();
}

function fakeDoc() {
  const element = document.createElement('div');
  element.setAttribute('data-testid', 'editor-content');
  const stats = signal<EditorStats>({
    line: 2,
    col: 9,
    selected: 0,
    bytes: 100,
    lines: 5,
    modified: false,
  });
  const doc = {
    hostId: 'h1',
    path: '/etc/nginx/nginx.conf',
    name: 'nginx.conf',
    phase: signal<'loading' | 'saving' | 'ready'>('ready'),
    readOnly: signal(false),
    language: signal<LanguageId>('nginx'),
    wrap: signal(false),
    savedAt: signal<Date | null>(null),
    error: signal<string | null>(null),
    partial: signal(false),
    target: signal<string | null>(null),
    stats,
    lineEnding: signal<'lf' | 'crlf'>('lf'),
    mixedEndings: signal(false),
    bom: signal(false),
    large: signal(false),
    banner: signal<'lost' | 'ended' | null>(null),
    reconnecting: signal(false),
    modified: () => stats().modified,
    attach: vi.fn((container: HTMLElement) => container.replaceChildren(element)),
    detach: vi.fn(() => element.remove()),
    focus: vi.fn(),
    save: vi.fn(() => Promise.resolve(true)),
    reload: vi.fn(() => Promise.resolve()),
    reconnect: vi.fn(() => Promise.resolve()),
    toggleWrap: vi.fn(),
    setLanguage: vi.fn((id: LanguageId) => doc.language.set(id)),
    relabel: vi.fn(),
  };
  return doc;
}

describe('EditorPanel', () => {
  let fixture: ComponentFixture<Host>;
  let doc: ReturnType<typeof fakeDoc>;
  const byId = (id: string): HTMLElement | null => document.querySelector(`[data-testid="${id}"]`);
  const settle = async (): Promise<void> => {
    await fixture.whenStable();
    await new Promise((r) => setTimeout(r, 20));
    await fixture.whenStable();
  };

  beforeEach(async () => {
    const config = fakeConfig();
    config.nodes.set([host('h1', 'vps')]);
    TestBed.configureTestingModule({
      imports: [Host],
      providers: [provideTaiga(), { provide: ConfigService, useValue: config }],
    });
    doc = fakeDoc();
    fixture = TestBed.createComponent(Host);
    fixture.componentRef.setInput('doc', doc as unknown as EditorDoc);
    await settle();
  });

  afterEach(() => fixture.destroy());

  it('attaches the editor and shows the status line', () => {
    expect(byId('editor')?.querySelector('[data-testid="editor-content"]')).toBeTruthy();
    expect(byId('editor-path')?.textContent).toContain('vps:/etc/nginx/nginx.conf');
    expect(byId('editor-position')?.textContent).toContain('Ln 2, Col 9');
    expect(byId('editor-size')?.textContent).toContain('100 B');
    expect(byId('editor-encoding')?.textContent).toContain('UTF-8');
    expect(byId('editor-eol')?.textContent).toContain('LF');
    expect(byId('editor-language')?.getAttribute('aria-label')).toBe('Language: nginx');
    expect(byId('editor-wrap')?.getAttribute('aria-pressed')).toBe('false');
  });

  it('enables Save only with changes and saves', async () => {
    expect(byId('editor-save')?.hasAttribute('disabled')).toBe(true);
    doc.stats.update((s) => ({ ...s, modified: true, selected: 4 }));
    await settle();
    expect(byId('editor-position')?.textContent).toContain('Ln 2, Col 9, 4 selected');
    expect(byId('editor-saved')?.textContent?.trim()).toBe('Modified');
    byId('editor-save')!.click();
    expect(doc.save).toHaveBeenCalled();
    byId('editor-reload')!.click();
    expect(doc.reload).toHaveBeenCalled();
  });

  it('counts CRLF and the BOM in the size', async () => {
    doc.lineEnding.set('crlf');
    doc.bom.set(true);
    await settle();
    expect(byId('editor-size')?.textContent).toContain('107 B');
    expect(byId('editor-eol')?.textContent).toContain('CRLF');
  });

  it('hides Save and shows the badge when read-only', async () => {
    doc.readOnly.set(true);
    await settle();
    expect(byId('editor-save')).toBeNull();
    expect(byId('editor-readonly')?.textContent).toContain('Read-only');
  });

  it('shows the lost and error banners with their actions', async () => {
    doc.banner.set('lost');
    doc.error.set('Not saved: Disk full.');
    doc.partial.set(true);
    const at = new Date(2026, 10, 4, 14, 2);
    doc.savedAt.set(at);
    doc.target.set('/srv/real.conf');
    await settle();
    expect(byId('editor-banner')?.textContent).toContain(
      'Connection lost. Your changes are kept; reconnect to save.',
    );
    expect(byId('editor-banner')?.getAttribute('data-appearance')).toBe('warning');
    byId('editor-reconnect')!.click();
    expect(doc.reconnect).toHaveBeenCalled();
    expect(byId('editor-error')?.getAttribute('role')).toBe('alert');
    byId('editor-save-again')!.click();
    expect(doc.save).toHaveBeenCalled();
    expect(byId('editor-saved')?.textContent).toContain(
      `Saved ${new Intl.DateTimeFormat('en-US', { timeStyle: 'short' }).format(at)}`,
    );
    expect(byId('editor-link')?.textContent).toContain('Link to /srv/real.conf');
    doc.banner.set('ended');
    await settle();
    expect(byId('editor-banner')?.textContent).toContain('Disconnected.');
  });

  it('picks a language from the status line menu', async () => {
    byId('editor-language')!.click();
    await settle();
    const yaml = byId('editor-language-yaml')!;
    expect(byId('editor-language-nginx')?.getAttribute('aria-checked')).toBe('true');
    expect(yaml.getAttribute('role')).toBe('menuitemradio');
    yaml.click();
    await settle();
    expect(doc.setLanguage).toHaveBeenCalledWith('yaml');
    expect(doc.focus).toHaveBeenCalled();
    expect(byId('editor-language')?.textContent).toContain('YAML');
  });

  it('says when highlighting is off for a large file', async () => {
    doc.large.set(true);
    doc.language.set('plain');
    await settle();
    expect(byId('editor-language')?.textContent).toContain('Plain text');
  });

  it('follows a switch to French, sizes and CodeMirror texts included', async () => {
    doc.stats.update((s) => ({ ...s, bytes: 1536, modified: true, selected: 4 }));
    TestBed.inject(LanguageService).apply('fr');
    await settle();
    expect(byId('editor-position')?.textContent).toContain('Ligne 2, col. 9, 4 sélectionnés');
    expect(byId('editor-size')?.textContent).toContain('1,5\u00a0Ko');
    expect(byId('editor-saved')?.textContent?.trim()).toBe('Modifié');
    expect(byId('editor-language')?.getAttribute('aria-label')).toBe('Langage\u00a0: nginx');
    expect(byId('editor-reload')?.getAttribute('aria-label')).toBe('Recharger depuis le serveur');
    expect(doc.relabel).toHaveBeenCalledTimes(2);
    TestBed.inject(LanguageService).apply('en');
  });
});
