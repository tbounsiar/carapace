import { TestBed } from '@angular/core/testing';
import { TuiNotificationService } from '@taiga-ui/core';
import { of } from 'rxjs';
import { IpcError } from '../../core/ipc/ipc-error';
import { TerminalIpc, type TerminalEvent } from '../../core/ipc/terminal';
import { FakeXtermFactory } from './fake-xterm';
import { TerminalSessions } from './terminal-sessions';
import { XtermFactory } from './xterm-factory';

interface OpenCall {
  connectionId: string;
  cols: number;
  rows: number;
  emit: (event: TerminalEvent) => void;
}

describe('TerminalSessions', () => {
  let sessions: TerminalSessions;
  let factory: FakeXtermFactory;
  let opens: OpenCall[];
  let nextId: number;
  let openResult: () => Promise<string>;
  const alerts = { open: vi.fn(() => of(undefined)) };
  const ipc = {
    open: vi.fn(
      (connectionId: string, cols: number, rows: number, emit: (event: TerminalEvent) => void) => {
        opens.push({ connectionId, cols, rows, emit });
        return openResult();
      },
    ),
    write: vi.fn(() => Promise.resolve()),
    resize: vi.fn(() => Promise.resolve()),
    close: vi.fn(() => Promise.resolve()),
  };
  const flush = (): Promise<void> => new Promise((r) => setTimeout(r));

  beforeEach(() => {
    vi.clearAllMocks();
    opens = [];
    nextId = 1;
    openResult = () => Promise.resolve(`t${nextId++}`);
    factory = new FakeXtermFactory();
    TestBed.configureTestingModule({
      providers: [
        { provide: TerminalIpc, useValue: ipc },
        { provide: XtermFactory, useValue: factory },
        { provide: TuiNotificationService, useValue: alerts },
      ],
    });
    sessions = TestBed.inject(TerminalSessions);
  });

  it('opens a terminal on the connection and makes it active', async () => {
    const tab = await sessions.open('h1@e1');
    expect(tab?.n).toBe(1);
    expect(tab?.state()).toBe('open');
    expect(opens[0]).toMatchObject({ connectionId: 'h1@e1', cols: 80, rows: 24 });
    expect(sessions.tabs('h1@e1')).toEqual([tab]);
    expect(sessions.active('h1@e1')).toBe(tab);
  });

  it('numbers tabs per connection, keeps two environments of a host apart, never reuses a number', async () => {
    const a1 = await sessions.open('h1@e1');
    const a2 = await sessions.open('h1@e1');
    const b1 = await sessions.open('h1@none');
    await sessions.close(a2!);
    const a3 = await sessions.open('h1@e1');
    expect([a1?.n, a2?.n, b1?.n, a3?.n]).toEqual([1, 2, 1, 3]);
    expect(sessions.tabs('h1@e1').map((t) => t.n)).toEqual([1, 3]);
    expect(sessions.tabs('h1@none').map((t) => t.n)).toEqual([1]);
  });

  it('writes output bytes to xterm and sends input to the backend in order', async () => {
    await sessions.open('h1@e1');
    const view = factory.created[0];
    const bytes = new Uint8Array([104, 105]);
    opens[0].emit({ kind: 'data', bytes });
    expect(view.written).toEqual([bytes]);
    view.type('l');
    view.type('s');
    await flush();
    expect(ipc.write.mock.calls).toEqual([
      ['t1', 'l'],
      ['t1', 's'],
    ]);
  });

  it('sends a resize when xterm changes size', async () => {
    await sessions.open('h1@e1');
    factory.created[0].resize(120, 40);
    await flush();
    expect(ipc.resize).toHaveBeenCalledWith('t1', 120, 40);
  });

  it('shows the ended state on closed and keeps the tab and its scrollback', async () => {
    const tab = await sessions.open('h1@e1');
    opens[0].emit({ kind: 'closed', reason: 'connectionLost' });
    expect(tab?.state()).toBe('ended');
    expect(tab?.reason()).toBe('connectionLost');
    expect(sessions.tabs('h1@e1')).toEqual([tab]);
    expect(factory.created[0].disposed).toBe(false);
    factory.created[0].type('x');
    await flush();
    expect(ipc.write).not.toHaveBeenCalled();
  });

  it('reopens an ended tab in the same xterm with a new backend terminal', async () => {
    const tab = await sessions.open('h1@e1');
    opens[0].emit({ kind: 'closed', reason: 'closed' });
    await sessions.reopen(tab!);
    expect(tab?.state()).toBe('open');
    expect(tab?.reason()).toBeNull();
    expect(factory.created).toHaveLength(1);
    opens[0].emit({ kind: 'data', bytes: new Uint8Array([1]) });
    expect(factory.created[0].written).toEqual(['\r\n']);
    factory.created[0].type('a');
    await flush();
    expect(ipc.write).toHaveBeenCalledWith('t2', 'a');
  });

  it('closes the backend terminal and disposes xterm', async () => {
    const tab = await sessions.open('h1@e1');
    await sessions.close(tab!);
    expect(ipc.close).toHaveBeenCalledWith('t1');
    expect(factory.created[0].disposed).toBe(true);
    expect(sessions.tabs('h1@e1')).toEqual([]);
    expect(sessions.active('h1@e1')).toBeNull();
  });

  it('does not call close_terminal for an ended tab', async () => {
    const tab = await sessions.open('h1@e1');
    opens[0].emit({ kind: 'closed', reason: 'exited' });
    await sessions.close(tab!);
    expect(ipc.close).not.toHaveBeenCalled();
  });

  it('activates the neighbour when the active tab closes', async () => {
    const t1 = await sessions.open('h1@e1');
    const t2 = await sessions.open('h1@e1');
    const t3 = await sessions.open('h1@e1');
    sessions.select(t2!);
    await sessions.close(t2!);
    expect(sessions.active('h1@e1')).toBe(t3);
    await sessions.close(t3!);
    expect(sessions.active('h1@e1')).toBe(t1);
  });

  it('removes the tab and notifies when the open fails', async () => {
    openResult = () => Promise.reject(new IpcError('not_connected', 'Host is not connected'));
    const tab = await sessions.open('h1@e1');
    expect(tab).toBeNull();
    expect(sessions.tabs('h1@e1')).toEqual([]);
    expect(alerts.open).toHaveBeenCalledWith(
      expect.stringContaining('Host is not connected. '),
      expect.anything(),
    );
  });

  it('closes a backend terminal whose tab was closed while opening', async () => {
    let resolve!: (id: string) => void;
    openResult = () => new Promise((r) => (resolve = r));
    const opening = sessions.open('h1@e1');
    await flush();
    await sessions.close(sessions.tabs('h1@e1')[0]);
    resolve('t9');
    expect(await opening).toBeNull();
    expect(ipc.close).toHaveBeenCalledWith('t9');
  });

  it('keeps the tab when the shell ends before the open resolves', async () => {
    openResult = () => {
      opens[0].emit({ kind: 'closed', reason: 'exited' });
      return Promise.resolve('t1');
    };
    const tab = await sessions.open('h1@e1');
    expect(tab?.state()).toBe('ended');
    expect(sessions.tabs('h1@e1')).toHaveLength(1);
  });

  it('notifies when a write fails but keeps the terminal', async () => {
    const tab = await sessions.open('h1@e1');
    ipc.write.mockRejectedValueOnce(new IpcError('busy', 'Terminal input queue is full'));
    factory.created[0].type('x');
    await flush();
    expect(alerts.open).toHaveBeenCalledWith(
      expect.stringContaining('Terminal input queue is full. '),
      expect.anything(),
    );
    expect(tab?.state()).toBe('open');
  });

  it('survives detaching: attach re-uses the same xterm element', async () => {
    const tab = await sessions.open('h1@e1');
    const first = document.createElement('div');
    sessions.attach(tab!, first);
    const element = first.firstElementChild;
    expect(factory.created[0].parent).toBe(element);
    sessions.detach(tab!);
    expect(first.children).toHaveLength(0);
    const second = document.createElement('div');
    sessions.attach(tab!, second);
    expect(second.firstElementChild).toBe(element);
    expect(factory.created).toHaveLength(1);
  });

  it('applies the theme and font size to existing and new terminals, and refits', async () => {
    await sessions.open('h1@e1');
    expect(factory.created[0].fontSize).toBe(13);
    const fits = factory.created[0].fits;
    const source = document.createElement('div');
    source.style.setProperty('--tui-background-base', '#123456');
    document.body.append(source);
    sessions.applyAppearance(source, 'dark', 18);
    expect(factory.created[0].theme?.background).toBe('#123456');
    expect(factory.created[0].fontSize).toBe(18);
    expect(factory.created[0].fits).toBe(fits + 1);
    await sessions.open('h1@e1');
    expect(factory.created[1].theme?.background).toBe('#123456');
    expect(factory.created[1].theme?.red).toBeTruthy();
    expect(factory.created[1].fontSize).toBe(18);
    source.remove();
  });

  it('notifies and opens no tab when xterm fails to load', async () => {
    vi.spyOn(factory, 'create').mockRejectedValueOnce(new Error('chunk'));
    expect(await sessions.open('h1@e1')).toBeNull();
    expect(sessions.tabs('h1@e1')).toEqual([]);
    expect(alerts.open).toHaveBeenCalledWith(
      expect.stringContaining('could not be loaded'),
      expect.objectContaining({ label: 'Terminal not opened' }),
    );
    expect((await sessions.open('h1@e1'))?.n).toBe(1);
  });
});
