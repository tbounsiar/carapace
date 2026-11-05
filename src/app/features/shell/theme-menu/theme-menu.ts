import { Component, computed, inject, signal } from '@angular/core';
import { TranslocoPipe } from '@jsverse/transloco';
import { TuiButton, TuiDataList, TuiDropdown, TuiHint } from '@taiga-ui/core';
import { Settings } from '../../../core/settings/settings';
import { type ThemeMode, ThemeService } from '../../../core/theme/theme';

interface ThemeOption {
  readonly mode: ThemeMode;
  /** Translation key. */
  readonly label: string;
  readonly icon: string;
}

const THEME_OPTIONS: readonly ThemeOption[] = [
  { mode: 'system', label: 'shell.themeMenu.system', icon: '@tui.monitor' },
  { mode: 'light', label: 'shell.themeMenu.light', icon: '@tui.sun' },
  { mode: 'dark', label: 'shell.themeMenu.dark', icon: '@tui.moon' },
];

@Component({
  imports: [TranslocoPipe, TuiButton, TuiDataList, TuiDropdown, TuiHint],
  selector: 'app-theme-menu',
  templateUrl: './theme-menu.html',
})
export class ThemeMenu {
  private readonly themes = inject(ThemeService);
  private readonly settings = inject(Settings);

  protected readonly options = THEME_OPTIONS;
  protected readonly open = signal(false);
  protected readonly current = computed(
    () => THEME_OPTIONS.find((o) => o.mode === this.themes.mode()) ?? THEME_OPTIONS[0],
  );

  protected isCurrent(option: ThemeOption): boolean {
    return option.mode === this.themes.mode();
  }

  protected choose(option: ThemeOption): void {
    this.settings.setTheme(option.mode);
    this.open.set(false);
  }
}
