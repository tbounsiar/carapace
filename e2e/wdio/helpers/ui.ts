import { HOST } from './fixture';

export const tid = (id: string) => `[data-testid="${id}"]`;

export function byId(id: string): ChainablePromiseElement {
  return $(tid(id));
}

export async function clickId(id: string): Promise<void> {
  const el = byId(id);
  await el.waitForClickable({ timeout: 10000 });
  await el.click();
}

export async function waitGone(id: string): Promise<void> {
  await byId(id).waitForExist({ timeout: 10000, reverse: true });
}

export async function typeInto(id: string, value: string): Promise<void> {
  const el = byId(id);
  await el.waitForDisplayed({ timeout: 10000 });
  await el.click();
  await browser.keys(['Control', 'a']);
  await browser.keys('Delete');
  await browser.keys(value.split(''));
}

export async function waitForApp(): Promise<void> {
  await $('tui-root').waitForExist({ timeout: 20000 });
  await $('app-project-tree').waitForExist({ timeout: 20000 });
  await browser.waitUntil(
    async () => (await $(tid('new-project')).isExisting()) || (await $('tui-tree').isExisting()),
    { timeout: 20000, timeoutMsg: 'sidebar did not render' },
  );
}

export async function rowAction(row: string, button: string): Promise<void> {
  await byId(row).moveTo();
  await clickId(button);
}

export async function openMenu(kind: string, name: string, option: string): Promise<void> {
  await rowAction(`tree-${kind}-${name}`, `menu-${kind}-${name}`);
  await clickId(option);
}

async function fillName(value: string): Promise<void> {
  await typeInto('name-input', value);
  await clickId('dialog-save');
  await waitGone('name-input');
}

export async function createProject(name: string): Promise<void> {
  await clickId('new-project');
  await fillName(name);
  await byId(`tree-project-${name}`).waitForExist({ timeout: 10000 });
}

export async function createEnv(project: string, name: string): Promise<void> {
  await rowAction(`tree-project-${project}`, `add-project-${project}`);
  await fillName(name);
  await byId(`tree-env-${name}`).waitForExist({ timeout: 10000 });
}

export interface HostInput {
  name: string;
  hostname: string;
  port: string;
  username: string;
  keyPath?: string;
  auth?: 'password' | 'key';
}

export async function createHost(env: string, host: HostInput = HOST): Promise<void> {
  await rowAction(`tree-env-${env}`, `add-env-${env}`);
  await typeInto('host-name', host.name);
  await typeInto('host-hostname', host.hostname);
  await typeInto('host-port', host.port);
  await typeInto('host-username', host.username);
  if (host.auth === 'password') {
    await byId('host-auth').$('label=Password').click();
  } else {
    await byId('host-auth').$('label=Private key file').click();
    await typeInto('host-key-path', host.keyPath ?? '');
  }
  await clickId('dialog-save');
  await waitGone('host-name');
  await byId(`tree-host-${host.name}`).waitForExist({ timeout: 10000 });
}

export async function hostStatus(name: string): Promise<string> {
  return (await byId(`status-host-${name}`).getAttribute('aria-label')) ?? '';
}

export async function waitStatus(name: string, label: string): Promise<void> {
  await browser.waitUntil(async () => (await hostStatus(name).catch(() => '')) === label, {
    timeout: 20000,
    timeoutMsg: `host ${name} never reached status "${label}"`,
  });
}

export async function connect(name: string): Promise<void> {
  await rowAction(`tree-host-${name}`, `connect-host-${name}`);
}

export async function disconnect(name: string): Promise<void> {
  await rowAction(`tree-host-${name}`, `disconnect-host-${name}`);
  await byId(`connect-host-${name}`).waitForExist({ timeout: 10000 });
}

export async function confirmDelete(): Promise<void> {
  const button = $('//tui-dialog//button[normalize-space()="Delete"]');
  await button.waitForClickable({ timeout: 10000 });
  await button.click();
  await button.waitForExist({ timeout: 10000, reverse: true });
}

export async function deleteNode(kind: string, name: string): Promise<void> {
  await openMenu(kind, name, 'menu-delete');
  await confirmDelete();
  await waitGone(`tree-${kind}-${name}`);
}
