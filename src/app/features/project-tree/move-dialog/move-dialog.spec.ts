import { TestBed } from '@angular/core/testing';
import { provideTaiga } from '@taiga-ui/core';
import { POLYMORPHEUS_CONTEXT } from '@taiga-ui/polymorpheus';
import { ConfigService } from '../../../core/ipc/config';
import { collection, fakeConfig, host, project } from '../../../core/ipc/config.fixture';
import { MoveDialog, type MoveDialogData } from './move-dialog';

describe('MoveDialog', () => {
  const completeWith = vi.fn();
  const move = vi.fn<MoveDialogData['move']>();

  async function setup() {
    const config = fakeConfig();
    config.projects.set([project('p1', 'Payments')]);
    const api = { ...host('h1', 'api', 'p1', 'c1'), hostname: '${db_host}' };
    config.nodes.set([collection('c1', 'Backend', 'p1'), collection('c3', 'Lab', null), api]);
    await TestBed.configureTestingModule({
      imports: [MoveDialog],
      providers: [
        provideTaiga(),
        { provide: ConfigService, useValue: config },
        {
          provide: POLYMORPHEUS_CONTEXT,
          useValue: { data: { node: api, move }, completeWith, $implicit: { complete: vi.fn() } },
        },
      ],
    }).compileComponents();
    const fixture = TestBed.createComponent(MoveDialog);
    await fixture.whenStable();
    const el = fixture.nativeElement as HTMLElement;
    const byId = (id: string) => el.querySelector<HTMLElement>(`[data-testid="${id}"]`);
    return { fixture, el, byId };
  }

  beforeEach(() => vi.clearAllMocks());

  it('lists every location by path, the current one disabled', async () => {
    const { byId } = await setup();
    expect(byId('move-target-Home')).not.toBeNull();
    expect(byId('move-target-Home/Lab')).not.toBeNull();
    const current = byId('move-target-Payments/Backend') as HTMLButtonElement;
    expect(current.disabled).toBe(true);
    expect(current.textContent).toContain('(current location)');
    expect((byId('move-submit') as HTMLButtonElement).disabled).toBe(true);
  });

  it('filters locations and says when nothing matches', async () => {
    const { fixture, el, byId } = await setup();
    const search = byId('move-search') as HTMLInputElement;
    search.value = 'lab';
    search.dispatchEvent(new Event('input'));
    await fixture.whenStable();
    expect(byId('move-target-Home/Lab')).not.toBeNull();
    expect(byId('move-target-Home')).toBeNull();
    search.value = 'xyz';
    search.dispatchEvent(new Event('input'));
    await fixture.whenStable();
    expect(el.textContent).toContain('No location matches “xyz”.');
  });

  it('warns about a cross-scope target and moves on submit', async () => {
    const { fixture, el, byId } = await setup();
    move.mockResolvedValue(null);
    byId('move-target-Home/Lab')!.click();
    await fixture.whenStable();
    expect(byId('move-target-Home/Lab')?.getAttribute('aria-checked')).toBe('true');
    const warning = byId('move-warning')!.textContent;
    expect(warning).toContain('Moving out of the project');
    expect(warning).toContain('Not defined in Home: db_host.');
    el.querySelector('form')!.dispatchEvent(new Event('submit'));
    await fixture.whenStable();
    expect(move).toHaveBeenCalledWith({ projectId: null, parentId: 'c3' });
    expect(completeWith).toHaveBeenCalledOnce();
  });

  it('shows a refused move under the list and stays open', async () => {
    const { fixture, el, byId } = await setup();
    move.mockResolvedValue('A host named "api" already exists in Home. Rename one of them first.');
    byId('move-target-Home')!.click();
    await fixture.whenStable();
    el.querySelector('form')!.dispatchEvent(new Event('submit'));
    await fixture.whenStable();
    await new Promise((r) => setTimeout(r));
    await fixture.whenStable();
    expect(byId('move-error')?.textContent).toContain('already exists in Home');
    expect(completeWith).not.toHaveBeenCalled();
  });
});
