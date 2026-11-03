import { Component, signal, viewChild } from '@angular/core';
import { type ComponentFixture, TestBed } from '@angular/core/testing';
import { provideTaiga, TuiNotificationService, TuiRoot } from '@taiga-ui/core';
import { of } from 'rxjs';
import { ConfigService } from '../../../core/ipc/config';
import type { VariableInput, VariableScope, VariableView } from '../../../core/ipc/config.models';
import { IpcError } from '../../../core/ipc/ipc-error';
import { VariablesEditor } from './variables-editor';

const VARS: VariableView[] = [
  { name: 'user', kind: 'plain', value: 'carapace', hasValue: true },
  { name: 'pw', kind: 'secret', value: null, hasValue: true },
];

@Component({
  imports: [VariablesEditor, TuiRoot],
  template:
    '<tui-root><app-variables-editor [scope]="scope()" [variables]="variables()" /></tui-root>',
})
class Host {
  readonly scope = signal<VariableScope>({ kind: 'project', projectId: 'p1' });
  readonly variables = signal<readonly VariableView[]>(VARS);
  readonly editor = viewChild.required(VariablesEditor);
}

describe('VariablesEditor', () => {
  const alerts = { open: vi.fn(() => of(undefined)) };
  const load = vi.fn(() => Promise.resolve());
  const setVariables = vi.fn((_scope: VariableScope, inputs: VariableInput[]) =>
    Promise.resolve(
      inputs.map<VariableView>((v) => ({
        name: v.name,
        kind: v.kind,
        value: v.kind === 'plain' ? (v.value ?? '') : null,
        hasValue: v.kind === 'plain' || !!v.secretValue || v.name === 'pw',
      })),
    ),
  );
  let fixture: ComponentFixture<Host>;

  const el = (): HTMLElement => fixture.nativeElement as HTMLElement;
  const byId = <T extends HTMLElement = HTMLElement>(id: string): T | null =>
    document.body.querySelector<T>(`[data-testid="${id}"]`);
  const input = (id: string): HTMLInputElement => byId<HTMLInputElement>(id)!;
  const settle = async (): Promise<void> => {
    await fixture.whenStable();
    await new Promise((r) => setTimeout(r));
    await fixture.whenStable();
  };
  const type = async (id: string, value: string): Promise<void> => {
    const field = input(id);
    field.value = value;
    field.dispatchEvent(new Event('input'));
    await settle();
  };
  const click = async (id: string): Promise<void> => {
    byId(id)!.click();
    await settle();
  };
  const save = (): Promise<void> => click('vars-save');
  const payload = (): VariableInput[] => setVariables.mock.calls.at(-1)![1];

  beforeEach(async () => {
    vi.clearAllMocks();
    await TestBed.configureTestingModule({
      imports: [Host],
      providers: [
        provideTaiga(),
        { provide: ConfigService, useValue: { setVariables, load } },
        { provide: TuiNotificationService, useValue: alerts },
      ],
    }).compileComponents();
    fixture = TestBed.createComponent(Host);
    await settle();
  });

  it('shows plain values and write-only secrets with their status', () => {
    expect(input('var-kind-0').value).toBe('Plain');
    expect(input('var-kind-1').value).toBe('Secret');
    expect(input('var-name-0').value).toBe('user');
    expect(input('var-value-0').value).toBe('carapace');
    expect(input('var-value-0').type).not.toBe('password');
    expect(input('var-name-1').value).toBe('pw');
    expect(input('var-value-1').type).toBe('password');
    expect(input('var-value-1').value).toBe('');
    expect(input('var-value-1').placeholder).toContain('Set');
    expect(byId('var-status-1')?.getAttribute('aria-label')).toBe('Set');
    expect(byId('vars-save')?.hasAttribute('disabled')).toBe(true);
  });

  it('shows "Not set" for a secret without a value', async () => {
    fixture.componentInstance.scope.set({ kind: 'global' });
    fixture.componentInstance.variables.set([
      { name: 'token', kind: 'secret', value: null, hasValue: false },
    ]);
    await settle();
    expect(byId('var-status-0')?.getAttribute('aria-label')).toBe('Not set');
    expect(input('var-value-0').placeholder).toBe('Not set');
  });

  it('sends the whole list, secrets without a value unless one was typed', async () => {
    await type('var-value-0', 'deploy');
    expect(fixture.componentInstance.editor().dirty()).toBe(true);
    await save();
    expect(setVariables).toHaveBeenCalledWith({ kind: 'project', projectId: 'p1' }, [
      { name: 'user', kind: 'plain', value: 'deploy' },
      { name: 'pw', kind: 'secret', secretValue: null },
    ]);
    expect(fixture.componentInstance.editor().dirty()).toBe(false);
  });

  it('sends a typed secret once, then clears the input', async () => {
    await type('var-value-1', 's3cr3t value ');
    await save();
    expect(payload()[1]).toEqual({ name: 'pw', kind: 'secret', secretValue: 's3cr3t value ' });
    expect(input('var-value-1').value).toBe('');
    expect(JSON.stringify(fixture.componentInstance.editor()['form'].getRawValue())).not.toContain(
      's3cr3t',
    );
  });

  it('adds and removes rows', async () => {
    await click('vars-add');
    expect(input('var-name-2').value).toBe('');
    expect(fixture.componentInstance.editor().dirty()).toBe(true);
    await type('var-name-2', 'port');
    await type('var-value-2', '2223');
    await click('var-remove-0');
    expect(input('var-name-0').value).toBe('pw');
    expect(byId('var-name-2')).toBeNull();
    await save();
    expect(payload()).toEqual([
      { name: 'pw', kind: 'secret', secretValue: null },
      { name: 'port', kind: 'plain', value: '2223' },
    ]);
  });

  it('switches a row between plain and secret and drops the typed value', async () => {
    await type('var-value-0', 'visible');
    await click('var-kind-0');
    await click('var-kind-option-secret');
    expect(input('var-kind-0').value).toBe('Secret');
    expect(input('var-value-0').type).toBe('password');
    expect(input('var-value-0').value).toBe('');
    expect(byId('var-status-0')?.getAttribute('aria-label')).toBe('Not set');
    await save();
    expect(payload()[0]).toEqual({ name: 'user', kind: 'secret', secretValue: null });
  });

  it('shows the chosen kind of a new row', async () => {
    fixture.componentInstance.variables.set([]);
    fixture.componentInstance.scope.set({ kind: 'global' });
    await settle();
    await click('vars-add');
    expect(input('var-kind-0').value).toBe('Plain');
    await click('var-kind-0');
    await click('var-kind-option-secret');
    expect(input('var-kind-0').value).toBe('Secret');
    expect(byId('var-status-0')?.getAttribute('aria-label')).toBe('Not set');
  });

  it('rejects invalid and duplicate names, case-insensitively', async () => {
    await type('var-name-0', '1abc');
    await save();
    expect(setVariables).not.toHaveBeenCalled();
    expect(el().textContent).toContain('starting with a letter');
    await type('var-name-0', 'PW');
    await save();
    expect(setVariables).not.toHaveBeenCalled();
    expect(el().textContent).toContain('already used');
    await type('var-name-1', 'password');
    await save();
    expect(setVariables).toHaveBeenCalledOnce();
  });

  it('requires a name on new rows', async () => {
    await click('vars-add');
    await save();
    expect(setVariables).not.toHaveBeenCalled();
    expect(el().textContent).toContain('Name is required');
  });

  it('warns that renaming a secret drops its stored value', async () => {
    expect(byId('vars-rename-warning')).toBeNull();
    await type('var-name-1', 'db_pw');
    expect(byId('vars-rename-warning')?.textContent).toContain('pw');
    expect(byId('var-status-1')?.getAttribute('aria-label')).toBe('Not set');
    await type('var-value-1', 'again');
    expect(byId('vars-rename-warning')).toBeNull();
  });

  it('discards the changes on cancel', async () => {
    await type('var-value-0', 'changed');
    await click('vars-add');
    await click('vars-cancel');
    expect(input('var-value-0').value).toBe('carapace');
    expect(byId('var-name-2')).toBeNull();
    expect(fixture.componentInstance.editor().dirty()).toBe(false);
  });

  it('reloads the rows when the scope changes', async () => {
    await type('var-value-0', 'changed');
    fixture.componentInstance.scope.set({
      kind: 'environment',
      projectId: 'p1',
      environmentId: 'e1',
    });
    fixture.componentInstance.variables.set([]);
    await settle();
    expect(byId('var-name-0')).toBeNull();
    expect(byId('vars-empty')).not.toBeNull();
    expect(fixture.componentInstance.editor().dirty()).toBe(false);
  });

  it('notifies a refused save, reloads what was stored and keeps the edits', async () => {
    setVariables.mockRejectedValueOnce(new IpcError('invalid_input', 'Variable pw is invalid'));
    await type('var-value-1', 'typed');
    await save();
    expect(alerts.open).toHaveBeenCalledWith(
      expect.stringContaining('Variable pw is invalid. '),
      expect.anything(),
    );
    expect(load).toHaveBeenCalledOnce();
    expect(input('var-value-1').value).toBe('typed');
    expect(fixture.componentInstance.editor().dirty()).toBe(true);
  });
});
