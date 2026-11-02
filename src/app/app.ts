import { TuiIcon, TuiRoot } from '@taiga-ui/core';
import { TuiSegmented } from '@taiga-ui/kit';
import { TuiNavigation } from '@taiga-ui/layout';
import { Component, computed, inject } from '@angular/core';
import { RouterOutlet } from '@angular/router';
import { ProjectTree } from './features/project-tree/project-tree/project-tree';
import { ThemeMode, ThemeService } from './core/theme/theme';

const MODES: readonly ThemeMode[] = ['system', 'light', 'dark'];

@Component({
  imports: [ProjectTree, RouterOutlet, TuiIcon, TuiNavigation, TuiRoot, TuiSegmented],
  selector: 'app-root',
  styleUrl: './app.scss',
  templateUrl: './app.html',
})
export class App {
  private readonly theme = inject(ThemeService);

  protected readonly effective = this.theme.effective;
  protected readonly activeIndex = computed(() => MODES.indexOf(this.theme.mode()));

  protected selectIndex(index: number): void {
    this.theme.setMode(MODES[index]);
  }
}
