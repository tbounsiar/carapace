import { Component, computed, effect, inject } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { FormControl, ReactiveFormsModule } from '@angular/forms';
import { TranslocoPipe } from '@jsverse/transloco';
import { TuiTextfield } from '@taiga-ui/core';
import { TuiInputColor } from '@taiga-ui/kit';
import { Settings } from '../../../core/settings/settings';
import {
  isAccentColor,
  PALETTE_TOKENS,
  paletteAccent,
  PALETTES,
} from '../../../core/theme/palette';
import { ThemeService } from '../../../core/theme/theme';

/**
 * The custom accent field of the Colors group, created only once the switch is on: `TuiInputColor`
 * brings Maskito, which must stay out of the initial chunk.
 */
@Component({
  imports: [ReactiveFormsModule, TranslocoPipe, TuiInputColor, TuiTextfield],
  selector: 'app-accent-field',
  styleUrl: './accent-field.scss',
  templateUrl: './accent-field.html',
})
export class AccentField {
  private readonly settings = inject(Settings);
  private readonly theme = inject(ThemeService);

  /** The pick, else the set's accent for the variant on screen (shown, not saved). */
  private readonly shown = computed(
    () =>
      this.settings.accentColor() ??
      PALETTE_TOKENS[this.settings.palette()][this.theme.effective()].accent,
  );
  protected readonly control = new FormControl<string>(this.shown(), { nonNullable: true });
  /** The four sets' accents for the variant on screen, offered by the native picker. */
  protected readonly suggestions = computed(() =>
    PALETTES.map((palette) => PALETTE_TOKENS[palette][this.theme.effective()].accent),
  );
  protected readonly applied = computed(
    () => this.theme.accentColors() ?? paletteAccent(this.settings.palette()),
  );
  protected readonly adjustedKey = computed(() => {
    const { light, dark } = this.applied();
    if (light.adjusted && dark.adjusted) {
      return 'settings.accent.adjustedBoth';
    }
    if (light.adjusted) {
      return 'settings.accent.adjustedLight';
    }
    return dark.adjusted ? 'settings.accent.adjustedDark' : null;
  });

  constructor() {
    effect(() => this.control.setValue(this.shown(), { emitEvent: false }));
    this.control.valueChanges.pipe(takeUntilDestroyed()).subscribe((value) => {
      // Partial values while typing are not applied; each complete one is (and saved).
      if (isAccentColor(value)) {
        this.settings.setAccentColor(value);
      }
    });
  }

  /** An incomplete value is dropped: the field shows what is applied again. */
  protected restore(): void {
    if (!isAccentColor(this.control.value)) {
      this.control.setValue(this.shown(), { emitEvent: false });
    }
  }
}
