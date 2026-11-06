import { suppressNativeContextMenu } from './native-context-menu';

describe('suppressNativeContextMenu', () => {
  let stop: () => void;

  beforeEach(() => {
    document.body.innerHTML = `
      <div id="page"><button id="button">Go</button></div>
      <input id="input" />
      <textarea id="area"></textarea>
      <div class="cm-editor"><div id="code" contenteditable="true">x</div></div>
      <div class="xterm"><canvas id="term"></canvas></div>
      <div id="custom"></div>`;
    stop = suppressNativeContextMenu(document);
  });

  afterEach(() => {
    stop();
    document.body.innerHTML = '';
  });

  const rightClick = (id: string): MouseEvent => {
    const event = new MouseEvent('contextmenu', { bubbles: true, cancelable: true });
    document.getElementById(id)!.dispatchEvent(event);
    return event;
  };

  it('hides the page menu outside editable text, the terminal included', () => {
    expect(rightClick('page').defaultPrevented).toBe(true);
    expect(rightClick('button').defaultPrevented).toBe(true);
    expect(rightClick('term').defaultPrevented).toBe(true);
  });

  it('keeps it in fields and the code editor', () => {
    for (const id of ['input', 'area', 'code']) {
      expect(rightClick(id).defaultPrevented).toBe(false);
    }
  });

  it('leaves app context menus alone', () => {
    const custom = document.getElementById('custom')!;
    const own = vi.fn((e: Event) => {
      e.preventDefault();
      e.stopPropagation();
    });
    custom.addEventListener('contextmenu', own);
    expect(rightClick('custom').defaultPrevented).toBe(true);
    expect(own).toHaveBeenCalledOnce();
  });

  it('stops when removed', () => {
    stop();
    expect(rightClick('page').defaultPrevented).toBe(false);
    stop = () => undefined;
  });
});
