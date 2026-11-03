import { Component, inject } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { TuiIcon, TuiSlider, TuiTitle } from '@taiga-ui/core';
import { TuiSegmented } from '@taiga-ui/kit';
import { TuiForm, TuiHeader } from '@taiga-ui/layout';
import type { KeyType } from '../../../core/ipc/keys';
import { FONT_SIZE_MAX, FONT_SIZE_MIN, Settings } from '../../../core/settings/settings';
import type { ThemeMode } from '../../../core/theme/theme';

const THEME_OPTIONS: readonly { value: ThemeMode; label: string; icon: string }[] = [
  { value: 'system', label: 'System', icon: '@tui.monitor' },
  { value: 'light', label: 'Light', icon: '@tui.sun' },
  { value: 'dark', label: 'Dark', icon: '@tui.moon' },
];

const KEY_TYPE_OPTIONS: readonly { value: KeyType; label: string }[] = [
  { value: 'ed25519', label: 'Ed25519' },
  { value: 'rsa4096', label: 'RSA 4096' },
];

@Component({
  imports: [FormsModule, TuiForm, TuiHeader, TuiIcon, TuiSlider, TuiSegmented, TuiTitle],
  selector: 'app-settings-page',
  styleUrl: './settings-page.scss',
  templateUrl: './settings-page.html',
})
export class SettingsPage {
  private readonly settings = inject(Settings);

  protected readonly themeOptions = THEME_OPTIONS;
  protected readonly keyTypeOptions = KEY_TYPE_OPTIONS;
  protected readonly fontSizeMin = FONT_SIZE_MIN;
  protected readonly fontSizeMax = FONT_SIZE_MAX;

  protected readonly theme = this.settings.theme;
  protected readonly keyType = this.settings.defaultKeyType;
  protected readonly fontSize = this.settings.terminalFontSize;

  protected setTheme(mode: ThemeMode): void {
    this.settings.setTheme(mode);
  }

  protected setKeyType(type: KeyType): void {
    this.settings.setDefaultKeyType(type);
  }

  protected setFontSize(size: number | null): void {
    this.settings.setTerminalFontSize(size);
  }
}
