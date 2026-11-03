import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import type { FormGroup } from '@angular/forms';
import { provideTaiga } from '@taiga-ui/core';
import { POLYMORPHEUS_CONTEXT } from '@taiga-ui/polymorpheus';
import { ConfigService } from '../../../core/ipc/config';
import type { Collection, Host, Project } from '../../../core/ipc/config.models';
import { deployTargetLabel, KeyDeployDialog, type KeyDeployDialogData } from './key-deploy-dialog';

const host = (id: string, name: string, projectId: string | null): Host => ({
  kind: 'host',
  id,
  name,
  projectId,
  parentId: null,
  hostname: 'h',
  port: '22',
  username: 'u',
  auth: { kind: 'agent' },
});

const SHOP: Project = { id: 'p1', name: 'Shop', variables: [] };
const LAB: Project = { ...SHOP, id: 'p2', name: 'Lab' };
const BACKEND: Collection = {
  kind: 'collection',
  id: 'c1',
  name: 'Backend',
  projectId: 'p1',
  parentId: null,
};
const EMPTY: Project = { ...SHOP, id: 'p3', name: 'Empty' };
const UI: Host = { ...host('h1', 'UI', 'p1'), parentId: 'c1' };
const BOX = host('h2', 'box', 'p2');
const VPS = host('h3', 'vps', null);

interface DialogApi {
  form: FormGroup;
  groups(): { label: string; hosts: Host[] }[];
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
        {
          provide: ConfigService,
          useValue: {
            projects: signal([SHOP, LAB, EMPTY]),
            hosts: signal([UI, BOX, VPS]),
            nodes: signal([BACKEND, UI, BOX, VPS]),
          },
        },
      ],
    }).compileComponents();
    const fixture = TestBed.createComponent(KeyDeployDialog);
    await fixture.whenStable();
    const el = fixture.nativeElement as HTMLElement;
    return { el, dialog: fixture.componentInstance as unknown as DialogApi };
  }

  beforeEach(() => vi.clearAllMocks());

  it('labels a target with its path inside its scope', () => {
    const nodes = [BACKEND, UI, BOX, VPS];
    expect(deployTargetLabel(nodes, UI)).toBe('Backend / UI');
    expect(deployTargetLabel(nodes, BOX)).toBe('box');
    expect(deployTargetLabel(nodes, VPS)).toBe('vps');
  });

  it('groups hosts by scope, Home first, skipping empty projects', async () => {
    const { el, dialog } = await setup();
    expect(dialog.groups().map((g) => g.label)).toEqual(['Home', 'Lab', 'Shop']);
    expect(dialog.groups()[0].hosts.map((h) => h.name)).toEqual(['vps']);
    expect(dialog.stringify('h3')).toBe('vps');
    expect(dialog.stringify('h1')).toBe('Backend / UI');
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
