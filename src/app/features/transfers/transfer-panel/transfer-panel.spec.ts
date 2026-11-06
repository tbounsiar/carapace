import { LanguageService } from '../../../core/i18n/language';
import { Component, computed, signal } from '@angular/core';
import { type ComponentFixture, TestBed } from '@angular/core/testing';
import { provideTaiga, TuiRoot } from '@taiga-ui/core';
import type { TransferView } from '../../../core/ipc/transfers';
import { TransferQueue } from '../transfer-queue';
import { TransferPanel, type TransferReveal } from './transfer-panel';

function job(name: string, patch: Partial<TransferView> = {}): TransferView {
  return {
    id: name,
    connectionId: 'h1',
    direction: 'upload',
    source: `C:\\data\\${name}`,
    targetDir: '/srv',
    name,
    state: 'queued',
    totalBytes: null,
    doneBytes: 0,
    totalFiles: null,
    doneFiles: 0,
    skipped: 0,
    error: null,
    ...patch,
  };
}

@Component({
  imports: [TransferPanel, TuiRoot],
  template: `<tui-root>
    <app-transfer-panel
      connectionId="h1"
      [connected]="connected()"
      (reveal)="revealed.push($event)"
    />
  </tui-root>`,
})
class MenuHost {
  readonly connected = signal(true);
  readonly revealed: TransferReveal[] = [];
}

