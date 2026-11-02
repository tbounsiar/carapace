import { TuiButton, TuiHint, TuiIcon, TuiRoot } from '@taiga-ui/core';
import { TuiSegmented } from '@taiga-ui/kit';
import { TuiNavigation } from '@taiga-ui/layout';
import { Component, computed, inject } from '@angular/core';
import { RouterLink, RouterLinkActive, RouterOutlet } from '@angular/router';
import { EnvSelect } from './features/env-select/env-select/env-select';
import { ProjectTree } from './features/project-tree/project-tree/project-tree';
import { ThemeMode, ThemeService } from './core/theme/theme';
import { CurrentProject } from './shared/current-project';
import { environmentKind } from './shared/environment-kind';

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
    EnvSelect,
    ProjectTree,
    RouterLink,
    RouterLinkActive,
    RouterOutlet,
    TuiButton,
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
  private readonly current = inject(CurrentProject);

  protected readonly themeOptions = THEME_OPTIONS;
  protected readonly effective = this.theme.effective;
  protected readonly activeIndex = computed(() =>
    THEME_OPTIONS.findIndex((option) => option.mode === this.theme.mode()),
  );

  protected readonly isProd = computed(() => {
    const env = this.current.environment();
    return env !== null && environmentKind(env.name) === 'production';
  });

  protected selectIndex(index: number): void {
    this.theme.setMode(THEME_OPTIONS[index].mode);
  }
}
