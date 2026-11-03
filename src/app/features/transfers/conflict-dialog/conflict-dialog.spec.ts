import { Component } from '@angular/core';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { provideTaiga, TuiRoot } from '@taiga-ui/core';
import type { TransferConflict } from '../../../core/ipc/transfers';
import { ConflictPrompter } from '../conflict-prompter';

@Component({ imports: [TuiRoot], template: '<tui-root />' })
class Shell {}

const conflict: TransferConflict = {
  kind: 'conflict',
  jobId: 'j1',
  conflictId: 1,
  path: '/srv/report.pdf',
  existingSize: 2048,
  existingModified: 1_700_000_000,
  incomingSize: 4096,
  incomingModified: null,
};

describe('ConflictDialog', () => {
  let fixture: ComponentFixture<Shell>;
  let prompter: ConflictPrompter;

  const settle = async (): Promise<void> => {
    await fixture.whenStable();
    await new Promise((r) => setTimeout(r));
    await fixture.whenStable();
  };
  const byId = <T extends HTMLElement>(id: string): T =>
    document.body.querySelector<T>(`app-conflict-dialog [data-testid="${id}"]`)!;

  beforeEach(async () => {
    await TestBed.configureTestingModule({
      imports: [Shell],
      providers: [provideTaiga()],
    }).compileComponents();
    fixture = TestBed.createComponent(Shell);
    prompter = TestBed.inject(ConflictPrompter);
    await settle();
  });

  it('shows the name, destination and both sides', async () => {
    const result = prompter.ask('report.pdf', conflict);
    await settle();
    expect(byId('conflict-name').textContent).toContain('report.pdf');
    expect(byId('conflict-path').textContent).toContain('/srv/report.pdf');
    expect(byId('conflict-existing').textContent).toContain('2.0 KiB');
    expect(byId('conflict-incoming').textContent!.trim()).toBe('4.0 KiB');
    expect(byId('conflict-rename').textContent).toContain('Keep both');
    byId('conflict-skip').click();
    await settle();
    await result;
  });

  it.each([
    ['conflict-overwrite', 'overwrite'],
    ['conflict-skip', 'skip'],
    ['conflict-rename', 'rename'],
  ])('resolves %s as %s', async (id, decision) => {
    const result = prompter.ask('report.pdf', conflict);
    await settle();
    byId(id).click();
    await settle();
    expect(await result).toEqual({ decision, applyToAll: false });
  });

  it('applies to all when the checkbox is ticked', async () => {
    const result = prompter.ask('report.pdf', conflict);
    await settle();
    byId<HTMLInputElement>('conflict-all').click();
    await settle();
    byId('conflict-overwrite').click();
    await settle();
    expect(await result).toEqual({ decision: 'overwrite', applyToAll: true });
  });

  it('skips this file when dismissed with Escape', async () => {
    const result = prompter.ask('report.pdf', conflict);
    await settle();
    document.body
      .querySelector('app-conflict-dialog')!
      .dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    await settle();
    expect(await result).toEqual({ decision: 'skip', applyToAll: false });
  });
});
