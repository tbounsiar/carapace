import { Component, computed, inject, signal } from '@angular/core';
import { TuiButton, TuiDataList, TuiDropdown, TuiHint } from '@taiga-ui/core';
import { type ThemeMode, ThemeService } from '../../../core/theme/theme';

interface ThemeOption {
  readonly mode: ThemeMode;
  readonly label: string;
  readonly icon: string;
}

const THEME_OPTIONS: readonly ThemeOption[] = [
  { mode: 'system', label: 'System', icon: '@tui.monitor' },
  { mode: 'light', label: 'Light', icon: '@tui.sun' },
  { mode: 'dark', label: 'Dark', icon: '@tui.moon' },
];

@Component({
  imports: [TuiButton, TuiDataList, TuiDropdown, TuiHint],
  selector: 'app-theme-menu',
  templateUrl: './theme-menu.html',
})
export class ThemeMenu {
  private readonly themes = inject(ThemeService);

  protected readonly options = THEME_OPTIONS;
  protected readonly theme = this.themes.effective;
  protected readonly open = signal(false);
  protected readonly current = computed(
    () => THEME_OPTIONS.find((o) => o.mode === this.themes.mode()) ?? THEME_OPTIONS[0],
  );

  protected isCurrent(option: ThemeOption): boolean {
    return option.mode === this.themes.mode();
  }

  protected choose(option: ThemeOption): void {
    this.themes.setMode(option.mode);
    this.open.set(false);
  }
}
