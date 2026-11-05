import { LanguageService } from '../../../core/i18n/language';
import { computed, signal } from '@angular/core';
import { type ComponentFixture, TestBed } from '@angular/core/testing';
import { provideTaiga } from '@taiga-ui/core';
import type { TransferView } from '../../../core/ipc/transfers';
import { TransferQueue } from '../transfer-queue';
import { TransferPanel } from './transfer-panel';

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

describe('TransferPanel', () => {
  const transfers = signal<TransferView[]>([]);
  const queue = {
    transfers,
    forConnection: (id: string) => transfers().filter((t) => t.connectionId === id),
    hasFinished: computed(() => false),
    cancel: vi.fn(() => Promise.resolve()),
    clearFinished: vi.fn(() => Promise.resolve()),
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
    ]);
    TestBed.inject(LanguageService).apply('fr');
    await settle();
    expect(byId('transfer-state-big.iso')!.textContent).toContain('1,5\u00a0Ko sur 4,0\u00a0Ko');
    expect(byId('transfer-state-a.txt')!.textContent).toContain('Terminé · 2 ignorés');
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

  it('starts expanded when a job is active and shows an empty state', async () => {
    await setup([job('a', { state: 'running' })]);
    expect(byId('transfer-toggle')!.getAttribute('aria-expanded')).toBe('true');
    transfers.set([]);
    await settle();
    expect(el().querySelector('.empty')).toBeTruthy();
    expect(byId('transfer-running')).toBeNull();
  });
});
