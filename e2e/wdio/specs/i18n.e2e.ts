import { readSettings } from '../helpers/app-files';
import { restartApp } from '../helpers/app-process';
import { screenshotThemes, shotWithMenu } from '../helpers/screenshot';
import {
  byId,
  clickId,
  connect,
  createProject,
  dialogButton,
  newFromAside,
  openMenu,
  textOf,
  typeInto,
  waitForApp,
  waitGone,
  waitLanguage,
} from '../helpers/ui';

const shot = async (name: string) => console.log('screenshots', await screenshotThemes(name));

const PROJECT = 'Lab';
const HOST_NAME = 'web';

const pageLanguage = () => browser.execute(() => document.documentElement.lang);
const bodyText = () => browser.execute(() => document.body.innerText);
const dialogText = async () => ((await $('tui-dialog').getText()) ?? '').trim();

/** French copy uses no-break spaces before `?`, `:` and inside « »; compare them as spaces. */
const spaced = (text: string) => text.replace(/\s+/g, ' ');

async function waitText(read: () => Promise<string>, expected: string, what: string) {
  await browser.waitUntil(async () => spaced(await read()).includes(spaced(expected)), {
    timeout: 10000,
    timeoutMsg: `${what} never showed "${expected}"`,
  });
}

async function waitSavedLanguage(language: string): Promise<void> {
  await browser.waitUntil(async () => readSettings()?.['language'] === language, {
    timeout: 5000,
    timeoutMsg: `settings.toml never held language = ${language}: ${JSON.stringify(readSettings())}`,
  });
}

async function openSettings(): Promise<void> {
  await clickId('settings');
  await byId('settings-title').waitForDisplayed({ timeout: 10000 });
}

async function waitDialog(expected: string): Promise<void> {
  await $('tui-dialog').waitForDisplayed({ timeout: 10000 });
  await waitText(dialogText, expected, 'the dialog');
}

async function cancelDialog(): Promise<void> {
  const cancel = dialogButton('Annuler');
  await cancel.waitForClickable({ timeout: 10000 });
  await cancel.click();
  await $('tui-dialog').waitForExist({ timeout: 10000, reverse: true });
}

