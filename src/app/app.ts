import { TuiHint, TuiIcon, TuiRoot } from '@taiga-ui/core';
import { TuiSegmented } from '@taiga-ui/kit';
import { TuiNavigation } from '@taiga-ui/layout';
import { Component, computed, inject } from '@angular/core';
import { RouterLink, RouterOutlet } from '@angular/router';
import { ProjectTree } from './features/project-tree/project-tree/project-tree';
import { ThemeMode, ThemeService } from './core/theme/theme';

interface ThemeOption {
  readonly mode: ThemeMode;
  readonly label: string;
  readonly icon: string;
}

const THEME_OPTIONS: readonly ThemeOption[] = [
  { mode: 'system', label: 'System theme', icon: '@tui.monitor' },
  { mode: 'light', label: 'Light theme', icon: '@tui.sun' },
  { mode: 'dark', label: 'Dark theme', icon: '@tui.moon' },
];

@Component({
  imports: [
    ProjectTree,
    RouterLink,
    RouterOutlet,
    TuiHint,
    TuiIcon,
    TuiNavigation,
    TuiRoot,
    TuiSegmented,
  ],
  selector: 'app-root',
  styleUrl: './app.scss',
  templateUrl: './app.html',
})
export class App {
  private readonly theme = inject(ThemeService);

  protected readonly themeOptions = THEME_OPTIONS;
  protected readonly effective = this.theme.effective;
  protected readonly activeIndex = computed(() =>
    THEME_OPTIONS.findIndex((option) => option.mode === this.theme.mode()),
  );

  protected selectIndex(index: number): void {
    this.theme.setMode(THEME_OPTIONS[index].mode);
  }
}
