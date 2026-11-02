import { TestBed } from '@angular/core/testing';
import { HostViews } from './host-view';

describe('HostViews', () => {
  it('defaults to the terminal and remembers the view per host', () => {
    const views = TestBed.inject(HostViews);
    expect(views.of('h1')).toBe('terminal');
    views.set('h1', 'files');
    expect(views.of('h1')).toBe('files');
    expect(views.of('h2')).toBe('terminal');
  });
});
