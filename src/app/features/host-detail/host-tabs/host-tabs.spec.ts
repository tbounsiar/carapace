import { signal } from '@angular/core';
import { type ComponentFixture, TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { provideTaiga } from '@taiga-ui/core';
import { host } from '../../../core/ipc/config.fixture';
import { HostLauncher } from '../../host-connection/host-launcher';
import { Workspace } from '../../workspace/workspace';
import { HostTabs } from './host-tabs';

describe('HostTabs', () => {
  let fixture: ComponentFixture<HostTabs>;
  const launcher = { newTerminal: vi.fn(), openFiles: vi.fn() };
  const vps = host('h1', 'vps');
  const byId = (id: string): HTMLElement | null =>
    (fixture.nativeElement as HTMLElement).querySelector(`[data-testid="${id}"]`);

  beforeEach(() => {
    vi.clearAllMocks();
    TestBed.configureTestingModule({
      imports: [HostTabs],
      providers: [provideTaiga(), provideRouter([]), { provide: HostLauncher, useValue: launcher }],
    });
  });

  async function setup(connected: boolean): Promise<void> {
    fixture = TestBed.createComponent(HostTabs);
    fixture.componentRef.setInput('host', vps);
    fixture.componentRef.setInput('connected', connected);
    await fixture.whenStable();
  }

  it('offers New terminal and Files when the host has no tab', async () => {
    await setup(false);
    expect(byId('host-tabs-empty')?.textContent).toContain(
      'Open a terminal or the files of this host. It connects first if needed.',
    );
    expect(byId('host-new-terminal')?.getAttribute('data-appearance')).toBe('secondary');
    byId('host-new-terminal')!.click();
    byId('host-open-files')!.click();
    expect(launcher.newTerminal).toHaveBeenCalledWith(vps);
    expect(launcher.openFiles).toHaveBeenCalledWith(vps);
  });

  it('lists the tabs in strip order with their state and activates one on click', async () => {
    const workspace = TestBed.inject(Workspace);
    const activate = vi.spyOn(workspace, 'activate').mockResolvedValue(true);
    workspace.add({
      key: 'terminal:h1:2',
      kind: 'terminal',
      hostId: 'h1',
      label: 'Terminal 2',
      status: signal({ kind: 'ended' as const, word: 'Session ended' }),
    });
    const edit = workspace.add({
      key: 'edit:h1:/a',
      kind: 'edit',
      hostId: 'h1',
      label: 'nginx.conf',
      path: '/a',
      status: signal({ kind: 'lost' as const, word: 'Connection lost' }),
      modified: signal(true),
      readOnly: signal(true),
    });
    await setup(true);
    expect(byId('host-tabs-empty')).toBeNull();
    expect(byId('host-new-terminal')?.getAttribute('data-appearance')).toBe('primary');
    expect(byId('host-tab-vps-terminal-2')?.textContent).toContain('Terminal 2');
    const link = byId('host-tab-vps-edit-nginx.conf')!;
    expect(link.getAttribute('aria-label')).toBe(
      'nginx.conf — Connection lost, modified, read-only',
    );
    expect(link.textContent).toContain('Modified');
    link.click();
    expect(activate).toHaveBeenCalledWith(edit);
  });
});
