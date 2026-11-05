import { EMPTY_DATA, writeData } from '../helpers/app-files';
import { restartApp } from '../helpers/app-process';
import { byId, clickId, waitForApp, waitGone } from '../helpers/ui';

/**
 * Runs on the main driver, whose environment has no `CARAPACE_E2E_PICKED_FILE`: in the
 * `e2e-pickers` build every data picker then reads as cancelled.
 */
describe('Import and export with a cancelled picker', () => {
  before(async () => {
    await waitForApp();
    await restartApp(() =>
      writeData({
        ...EMPTY_DATA,
        nodes: [
          {
            kind: 'host',
            id: 'e1f2a3b4-c5d6-4e7f-8a9b-0c1d2e3f4a5b',
            name: 'vps',
            projectId: null,
            parentId: null,
            hostname: 'vps.example.com',
            port: '22',
            username: 'deploy',
            auth: { kind: 'agent' },
          },
        ],
      }),
    );
    await waitForApp();
  });

  it('keeps the export dialog as it was when the save dialog is cancelled', async () => {
    await clickId('settings');
    await byId('settings-title').waitForDisplayed({ timeout: 10000 });
    await clickId('settings-export');
    await byId('export-dialog').waitForDisplayed({ timeout: 10000 });
    await clickId('export-submit');
    await byId('export-submit').waitForEnabled({ timeout: 10000 });
    await browser.pause(500);
    await expect(byId('export-dialog')).toBeDisplayed();
    await expect(byId('export-error')).not.toExist();
    await clickId('dialog-cancel');
    await waitGone('export-dialog');
  });

  it('opens nothing when the open dialog is cancelled', async () => {
    await clickId('settings-import');
    await byId('settings-import').waitForEnabled({ timeout: 10000 });
    await browser.pause(500);
    await expect(byId('import-dialog')).not.toExist();
    await clickId('home-link');
    await byId('home-menu').waitForClickable({ timeout: 10000 });
    await clickId('home-menu');
    await clickId('home-import');
    await browser.pause(1000);
    await expect(byId('import-dialog')).not.toExist();
  });
});
