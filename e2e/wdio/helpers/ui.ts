import { execFileSync } from 'node:child_process';
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

const APP_URL = 'http://tauri.localhost/';

/**
 * A WebDriver command sent while a new app is still starting can make the webview drop its first
 * navigation: it then stays on `about:blank` with an empty document for good (seen about once in
 * ten sessions, more often right after `reloadSession`). Loading the app page does what the app
 * itself would have done.
 */
async function ensureAppPage(): Promise<void> {
  const navigated = await browser
    .waitUntil(async () => (await browser.getUrl()) !== 'about:blank', { timeout: 10000 })
    .then(
      () => true,
      () => false,
    );
  if (navigated) return;
  console.log(`the webview stayed on about:blank; loading ${APP_URL}`);
  await browser.url(APP_URL);
}

/** The sidebar is ready once the config is loaded (the New menu is enabled). */
export async function waitForApp(): Promise<void> {
  await ensureAppPage();
  await $('tui-root').waitForExist({ timeout: 20000 });
  await byId('sidebar-tree').waitForExist({ timeout: 20000 });
  await byId('aside-new').waitForEnabled({ timeout: 20000 });
  await browser.waitUntil(async () => !(await $('app-sidebar-tree tui-loader').isExisting()), {
    timeout: 20000,
    timeoutMsg: 'sidebar did not render',
  });
}

/** Answers the first-launch consent dialog with "Don't share"; it must be the only one open. */
export async function declineConsent(): Promise<void> {
  await byId('consent-dialog').waitForDisplayed({ timeout: 20000 });
  expect(await $$(tid('consent-dialog')).length).toBe(1);
  await clickId('consent-decline');
  await waitGone('consent-dialog');
}

/**
 * Waits for a single credential prompt. A refused secret closes the prompt and opens a new one
 * with the error; the closed one stays in the DOM during its leave animation.
 */
export async function waitCredentialPrompt(timeout = 20000): Promise<void> {
  await browser.waitUntil(async () => (await $$(tid('credential-secret')).length) === 1, {
    timeout,
    timeoutMsg: 'not exactly one credential prompt',
  });
  await byId('credential-secret').waitForDisplayed({ timeout });
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

/** Fills the open host dialog without saving it. */
export async function fillHostFields(host: HostInput): Promise<void> {
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
}

export async function fillHost(host: HostInput, beforeSave?: () => Promise<void>): Promise<void> {
  await fillHostFields(host);
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
  // Already in the project scope, but on one of its host pages: go up to the dashboard.
  if (!(await byId('project-home').isExisting())) await clickId('crumb-project');
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

/** Starts a test from the host dialog footer. */
export async function testHost(): Promise<void> {
  await clickId('host-test');
  await browser.waitUntil(
    async () => (await byId('host-test-result').getAttribute('data-result')) !== null,
    { timeout: 10000, timeoutMsg: 'the test did not start' },
  );
}

export interface TestResult {
  result: string;
  code: string | null;
  title: string;
  detail: string;
}

/** Waits for the end of the running test and reads its result region. */
export async function testResult(timeout = 30000): Promise<TestResult> {
  const region = byId('host-test-result');
  await browser.waitUntil(
    async () => {
      const result = await region.getAttribute('data-result');
      return result !== null && result !== 'testing';
    },
    { timeout, timeoutMsg: 'the test never ended' },
  );
  const detail = byId('host-test-detail');
  return {
    result: (await region.getAttribute('data-result')) ?? '',
    code: await region.getAttribute('data-code'),
    title: await textOf('host-test-title'),
    detail: (await detail.isExisting()) ? await textOf('host-test-detail') : '',
  };
}

/** The test id of the selected workspace tab, or null when none is (off `/tabs/:id`). */
export async function activeTab(): Promise<string | null> {
  return browser.execute(
    () =>
      document
        .querySelector('[data-testid="workspace-tabs"] [role="tab"][aria-selected="true"]')
        ?.getAttribute('data-testid') ?? null,
  );
}

export async function waitActiveTab(id: string, timeout = 20000): Promise<void> {
  await browser.waitUntil(async () => (await activeTab()) === id, {
    timeout,
    timeoutMsg: `tab ${id} never became active`,
  });
}

/** Opens a tab's context menu (right click) and picks an option. */
export async function tabMenu(tab: string, option: string): Promise<void> {
  await byId(tab).click({ button: 'right' });
  await clickId(option);
}

/** Runs a shell script as the e2e user in the sshd container (no shell quoting on the host side). */
export function remoteSh(script: string): string {
  return execFileSync(
    'docker',
    ['exec', '-u', 'carapace', 'carapace-e2e-sshd', 'sh', '-c', script],
    {
      encoding: 'utf8',
    },
  );
}
