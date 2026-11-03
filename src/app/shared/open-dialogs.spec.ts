import { Component } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { provideTaiga, TuiDialogService, TuiRoot } from '@taiga-ui/core';
import { OpenDialogs, provideOpenDialogs } from './open-dialogs';

@Component({ imports: [TuiRoot], template: '<tui-root />' })
class Shell {}

describe('OpenDialogs', () => {
  it('counts the dialogs opened through TuiDialogService', async () => {
    await TestBed.configureTestingModule({
      imports: [Shell],
      providers: [provideTaiga(), provideOpenDialogs()],
    }).compileComponents();
    const fixture = TestBed.createComponent(Shell);
    await fixture.whenStable();
    const tracker = TestBed.inject(OpenDialogs);
    const dialogs = TestBed.inject(TuiDialogService);
    expect(dialogs).toBe(tracker);
    expect(tracker.none()).toBe(true);

    const first = dialogs.open('One').subscribe();
    const second = dialogs.open('Two').subscribe();
    await fixture.whenStable();
    expect(tracker.none()).toBe(false);

    first.unsubscribe();
    expect(tracker.none()).toBe(false);
    second.unsubscribe();
    expect(tracker.none()).toBe(true);
  });
});
