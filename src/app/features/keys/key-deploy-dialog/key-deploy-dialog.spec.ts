import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import type { FormGroup } from '@angular/forms';
import { provideTaiga } from '@taiga-ui/core';
import { POLYMORPHEUS_CONTEXT } from '@taiga-ui/polymorpheus';
import { ConfigService } from '../../../core/ipc/config';
import type { Host, Project } from '../../../core/ipc/config.models';
import { deployTargetLabel, KeyDeployDialog, type KeyDeployDialogData } from './key-deploy-dialog';

const host = (id: string, name: string): Host => ({
  id,
  name,
  hostname: 'h',
  port: '22',
  username: 'u',
  auth: { kind: 'agent' },
});

const SHOP: Project = {
  id: 'p1',
  name: 'Shop',
  variables: [],
  environments: [{ id: 'e1', name: 'Dev', variables: [] }],
  hosts: [host('h1', 'UI')],
  activeEnvironmentId: 'e1',
};
const LAB: Project = {
  ...SHOP,
  id: 'p2',
  name: 'Lab',
  hosts: [host('h2', 'box')],
  activeEnvironmentId: null,
};
const EMPTY: Project = { ...SHOP, id: 'p3', name: 'Empty', hosts: [] };

interface DialogApi {
  form: FormGroup;
  projects(): Project[];
  stringify(id: string | null): string;
  submit(): Promise<void>;
}

describe('KeyDeployDialog', () => {
  const completeWith = vi.fn();
  const deploy = vi.fn<KeyDeployDialogData['deploy']>();

  async function setup() {
    const data: KeyDeployDialogData = { key: { name: 'main', path: '/keys/main' }, deploy };
    await TestBed.configureTestingModule({
      imports: [KeyDeployDialog],
      providers: [
        provideTaiga(),
        {
          provide: POLYMORPHEUS_CONTEXT,
          useValue: { data, completeWith, $implicit: { complete: vi.fn() } },
        },
        { provide: ConfigService, useValue: { projects: signal([SHOP, LAB, EMPTY]) } },
      ],
    }).compileComponents();
    const fixture = TestBed.createComponent(KeyDeployDialog);
    await fixture.whenStable();
    const el = fixture.nativeElement as HTMLElement;
    return { el, dialog: fixture.componentInstance as unknown as DialogApi };
  }

  beforeEach(() => vi.clearAllMocks());

  it('labels a target with its active environment', () => {
    expect(deployTargetLabel(SHOP, SHOP.hosts[0])).toBe('UI · Dev');
    expect(deployTargetLabel(LAB, LAB.hosts[0])).toBe('box');
  });

  it('lists projects with hosts and shows the chosen target', async () => {
    const { el, dialog } = await setup();
    expect(dialog.projects().map((p) => p.name)).toEqual(['Shop', 'Lab']);
    expect(dialog.stringify('h1')).toBe('UI · Dev');
    expect(dialog.stringify(null)).toBe('');
    expect(el.querySelector<HTMLInputElement>('[data-testid="deploy-use"]')!.checked).toBe(false);
  });

  it('requires a host', async () => {
    const { dialog } = await setup();
    await dialog.submit();
    expect(deploy).not.toHaveBeenCalled();
  });

  it('deploys and closes on success', async () => {
    const { dialog } = await setup();
    deploy.mockResolvedValue(true);
    dialog.form.setValue({ hostId: 'h1', useKey: true });
    await dialog.submit();
    expect(deploy).toHaveBeenCalledWith('h1', true);
    expect(completeWith).toHaveBeenCalledOnce();
  });

  it('stays open when the deploy did not happen', async () => {
    const { dialog } = await setup();
    deploy.mockResolvedValue(false);
    dialog.form.setValue({ hostId: 'h2', useKey: false });
    await dialog.submit();
    expect(deploy).toHaveBeenCalledWith('h2', false);
    expect(completeWith).not.toHaveBeenCalled();
  });
});
