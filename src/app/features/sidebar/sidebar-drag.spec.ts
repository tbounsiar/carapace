import { TestBed } from '@angular/core/testing';
import { SidebarDrag } from './sidebar-drag';

describe('SidebarDrag', () => {
  it('holds the dragged node until the drag ends', () => {
    const drag = TestBed.inject(SidebarDrag);
    drag.start('h1');
    expect(drag.nodeId()).toBe('h1');
    drag.end();
    expect(drag.nodeId()).toBeNull();
  });
});
