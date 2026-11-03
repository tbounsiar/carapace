import { TestBed } from '@angular/core/testing';
import { FileDrag } from './file-drag';

describe('FileDrag', () => {
  it('holds the dragged files until the drag ends', () => {
    const drag = TestBed.inject(FileDrag);
    expect(drag.current()).toBeNull();
    drag.start({ side: 'local', paths: ['C:\\a'] });
    expect(drag.current()).toEqual({ side: 'local', paths: ['C:\\a'] });
    drag.end();
    expect(drag.current()).toBeNull();
  });
});
