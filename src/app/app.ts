import { TuiThemeColorService } from '@taiga-ui/addon-mobile';
import { TUI_DARK_MODE, TuiIcon, TuiRoot } from '@taiga-ui/core';
import { TuiBadge } from '@taiga-ui/kit';
import { TuiNavigation } from '@taiga-ui/layout';
import {
  afterRenderEffect,
  Component,
  computed,
  effect,
  ElementRef,
  inject,
  untracked,
  viewChild,
  ViewContainerRef,
} from '@angular/core';
import { RouterLink, RouterOutlet } from '@angular/router';
import { TranslocoPipe, TranslocoService } from '@jsverse/transloco';
import { EditedFiles } from './core/ipc/edited-files';
import { ThemeService } from './core/theme/theme';
import { CurrentScope } from './shared/current-scope';
import { trackLanguage, uiText } from './shared/ui-text';
import { LocationBar } from './features/shell/location-bar/location-bar';
import { ProjectSelect } from './features/shell/project-select/project-select';
import { ThemeMenu } from './features/shell/theme-menu/theme-menu';
import { AsideHeader } from './features/sidebar/aside-header/aside-header';
import { SidebarTree } from './features/sidebar/sidebar-tree/sidebar-tree';
import { Workspace } from './features/workspace/workspace';

/** The navigation chrome: a token that differs from the page background in both themes. */
const CHROME_TOKEN = '--tui-background-base-alt';

@Component({
  imports: [
    AsideHeader,
    LocationBar,
    ProjectSelect,
    RouterLink,
    RouterOutlet,
    SidebarTree,
    ThemeMenu,
    TranslocoPipe,
    TuiBadge,
    TuiIcon,
    TuiNavigation,
    TuiRoot,
  ],
  selector: 'app-root',
  styleUrl: './app.scss',
  templateUrl: './app.html',
})
export class App {
  private readonly theme = inject(ThemeService);
  private readonly scope = inject(CurrentScope);
  private readonly themeColor = inject(TuiThemeColorService);
  private readonly root = viewChild.required(TuiRoot, { read: ElementRef<HTMLElement> });

  protected readonly effective = this.theme.effective;
  private readonly workspace = inject(Workspace);
  protected readonly hasTabs = computed(() => this.workspace.tabs().length > 0);
  private readonly stripSlot = viewChild.required('tabStrip', { read: ViewContainerRef });
  private stripLoading = false;
  protected readonly edited = inject(EditedFiles);
  /** "Edited files, 3 files, 1 needs attention". */
  protected readonly editedLabel = computed(() =>
    uiText('shell.aside.editedLabel', {
      count: this.edited.count(),
      attention: this.edited.attention(),
    }),
  );
  /** Global pages in the aside footer; Taiga's item shows the active one but sets no aria-current. */
  protected readonly page = computed(() => {
    const route = this.scope.route();
    return route.kind === 'other' ? route.path : null;
  });

  constructor() {
    trackLanguage(inject(TranslocoService));
    // Lazy: tabs only exist after a lazy terminal, files or editor action.
    effect(() => {
      if (this.hasTabs() && !this.stripLoading) {
        this.stripLoading = true;
        const slot = untracked(this.stripSlot);
        void import('./features/workspace/tab-strip/tab-strip').then(({ TabStrip }) =>
          slot.createComponent(TabStrip),
        );
      }
    });
    // Taiga's dropdowns read the closest `tuiTheme` again only when its dark-mode signal changes.
    const darkMode = inject(TUI_DARK_MODE);
    effect(() => {
      const dark = this.effective() === 'dark';
      if (darkMode() !== dark) {
        darkMode.set(dark);
      }
    });
    // The service needs a concrete colour (it also feeds the theme-color meta tag), so the token
    // is read where the current theme applies, after the theme attribute is rendered.
    afterRenderEffect(() => {
      this.effective();
      const color = getComputedStyle(this.root().nativeElement).getPropertyValue(CHROME_TOKEN);
      if (color.trim()) {
        this.themeColor.color = color.trim();
      }
    });
  }
}
