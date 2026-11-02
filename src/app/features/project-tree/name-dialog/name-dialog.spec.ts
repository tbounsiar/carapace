import { TestBed } from '@angular/core/testing';
import { provideTaiga } from '@taiga-ui/core';
import { POLYMORPHEUS_CONTEXT } from '@taiga-ui/polymorpheus';
import { IpcError } from '../../../core/ipc/ipc-error';
import { NameDialog, type NameDialogData } from './name-dialog';

describe('NameDialog', () => {
  const completeWith = vi.fn();
  const save = vi.fn<NameDialogData['save']>();

  async function setup(initial = ''): Promise<{ el: HTMLElement; submit: () => Promise<void> }> {
    await TestBed.configureTestingModule({
      imports: [NameDialog],
      providers: [
        provideTaiga(),
        {
          provide: POLYMORPHEUS_CONTEXT,
          useValue: { data: { noun: 'project', initial, save }, completeWith, $implicit: {} },
        },
      ],
    }).compileComponents();
    const fixture = TestBed.createComponent(NameDialog);
    await fixture.whenStable();
    const el = fixture.nativeElement as HTMLElement;
    return {
      el,
      submit: async () => {
        el.querySelector<HTMLButtonElement>('button[type="submit"]')!.click();
        await fixture.whenStable();
      },
    };
  }

  const type = (el: HTMLElement, value: string): void => {
    const input = el.querySelector('input')!;
    input.value = value;
    input.dispatchEvent(new Event('input'));
  };

  beforeEach(() => {
    vi.clearAllMocks();
    save.mockResolvedValue(undefined);
  });

  it('prefills the initial name', async () => {
    const { el } = await setup('prod');
    expect(el.querySelector('input')!.value).toBe('prod');
  });

  it('rejects an empty name', async () => {
    const { el, submit } = await setup();
    await submit();
    expect(save).not.toHaveBeenCalled();
    expect(el.textContent).toContain('Name is required');
  });

  it('rejects a name longer than 100 characters', async () => {
    const { el, submit } = await setup();
    type(el, 'a'.repeat(101));
    await submit();
    expect(save).not.toHaveBeenCalled();
  });

  it('saves the trimmed name and closes', async () => {
    const { el, submit } = await setup();
    type(el, '  prod ');
    await submit();
    expect(save).toHaveBeenCalledWith('prod');
    expect(completeWith).toHaveBeenCalledOnce();
  });

  it('shows a conflict on the name field and stays open', async () => {
    save.mockRejectedValue(new IpcError('conflict', 'duplicate'));
    const { el, submit } = await setup();
    type(el, 'prod');
    await submit();
    expect(completeWith).not.toHaveBeenCalled();
    expect(el.textContent).toContain('A project with this name already exists');
  });
});
