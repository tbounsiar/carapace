import { Component } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { FormControl, FormGroup, ReactiveFormsModule, Validators } from '@angular/forms';
import { provideTaiga, TuiError } from '@taiga-ui/core';
import { ErrorLink } from './error-link';

@Component({
  imports: [ErrorLink, ReactiveFormsModule, TuiError],
  template: `
    <form [formGroup]="form">
      <input formControlName="name" aria-describedby="hint" />
      <p id="hint">Hint</p>
      <tui-error appErrorLink formControlName="name" />
    </form>
  `,
})
class Host {
  readonly form = new FormGroup({ name: new FormControl('', Validators.required) });
}

describe('ErrorLink', () => {
  it('links the error to its input and mirrors aria-invalid once touched', async () => {
    await TestBed.configureTestingModule({
      imports: [Host],
      providers: [provideTaiga()],
    }).compileComponents();
    const fixture = TestBed.createComponent(Host);
    await fixture.whenStable();
    const el = fixture.nativeElement as HTMLElement;
    const input = el.querySelector('input')!;
    const error = el.querySelector('tui-error')!;

    expect(error.id).not.toBe('');
    expect(input.getAttribute('aria-describedby')).toBe(`hint ${error.id}`);
    expect(input.hasAttribute('aria-invalid')).toBe(false);

    fixture.componentInstance.form.controls.name.markAsTouched();
    expect(input.getAttribute('aria-invalid')).toBe('true');

    fixture.componentInstance.form.controls.name.setValue('ok');
    expect(input.hasAttribute('aria-invalid')).toBe(false);
  });
});