describe('Interface language', () => {
  before(waitForApp);

  after(async () => {
    // Other spec files run after this one in the same webview profile.
    if ((await pageLanguage()) !== 'en') {
      await openSettings();
      await clickId('settings-language-en');
      await waitLanguage('en');
    }
  });

  it('switches to French from Settings without a reload', async () => {
    await openSettings();
    // Empty texts here mean the translations failed to render (a CSP-blocked transpiler did that).
    expect(await textOf('settings-title')).toBe('Settings');
    expect(await textOf('settings')).toBe('Settings');
    await waitText(() => textOf('settings-language'), 'Language', 'the language group');
    expect(await pageLanguage()).toBe('en');
    await browser.execute(() => {
      (window as unknown as { e2eNoReload?: boolean }).e2eNoReload = true;
    });

    await clickId('settings-language-fr');
    await browser.waitUntil(async () => (await textOf('settings-title')) === 'Paramètres', {
      timeout: 2000,
      timeoutMsg: 'the settings title did not change right away',
    });
    expect(await pageLanguage()).toBe('fr');
    expect(
      await browser.execute(() => (window as unknown as { e2eNoReload?: boolean }).e2eNoReload),
    ).toBe(true);
    await waitSavedLanguage('fr');
    expect(await textOf('settings')).toBe('Paramètres');
    expect(await textOf('ssh-keys')).toBe('Clés SSH');
    await waitText(() => textOf('settings-language'), 'Langue', 'the language group');
    await shot('i18n-01-settings');
  });

  it('shows the shell and Home in French', async () => {
    await clickId('home-link');
    await browser.waitUntil(async () => (await textOf('project-select')) === 'Accueil', {
      timeout: 10000,
      timeoutMsg: 'the project selector never showed Accueil',
    });
    expect(await textOf('global-variables')).toBe('Variables globales');
    await waitText(bodyText, 'Rien ici pour l’instant', 'the empty Home');
    await shot('i18n-02-home');
    await shotWithMenu('i18n-03-project-selector', 'project-select', 'project-option-new');
  });

  it('shows the host dialog with a French validation error', async () => {
    await createProject(PROJECT);
    await newFromAside('new-host');
    await waitDialog('Nouvel hôte');
    await typeInto('host-name', HOST_NAME);
    await typeInto('host-hostname', '${host}');
    await typeInto('host-port', '99999');
    await byId('host-username').click();
    await waitText(dialogText, 'Le port doit être compris entre 1 et 65535', 'the host dialog');
    await shot('i18n-04-host-dialog-error');

    await typeInto('host-port', '22');
    await typeInto('host-username', 'deploy');
    await byId('host-auth').$('label=Agent SSH').click();
    expect(await dialogButton('Enregistrer').isExisting()).toBe(true);
    await clickId('dialog-save');
    await waitGone('host-name');
    await byId(`tree-host-${HOST_NAME}`).waitForExist({ timeout: 10000 });
  });

  it('shows the host page and a backend error in French', async () => {
    await byId('host-detail').waitForDisplayed({ timeout: 10000 });
    await waitText(() => textOf('host-detail-address'), 'Variables manquantes', 'the address');
    expect(await textOf('host-detail-status')).toContain('Non connecté');
    await shot('i18n-05-host-page');

    await connect(HOST_NAME);
    await waitText(
      bodyText,
      'Définissez-les dans les variables globales ou du projet.',
      'the connection error',
    );
    await shot('i18n-06-connect-error');
  });

  it('asks for a delete confirmation in French', async () => {
    await openMenu('host', HOST_NAME, 'menu-delete');
    await waitDialog('Supprimer l’hôte ?');
    await waitText(dialogText, `« ${HOST_NAME} »`, 'the delete confirmation');
    expect(await dialogButton('Supprimer').isExisting()).toBe(true);
    await shot('i18n-07-delete-confirm');
    await cancelDialog();
    await expect(byId(`tree-host-${HOST_NAME}`)).toExist();
  });

  it('shows the keys page and the keygen dialog in French', async () => {
    await clickId('ssh-keys');
    await byId('keys-title').waitForDisplayed({ timeout: 10000 });
    expect(await textOf('keys-title')).toBe('Clés SSH');
    await waitText(() => textOf('keys-empty'), 'Aucune clé SSH pour l’instant', 'the keys page');
    await shot('i18n-08-keys');

    await clickId('keys-generate');
    await byId('keygen-name').waitForDisplayed({ timeout: 10000 });
    await waitDialog('Confirmer la phrase secrète');
    await shot('i18n-09-keygen');
    await cancelDialog();
  });

  it('shows the export dialog in French', async () => {
    await openSettings();
    await clickId('settings-export');
    await byId('export-dialog').waitForDisplayed({ timeout: 10000 });
    await waitDialog('Exporter les données');
    await shot('i18n-10-export');
    await clickId('dialog-cancel');
    await waitGone('export-dialog');
  });

  it('keeps French after a restart', async () => {
    await restartApp();
    await waitForApp();
    expect(await pageLanguage()).toBe('fr');
    expect(await textOf('settings')).toBe('Paramètres');
    await openSettings();
    expect(await textOf('settings-title')).toBe('Paramètres');
    await shot('i18n-11-after-restart');
  });

  it('switches back to English', async () => {
    await clickId('settings-language-en');
    await browser.waitUntil(async () => (await textOf('settings-title')) === 'Settings', {
      timeout: 2000,
      timeoutMsg: 'the settings title did not change back right away',
    });
    expect(await pageLanguage()).toBe('en');
    await waitSavedLanguage('en');
    expect(await textOf('settings')).toBe('Settings');
  });
});
