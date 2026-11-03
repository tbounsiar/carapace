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

export async function textOf(id: string): Promise<string> {
  return ((await byId(id).getText()) ?? '').trim();
}

/** The sidebar is ready once the config is loaded (the New menu is enabled). */
export async function waitForApp(): Promise<void> {
  await $('tui-root').waitForExist({ timeout: 20000 });
  await byId('sidebar-tree').waitForExist({ timeout: 20000 });
  await byId('aside-new').waitForEnabled({ timeout: 20000 });
  await browser.waitUntil(async () => !(await $('app-sidebar-tree tui-loader').isExisting()), {
    timeout: 20000,
    timeoutMsg: 'sidebar did not render',
  });
}

export async function rowAction(row: string, button: string): Promise<void> {
  await byId(row).moveTo();
  await clickId(button);
}

/** Opens a sidebar item menu (`kind`: host, collection, project) and picks an option. */
export async function openMenu(kind: string, name: string, option: string): Promise<void> {
  await rowAction(`tree-${kind}-${name}`, `menu-${kind}-${name}`);
  await clickId(option);
}

export async function fillName(value: string): Promise<void> {
  await typeInto('name-input', value);
  await clickId('dialog-save');
  await waitGone('name-input');
}

export async function currentScope(): Promise<string> {
  return textOf('project-select');
}

/** A closing dropdown stays in the DOM during its animation; wait so ids stay unique. */
async function selectorClosed(): Promise<void> {
  await waitGone('project-option-new');
}

async function pickScope(option: string, label: string): Promise<void> {
  if ((await currentScope()) === label) return;
  await selectorClosed();
  await clickId('project-select');
  await clickId(option);
  await browser.waitUntil(async () => (await currentScope()) === label, {
    timeout: 10000,
    timeoutMsg: `the project selector never showed ${label}`,
  });
}

export async function goHome(): Promise<void> {
  await pickScope('project-option-home', 'Home');
}

export async function enterProject(name: string): Promise<void> {
  await pickScope(`project-option-${name}`, name);
}

/** Creates a project from the header selector; the app then enters it. */
export async function createProject(name: string): Promise<void> {
  await selectorClosed();
  await clickId('project-select');
  await clickId('project-option-new');
  await fillName(name);
  await browser.waitUntil(async () => (await currentScope()) === name, {
    timeout: 10000,
    timeoutMsg: `did not enter the new project ${name}`,
  });
}

export async function newFromAside(option: 'new-host' | 'new-collection' | 'new-project') {
  await waitGone('new-collection');
  await clickId('aside-new');
  await clickId(option);
}

export interface HostInput {
  name: string;
  hostname: string;
  port: string;
  username: string;
  keyPath?: string;
  auth?: 'password' | 'key';
}

export async function fillHost(host: HostInput, beforeSave?: () => Promise<void>): Promise<void> {
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
  await beforeSave?.();
  await clickId('dialog-save');
  await waitGone('host-name');
  await byId(`tree-host-${host.name}`).waitForExist({ timeout: 10000 });
}

/** Creates a host at the root of a project (`null`: Home); the app then opens its page. */
export async function createHost(
  project: string | null,
  host: HostInput = HOST,
  beforeSave?: () => Promise<void>,
): Promise<void> {
  if (project === null) await goHome();
  else await enterProject(project);
  await newFromAside('new-host');
  await fillHost(host, beforeSave);
}

export interface VariableRow {
  name: string;
  value: string;
}

/** The project dashboard's Variables tab. */
export async function openProjectVariables(project: string): Promise<void> {
  await enterProject(project);
  await clickId('project-tab-variables');
  await byId('vars-add').waitForDisplayed({ timeout: 10000 });
}

export async function openGlobalVariables(): Promise<void> {
  await clickId('global-variables');
  await byId('vars-title').waitForDisplayed({ timeout: 10000 });
}

export async function addPlainVariables(rows: VariableRow[]): Promise<void> {
  for (const row of rows) {
    const index = (await $$('[data-testid^="var-name-"]').length) as number;
    await clickId('vars-add');
    await byId(`var-name-${index}`).waitForDisplayed({ timeout: 10000 });
    await typeInto(`var-name-${index}`, row.name);
    await typeInto(`var-value-${index}`, row.value);
  }
}

export async function saveVariables(): Promise<void> {
  await clickId('vars-save');
  await byId('vars-cancel').waitForEnabled({ timeout: 10000, reverse: true });
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

export function dialogButton(text: string): ChainablePromiseElement {
  return $(`//tui-dialog//button[normalize-space()="${text}"]`);
}

export async function confirmDialog(text: string): Promise<void> {
  const button = dialogButton(text);
  await button.waitForClickable({ timeout: 10000 });
  await button.click();
  await button.waitForExist({ timeout: 10000, reverse: true });
}

export async function confirmDelete(): Promise<void> {
  await confirmDialog('Delete');
}

/** Deletes a sidebar item; projects are listed at Home only. */
export async function deleteNode(kind: string, name: string): Promise<void> {
  if (kind === 'project') await goHome();
  await openMenu(kind, name, 'menu-delete');
  await confirmDelete();
  await waitGone(`tree-${kind}-${name}`);
}
