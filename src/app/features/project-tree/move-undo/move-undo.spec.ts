import { TestBed } from '@angular/core/testing';
import { provideTaiga } from '@taiga-ui/core';
import { POLYMORPHEUS_CONTEXT } from '@taiga-ui/polymorpheus';
import { MoveUndo } from './move-undo';

describe('MoveUndo', () => {
  it('shows the move and undoes it, closing the toast', async () => {
    const undo = vi.fn();
    const complete = vi.fn();
    await TestBed.configureTestingModule({
      imports: [MoveUndo],
      providers: [
        provideTaiga(),
        {
          provide: POLYMORPHEUS_CONTEXT,
          useValue: { data: { text: 'Moved “ui” to Backend', undo }, $implicit: { complete } },
        },
      ],
    }).compileComponents();
    const fixture = TestBed.createComponent(MoveUndo);
    await fixture.whenStable();
    const el = fixture.nativeElement as HTMLElement;
    expect(el.textContent).toContain('Moved “ui” to Backend');
    el.querySelector<HTMLButtonElement>('[data-testid="move-undo"]')!.click();
    expect(undo).toHaveBeenCalledOnce();
    expect(complete).toHaveBeenCalledOnce();
  });
});
