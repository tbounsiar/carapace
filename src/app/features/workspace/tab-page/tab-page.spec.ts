import { Component, input, signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { provideRouter, Router, withComponentInputBinding } from '@angular/router';
import { RouterTestingHarness } from '@angular/router/testing';
import { provideTaiga } from '@taiga-ui/core';
import { ConfigService } from '../../../core/ipc/config';
import { fakeConfig, host } from '../../../core/ipc/config.fixture';
import { FilesPanel } from '../../files/files-panel/files-panel';
import { Workspace } from '../workspace';
import { TabPage } from './tab-page';

@Component({ template: '' })
class Blank {}

@Component({
  selector: 'app-files-panel',
  template: '<button data-testid="pane-connect">Connect</button>',
})
class FakeFiles {
  readonly target = input<unknown>();
}

describe('TabPage', () => {
  beforeEach(() => {
    const config = fakeConfig();
    config.nodes.set([host('h1', 'vps')]);
    TestBed.configureTestingModule({
      providers: [
        provideTaiga(),
        provideRouter(
          [
            { path: 'tabs/:tabId', component: TabPage },
            { path: '**', component: Blank },
          ],
          withComponentInputBinding(),
        ),
        { provide: ConfigService, useValue: config },
      ],
    });
    TestBed.overrideComponent(TabPage, {
      remove: { imports: [FilesPanel] },
      add: { imports: [FakeFiles] },
    });
  });

  it('shows the active tab as a tab panel and focuses its content', async () => {
    const harness = await RouterTestingHarness.create();
    const workspace = TestBed.inject(Workspace);
    const tab = workspace.add({
      key: 'files:h1',
      kind: 'files',
      hostId: 'h1',
      label: 'Files',
      status: signal({ kind: 'ended' as const, word: 'Disconnected' }),
    });
    await workspace.activate(tab);
    await harness.fixture.whenStable();
    await new Promise((r) => setTimeout(r));
    const panel = document.querySelector<HTMLElement>('[data-testid="tab-panel"]')!;
    expect(panel.getAttribute('role')).toBe('tabpanel');
    expect(panel.id).toBe('workspace-tab-panel');
    expect(panel.getAttribute('aria-labelledby')).toBe(`workspace-tab-${tab.id}`);
    expect(document.activeElement?.getAttribute('data-testid')).toBe('pane-connect');
  });

  it('goes home for a tab that no longer exists', async () => {
    const harness = await RouterTestingHarness.create();
    await harness.navigateByUrl('/tabs/t404');
    await harness.fixture.whenStable();
    expect(TestBed.inject(Router).url).toBe('/');
  });
});
