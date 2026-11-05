import { signal } from '@angular/core';
import { type ComponentFixture, TestBed } from '@angular/core/testing';
import type { FormGroup } from '@angular/forms';
import { TranslocoService } from '@jsverse/transloco';
import { provideTaiga, TuiNotificationService } from '@taiga-ui/core';
import { POLYMORPHEUS_CONTEXT } from '@taiga-ui/polymorpheus';
import { of } from 'rxjs';
import { ConfigService } from '../../../core/ipc/config';
import { fakeConfig, host, project } from '../../../core/ipc/config.fixture';
import { type DataScope, DataTransferIpc } from '../../../core/ipc/data-transfer';
import { IpcError } from '../../../core/ipc/ipc-error';
import { KeyStore } from '../../../core/ipc/key-store';
import type { VariableView } from '../../../core/ipc/config.models';
import { ExportDialog, type ExportDialogData } from './export-dialog';

const RESULT = {
  fileName: 'carapace-all-2026-11-05.json',
  counts: { projects: 2, collections: 0, hosts: 3, variables: 1, secretVariables: 0, keys: 1 },
};

describe('ExportDialog', () => {
  let fixture: ComponentFixture<ExportDialog>;
  let config: ReturnType<typeof fakeConfig>;
  let busy: ReturnType<typeof signal<boolean>>;
  const completeWith = vi.fn();
  const complete = vi.fn();
  const exportData = vi.fn();
  const alerts = { open: vi.fn(() => of(undefined)) };
  const byId = <T extends HTMLElement = HTMLElement>(id: string): T | null =>
    (fixture.nativeElement as HTMLElement).querySelector<T>(`[data-testid="${id}"]`);
  const settle = async () => {
    await fixture.whenStable();
    await new Promise((r) => setTimeout(r));
    await fixture.whenStable();
  };
  const form = () => (fixture.componentInstance as unknown as { form: FormGroup }).form;
  const radio = (id: string) => byId(id)!.querySelector('input') as HTMLInputElement;

  async function setup(preset: DataScope = { kind: 'all' }): Promise<void> {
    busy = signal(false);
    const data: ExportDialogData = { preset, busy };
    await TestBed.configureTestingModule({
      imports: [ExportDialog],
      providers: [
        provideTaiga(),
        {
          provide: POLYMORPHEUS_CONTEXT,
          useValue: { data, completeWith, $implicit: { complete } },
        },
        { provide: ConfigService, useValue: config },
        {
          provide: KeyStore,
          useValue: { keys: signal([{ id: 'k1' }]), ensureLoaded: () => Promise.resolve() },
        },
        { provide: DataTransferIpc, useValue: { exportData } },
        { provide: TuiNotificationService, useValue: alerts },
      ],
    }).compileComponents();
    fixture = TestBed.createComponent(ExportDialog);
    await settle();
  }

  beforeEach(() => {
    vi.clearAllMocks();
    config = fakeConfig();
    config.projects.set([
      project('p2', 'Shop'),
      project('p1', 'Payments', {
        variables: [{ name: 'db', kind: 'plain', value: 'x' } as unknown as VariableView],
      }),
    ]);
    config.nodes.set([host('h1', 'vps'), host('h2', 'api', 'p1'), host('h3', 'web', 'p1')]);
    config.variables.set([
      { name: 'user', kind: 'plain', value: 'deploy' } as unknown as VariableView,
    ]);
  });

  it('starts on Everything with live counts and the secrets note', async () => {
    await setup();
    expect(radio('export-scope-all').checked).toBe(true);
    expect(byId('export-scope-all')!.textContent).toContain(
      '2 projects, 3 hosts, 2 variables, 1 SSH key',
    );
    expect(byId('export-scope-home')!.textContent).toContain(
      '1 host, 1 global variable, 1 SSH key',
    );
    expect(byId('export-secrets-note')!.textContent).toContain('Not included');
    expect(byId('export-project-select')).toBeNull();
  });

  it('follows a switch to French', async () => {
    await setup();
    TestBed.inject(TranslocoService).setActiveLang('fr');
    await settle();
    expect(byId('export-scope-all')!.textContent).toContain(
      '2 projets, 3 hôtes, 2 variables, 1 clé SSH',
    );
    expect(byId('export-scope-home')!.textContent).toContain('1 variable globale');
    expect(byId('export-secrets-note')!.textContent).toContain('Non inclus');
    expect(byId('export-submit')!.textContent?.trim()).toBe('Exporter…');
  });

  it('exports everything and completes with the result', async () => {
    exportData.mockResolvedValue(RESULT);
    await setup();
    byId('export-submit')!.click();
    await settle();
    expect(exportData).toHaveBeenCalledWith({ kind: 'all' }, false);
    expect(completeWith).toHaveBeenCalledWith(RESULT);
    expect(busy()).toBe(false);
  });

  it('exports Home', async () => {
    exportData.mockResolvedValue(RESULT);
    await setup({ kind: 'home' });
    expect(radio('export-scope-home').checked).toBe(true);
    byId('export-submit')!.click();
    await settle();
    expect(exportData).toHaveBeenCalledWith({ kind: 'home' }, false);
  });

  it('exports a preset project with the shared variables option', async () => {
    exportData.mockResolvedValue(RESULT);
    await setup({ kind: 'project', projectId: 'p1' });
    expect(radio('export-scope-project').checked).toBe(true);
    expect(byId('export-project-select')).not.toBeNull();
    const shared = byId<HTMLInputElement>('export-include-shared')!;
    expect(shared.checked).toBe(true);
    shared.click();
    await settle();
    byId('export-submit')!.click();
    await settle();
    expect(exportData).toHaveBeenCalledWith({ kind: 'project', projectId: 'p1' }, false);
  });

  it('preselects the first project by name when switching to the project scope', async () => {
    exportData.mockResolvedValue(RESULT);
    await setup();
    radio('export-scope-project').click();
    await settle();
    expect(form().controls['projectId'].value).toBe('p1');
    expect(byId<HTMLButtonElement>('export-submit')!.disabled).toBe(false);
    byId<HTMLButtonElement>('export-submit')!.click();
    await settle();
    expect(exportData).toHaveBeenCalledWith({ kind: 'project', projectId: 'p1' }, true);
  });

  it('keeps a chosen project when switching back to the project scope', async () => {
    await setup();
    radio('export-scope-project').click();
    await settle();
    form().controls['projectId'].setValue('p2');
    radio('export-scope-all').click();
    radio('export-scope-project').click();
    await settle();
    expect(form().controls['projectId'].value).toBe('p2');
  });

  it('needs a project for the project scope', async () => {
    await setup();
    form().controls['scope'].setValue('project');
    await settle();
    expect(byId<HTMLButtonElement>('export-submit')!.disabled).toBe(true);
    form().controls['projectId'].setValue('p2');
    await settle();
    expect(byId<HTMLButtonElement>('export-submit')!.disabled).toBe(false);
  });

  it('disables the project scope without projects', async () => {
    config.projects.set([]);
    await setup({ kind: 'project', projectId: 'gone' });
    expect(radio('export-scope-project').disabled).toBe(true);
    expect(byId('export-scope-project')!.textContent).toContain('No projects yet');
    expect(radio('export-scope-all').checked).toBe(true);
  });

  it('stays open when the save dialog is cancelled', async () => {
    exportData.mockResolvedValue(null);
    await setup();
    byId('export-submit')!.click();
    await settle();
    expect(completeWith).not.toHaveBeenCalled();
    expect(byId('export-error')).toBeNull();
    expect(form().enabled).toBe(true);
  });

  it('shows a write error and enables the form again', async () => {
    exportData.mockRejectedValue(new IpcError('permission_denied', 'cannot write the file'));
    await setup();
    byId('export-submit')!.click();
    await settle();
    expect(byId('export-error')!.textContent).toContain('File not saved');
    expect(byId('export-error')!.textContent).toContain('Cannot write the file.');
    expect(form().enabled).toBe(true);
    expect(busy()).toBe(false);
  });

  it('toasts when another picker is open', async () => {
    exportData.mockRejectedValue(new IpcError('busy', 'picker open'));
    await setup();
    byId('export-submit')!.click();
    await settle();
    expect(alerts.open).toHaveBeenCalledWith(
      'Another file dialog is open. Close it first.',
      expect.objectContaining({ appearance: 'warning' }),
    );
    expect(byId('export-error')).toBeNull();
  });

  it('keeps Cancel inert while writing', async () => {
    let finish: (value: unknown) => void = () => undefined;
    exportData.mockReturnValue(new Promise((r) => (finish = r)));
    await setup();
    byId('export-submit')!.click();
    await settle();
    expect(busy()).toBe(true);
    expect(byId<HTMLButtonElement>('dialog-cancel')!.disabled).toBe(true);
    finish(null);
    await settle();
    byId('dialog-cancel')!.click();
    expect(complete).toHaveBeenCalled();
  });
});
