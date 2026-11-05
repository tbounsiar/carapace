import { readSettings } from '../helpers/app-files';
import { DNT_ANALYTICS } from '../helpers/fixture';
import { screenshotThemes } from '../helpers/screenshot';
import { byId, clickId, waitForApp, waitGone } from '../helpers/ui';

// This spec runs on the second tauri-driver of wdio.conf.ts, started with DO_NOT_TRACK=1, so the
// app inherits it. `beforeSession` seeds DNT_ANALYTICS: without the variable the dialog would ask
// for connection results and launch and feature usage would be on.
const shot = async (name: string) => console.log('screenshots', await screenshotThemes(name));
const CATEGORIES = ['launch', 'features', 'connections'];
const storedAnalytics = () => readSettings()?.['analytics'];

describe('usage analytics under DO_NOT_TRACK', () => {
  before(waitForApp);

  it('shows no consent dialog', async () => {
    await browser.pause(3000);
    await expect(byId('consent-dialog')).not.toExist();
  });

  it('shows the three switches off and disabled with the explanation', async () => {
    await clickId('settings');
    await byId('settings-analytics-dnt').waitForDisplayed({ timeout: 10000 });
    await expect(byId('settings-analytics-dnt')).toHaveText(
      'Off because DO_NOT_TRACK is set on this computer. Nothing is sent.',
    );
    for (const c of CATEGORIES) {
      const input = byId(`settings-analytics-${c}`);
      expect(await input.isEnabled()).toBe(false);
      expect(await input.isSelected()).toBe(false);
      expect(await input.getAttribute('aria-describedby')).toContain('settings-analytics-dnt');
    }
    await byId('settings-analytics-launch').scrollIntoView({ block: 'center' });
    await shot('settings-privacy-dnt');
  });

  it('logs nothing and says why', async () => {
    await clickId('settings-analytics-events');
    await byId('analytics-events-empty').waitForDisplayed({ timeout: 10000 });
    await expect(byId('analytics-events-empty')).toHaveText(
      /DO_NOT_TRACK is set on this computer\./,
    );
    await expect(byId('analytics-events')).not.toExist();
    await shot('analytics-events-dnt');
    await clickId('analytics-events-close');
    await waitGone('analytics-events-close');
  });

  it('leaves the stored choices untouched', () => {
    expect(storedAnalytics()).toEqual(DNT_ANALYTICS);
  });
});