describe('TransferPanel', () => {
  const transfers = signal<TransferView[]>([]);
  const queue = {
    transfers,
    forConnection: (id: string) => transfers().filter((t) => t.connectionId === id),
    hasFinished: computed(() => false),
    cancel: vi.fn(() => Promise.resolve()),
    clearFinished: vi.fn(() => Promise.resolve()),
    enqueue: vi.fn(() => Promise.resolve()),
    writtenName: vi.fn((job: TransferView): string | null => job.name),
  };
  let fixture: ComponentFixture<TransferPanel>;

  const el = (): HTMLElement => fixture.nativeElement as HTMLElement;
  const byId = (id: string): HTMLElement | null => el().querySelector(`[data-testid="${id}"]`);
  const settle = async (): Promise<void> => {
    await fixture.whenStable();
    await new Promise((r) => setTimeout(r));
    await fixture.whenStable();
  };

  async function setup(jobs: TransferView[]): Promise<void> {
    transfers.set(jobs);
    fixture = TestBed.createComponent(TransferPanel);
    fixture.componentRef.setInput('connectionId', 'h1');
    await settle();
  }

  beforeEach(async () => {
    vi.clearAllMocks();
    await TestBed.configureTestingModule({
      imports: [TransferPanel],
      providers: [provideTaiga(), { provide: TransferQueue, useValue: queue }],
    }).compileComponents();
  });

  it('shows the jobs of its connection with counts, progress and state', async () => {
    await setup([
      job('big.iso', { state: 'running', totalBytes: 4096, doneBytes: 1024 }),
      job('tree', { state: 'running', direction: 'download', targetDir: 'C:\\in' }),
      job('later.txt'),
      job('other.txt', { connectionId: 'h2' }),
    ]);
    expect(el().getAttribute('data-testid')).toBe('transfer-panel');
    expect(byId('transfer-running')!.textContent).toContain('2 running');
    expect(byId('transfer-queued')!.textContent).toContain('1 queued');
    expect(byId('transfer-other.txt')).toBeNull();

    const big = byId('transfer-big.iso')!;
    const bar = big.querySelector('progress')!;
    expect(bar.max).toBe(4096);
    expect(bar.getAttribute('value')).not.toBeNull();
    expect(bar.value).toBe(1024);
    expect(byId('transfer-state-big.iso')!.textContent).toContain('1.0 KiB of 4.0 KiB');
    expect(big.querySelector('tui-icon')!.getAttribute('aria-label')).toBe('Upload');

    const tree = byId('transfer-tree')!;
    expect(tree.querySelector('progress')!.hasAttribute('value')).toBe(false);
    expect(tree.textContent).toContain('C:\\in');
    expect(tree.querySelector('tui-icon')!.getAttribute('aria-label')).toBe('Download');
    expect(byId('transfer-state-later.txt')!.textContent).toContain('Queued');
  });

  it('follows a switch to French, sizes included', async () => {
    await setup([
      job('big.iso', { state: 'running', totalBytes: 4096, doneBytes: 1536 }),
      job('a.txt', { state: 'done', skipped: 2 }),
      job('b.txt', {
        state: 'failed',
        error: {
          code: 'not_found',
          key: 'errors.files.notFound',
          params: { path: '/srv/b.txt' },
          message: '/srv/b.txt was not found',
        },
      }),
    ]);
    expect(byId('transfer-state-b.txt')!.textContent).toContain('Failed: /srv/b.txt was not found');
    TestBed.inject(LanguageService).apply('fr');
    await settle();
    expect(byId('transfer-state-big.iso')!.textContent).toContain('1,5\u00a0Ko sur 4,0\u00a0Ko');
    expect(byId('transfer-state-a.txt')!.textContent).toContain('Terminé · 2 ignorés');
    expect(byId('transfer-state-b.txt')!.textContent).toMatch(
      /Échec\s:\s\/srv\/b\.txt est introuvable/u,
    );
    expect(byId('transfer-done')!.textContent).toContain('1 terminé');
    expect(byId('transfer-toggle')!.textContent).toContain('Transferts');
    TestBed.inject(LanguageService).apply('en');
  });

  it('announces finished jobs through a status region', async () => {
    await setup([
      job('a.txt', { state: 'done' }),
      job('b.txt', { state: 'done' }),
      job('c.txt', { state: 'failed', error: { code: 'io', message: 'disk full' } }),
    ]);
    const status = el().querySelector('[role="status"]')!;
    expect(status.querySelector('[data-testid="transfer-done"]')!.textContent).toContain('2 done');
    expect(status.querySelector('[data-testid="transfer-failed"]')!.textContent).toContain(
      '1 failed',
    );
  });

  it('offers cancel only while a job is active', async () => {
    await setup([
      job('a', { state: 'queued' }),
      job('b', { state: 'running' }),
      job('c', { state: 'waitingConflict' }),
      job('d', { state: 'done', skipped: 2 }),
      job('e', { state: 'failed', error: { code: 'io', message: 'Disk full' } }),
      job('f', { state: 'cancelled' }),
    ]);
    for (const name of ['a', 'b', 'c']) {
      expect(byId(`transfer-cancel-${name}`)).toBeTruthy();
    }
    for (const name of ['d', 'e', 'f']) {
      expect(byId(`transfer-cancel-${name}`)).toBeNull();
    }
    expect(byId('transfer-running')!.textContent).toContain('1 running');
    expect(byId('transfer-waiting')!.textContent).toContain('1 waiting');
    expect(byId('transfer-state-c')!.classList).toContain('_waiting');
    const names = [...el().querySelectorAll('.row')].map((r) => r.getAttribute('data-testid'));
    expect(names[0]).toBe('transfer-f');
    expect(names.at(-1)).toBe('transfer-a');
    expect(byId('transfer-state-c')!.textContent).toContain('Waiting for a decision');
    expect(byId('transfer-state-d')!.textContent).toContain('Done · 2 skipped');
    expect(byId('transfer-state-e')!.textContent).toContain('Failed: Disk full');
    expect(byId('transfer-state-f')!.textContent).toContain('Cancelled');
    expect(byId('transfer-d')!.querySelector('progress')!.value).toBe(1);

    byId('transfer-cancel-b')!.click();
    expect(queue.cancel).toHaveBeenCalledWith('b');
  });

  it('clears finished jobs, disabled when there are none', async () => {
    await setup([job('a', { state: 'running' })]);
    const clear = byId('transfer-clear') as HTMLButtonElement;
    expect(clear.disabled).toBe(true);
    transfers.set([job('a', { state: 'done' })]);
    await settle();
    expect(clear.disabled).toBe(false);
    clear.click();
    expect(queue.clearFinished).toHaveBeenCalled();
  });

  it('starts collapsed when idle, expands for new jobs and toggles', async () => {
    await setup([job('old', { state: 'done' })]);
    const toggle = byId('transfer-toggle')!;
    expect(toggle.getAttribute('aria-expanded')).toBe('false');
    transfers.set([job('old', { state: 'done' }), job('new')]);
    await settle();
    expect(toggle.getAttribute('aria-expanded')).toBe('true');
    toggle.click();
    await settle();
    expect(toggle.getAttribute('aria-expanded')).toBe('false');
  });

  describe('row menu', () => {
    let hostFixture: ComponentFixture<MenuHost>;
    const root = (): HTMLElement => hostFixture.nativeElement as HTMLElement;
    const row = (name: string): HTMLElement =>
      root().querySelector<HTMLElement>(`[data-testid="transfer-${name}"]`)!;
    const menu = (): HTMLElement | null =>
      document.querySelector<HTMLElement>('[data-testid="context-menu"]');
    const entries = (): string[] =>
      Array.from(menu()?.querySelectorAll('[tuiOption]') ?? []).map((o) =>
        o.getAttribute('data-testid')!,
      );
    const option = (id: string): HTMLElement =>
      menu()!.querySelector<HTMLElement>(`[data-testid="${id}"]`)!;
    const settleHost = async (): Promise<void> => {
      for (let i = 0; i < 3; i++) {
        await hostFixture.whenStable();
        await new Promise((r) => setTimeout(r));
      }
    };
    const rightClick = async (target: Element): Promise<MouseEvent> => {
      const event = new MouseEvent('contextmenu', {
        bubbles: true,
        cancelable: true,
        clientX: 20,
        clientY: 20,
      });
      target.dispatchEvent(event);
      await settleHost();
      return event;
    };

    async function setupHost(jobs: TransferView[], connected = true): Promise<void> {
      transfers.set(jobs);
      hostFixture = TestBed.createComponent(MenuHost);
      hostFixture.componentInstance.connected.set(connected);
      await settleHost();
    }

    afterEach(async () => {
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
      await settleHost();
    });

    it('offers Cancel on an active job and runs it', async () => {
      await setupHost([job('big.iso', { state: 'running' }), job('old', { state: 'done' })]);
      const event = await rightClick(row('big.iso').querySelector('.name')!);
      expect(event.defaultPrevented).toBe(true);
      expect(menu()!.getAttribute('data-surface')).toBe('transfer');
      expect(menu()!.getAttribute('aria-label')).toBe('Transfer actions for big.iso');
      expect(entries()).toEqual([
        'transfer-menu-cancel',
        'transfer-menu-reveal',
        'transfer-menu-clear',
      ]);
      expect(row('big.iso').classList).toContain('_menu');
      option('transfer-menu-cancel').click();
      expect(queue.cancel).toHaveBeenCalledWith('big.iso');
    });

    it('retries a failed or cancelled job with the same request and policy ask', async () => {
      await setupHost([
        job('a.txt', { state: 'failed', error: { code: 'io', message: 'Disk full' } }),
      ]);
      await rightClick(row('a.txt'));
      expect(entries()).toEqual([
        'transfer-menu-retry',
        'transfer-menu-reveal',
        'transfer-menu-clear',
      ]);
      option('transfer-menu-retry').click();
      expect(queue.enqueue).toHaveBeenCalledWith(
        'h1',
        'upload',
        ['C:\\data\\a.txt'],
        '/srv',
        'ask',
      );
    });

    it('has no Retry for a done job', async () => {
      await setupHost([job('a.txt', { state: 'done' })]);
      await rightClick(row('a.txt'));
      expect(entries()).toEqual(['transfer-menu-reveal', 'transfer-menu-clear']);
    });

    it('shows the destination pane with the item selected', async () => {
      await setupHost([
        job('up.txt', { state: 'done' }),
        job('down.txt', { state: 'done', direction: 'download', targetDir: 'C:\\in' }),
      ]);
      await rightClick(row('up.txt'));
      expect(option('transfer-menu-reveal').textContent).toContain('Show in Remote pane');
      option('transfer-menu-reveal').click();
      await rightClick(row('down.txt'));
      expect(option('transfer-menu-reveal').textContent).toContain('Show in Local pane');
      option('transfer-menu-reveal').click();
      expect(hostFixture.componentInstance.revealed).toEqual([
        { side: 'remote', dir: '/srv', path: '/srv/up.txt' },
        { side: 'local', dir: 'C:\\in', path: 'C:\\in\\down.txt' },
      ]);
    });

    it('joins remote paths with a slash, even when the folder name has a backslash', async () => {
      await setupHost([
        job('up.txt', { state: 'done', targetDir: '/srv/a\\b' }),
        job('down.txt', { state: 'done', direction: 'download', targetDir: '/home/me' }),
      ]);
      await rightClick(row('up.txt'));
      option('transfer-menu-reveal').click();
      await rightClick(row('down.txt'));
      option('transfer-menu-reveal').click();
      expect(hostFixture.componentInstance.revealed).toEqual([
        { side: 'remote', dir: '/srv/a\\b', path: '/srv/a\\b/up.txt' },
        { side: 'local', dir: '/home/me', path: '/home/me/down.txt' },
      ]);
    });

    it('shows only the folder when the written name is not known', async () => {
      queue.writtenName.mockReturnValueOnce(null);
      await setupHost([job('up.txt', { state: 'done' })]);
      await rightClick(row('up.txt'));
      option('transfer-menu-reveal').click();
      expect(hostFixture.componentInstance.revealed).toEqual([
        { side: 'remote', dir: '/srv', path: null },
      ]);
    });

    it('needs the connection for Retry and the remote pane', async () => {
      await setupHost([job('a.txt', { state: 'cancelled' })], false);
      await rightClick(row('a.txt'));
      for (const id of ['transfer-menu-retry', 'transfer-menu-reveal']) {
        expect(option(id).getAttribute('aria-disabled')).toBe('true');
        expect(option(id).textContent).toContain('Connect to the remote first');
      }
      option('transfer-menu-retry').click();
      expect(queue.enqueue).not.toHaveBeenCalled();
    });

    it('clears finished jobs from the menu', async () => {
      await setupHost([job('a.txt', { state: 'done' })]);
      await rightClick(row('a.txt'));
      option('transfer-menu-clear').click();
      expect(queue.clearFinished).toHaveBeenCalled();
    });

    it('opens nothing off the rows', async () => {
      await setupHost([job('a.txt', { state: 'done' })]);
      const event = await rightClick(root().querySelector('[data-testid="transfer-toggle"]')!);
      expect(event.defaultPrevented).toBe(false);
      transfers.set([]);
      await settleHost();
      const empty = await rightClick(root().querySelector('.empty')!);
      expect(empty.defaultPrevented).toBe(true);
      expect(menu()).toBeNull();
    });

    it('opens the menu with Shift+F10 on the Cancel button', async () => {
      await setupHost([job('big.iso', { state: 'running' })]);
      root()
        .querySelector('[data-testid="transfer-cancel-big.iso"]')!
        .dispatchEvent(new KeyboardEvent('keydown', { key: 'F10', shiftKey: true, bubbles: true }));
      await settleHost();
      expect(entries()[0]).toBe('transfer-menu-cancel');
    });
  });

  it('starts expanded when a job is active and shows an empty state', async () => {
    await setup([job('a', { state: 'running' })]);
    expect(byId('transfer-toggle')!.getAttribute('aria-expanded')).toBe('true');
    transfers.set([]);
    await settle();
    expect(el().querySelector('.empty')).toBeTruthy();
    expect(byId('transfer-running')).toBeNull();
  });
});
