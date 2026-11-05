import { computed } from '@angular/core';
import type { AbstractControl, ValidationErrors, ValidatorFn } from '@angular/forms';
import { TuiValidationError } from '@taiga-ui/cdk';
import {
  hasReferences,
  invalidReference,
  secretReferenceName,
  TEMPLATE_MAX,
} from '../../shared/template';
import { uiText } from '../../shared/ui-text';

const WHITESPACE = /\s/;
const ABSOLUTE_PATH = /^(\/|~\/|[A-Za-z]:[\\/])/;

/** A field label: a fixed text, or a function returning the translated one. */
export type Label = string | (() => string);

/**
 * The error is a signal, which Taiga's `tui-error` reads reactively, so a shown message follows a
 * language switch. `validationMessage` reads it back as text.
 */
export function failWith(
  key: string,
  params?: Readonly<Record<string, unknown>>,
): ValidationErrors {
  return {
    invalid: computed(() => {
      const resolved = Object.fromEntries(
        Object.entries(params ?? {}).map(([name, value]) => [
          name,
          typeof value === 'function' ? (value as () => unknown)() : value,
        ]),
      );
      return new TuiValidationError(uiText(key, resolved));
    }),
  };
}

function fail(key: string, params?: Readonly<Record<string, unknown>>): ValidationErrors {
  return failWith(`projectTree.validation.${key}`, params);
}

/** The text of an `invalid` error, plain or translated; null when there is none. */
export function validationMessage(error: unknown): string | null {
  const value: unknown = typeof error === 'function' ? (error as () => unknown)() : error;
  return value instanceof TuiValidationError ? String(value.message) : null;
}

export function nameValidator(label: Label, max: number): ValidatorFn {
  return (control: AbstractControl): ValidationErrors | null => {
    const value = String(control.value ?? '');
    if (value.trim().length === 0) {
      return fail('required', { label });
    }
    return value.length > max ? fail('maxLength', { label, max }) : null;
  };
}

export function noWhitespaceValidator(label: Label, max: number): ValidatorFn {
  return (control: AbstractControl): ValidationErrors | null => {
    const value = String(control.value ?? '');
    if (value.length === 0) {
      return fail('required', { label });
    }
    if (value.length > max) {
      return fail('maxLength', { label, max });
    }
    return WHITESPACE.test(value) ? fail('noWhitespace', { label }) : null;
  };
}

const HOSTNAME_CHARS = /^[A-Za-z0-9.:-]+$/;

export function hostnameValidator(max: number): ValidatorFn {
  const base = noWhitespaceValidator(() => uiText('projectTree.hostDialog.fields.hostname'), max);
  return (control: AbstractControl): ValidationErrors | null =>
    base(control) ?? (HOSTNAME_CHARS.test(String(control.value)) ? null : fail('hostnameChars'));
}

export function portValidator(control: AbstractControl): ValidationErrors | null {
  const value = String(control.value ?? '').trim();
  if (value.length === 0) {
    return fail('portRequired');
  }
  const port = Number(value);
  return /^\d+$/.test(value) && port >= 1 && port <= 65535 ? null : fail('portRange');
}

/** A field with `${name}` references is checked after resolution; only its size is checked here. */
export function templated(label: Label, literal: ValidatorFn): ValidatorFn {
  return (control: AbstractControl): ValidationErrors | null => {
    const value = String(control.value ?? '');
    const invalid = invalidReference(value);
    if (invalid) {
      return fail('invalidReference', { reference: invalid });
    }
    if (!hasReferences(value)) {
      return literal(control);
    }
    return value.length > TEMPLATE_MAX ? fail('maxLength', { label, max: TEMPLATE_MAX }) : null;
  };
}

/** Digits, or exactly one `${name}`. */
export function portTemplateValidator(control: AbstractControl): ValidationErrors | null {
  const value = String(control.value ?? '').trim();
  if (!value.includes('$')) {
    return portValidator(control);
  }
  return secretReferenceName(value) ? null : fail('portTemplate', { example: '${port}' });
}

/** Empty means "ask when connecting"; anything else must be exactly one `${name}`. */
export function secretReferenceValidator(label: Label): ValidatorFn {
  return (control: AbstractControl): ValidationErrors | null => {
    const value = String(control.value ?? '').trim();
    if (!value || secretReferenceName(value)) {
      return null;
    }
    return fail('secretReference', { label, example: '${db_password}' });
  };
}

export function keyPathValidator(control: AbstractControl): ValidationErrors | null {
  const value = String(control.value ?? '').trim();
  if (value.length === 0) {
    return fail('keyPathRequired');
  }
  if (value.startsWith('\\\\')) {
    return fail('networkPath');
  }
  if (value.toLowerCase().endsWith('.pub')) {
    return fail('publicKey');
  }
  return ABSOLUTE_PATH.test(value) ? null : fail('absolutePath');
}

// Windows Credential Manager stores at most 1280 UTF-16 code units, which is what `length` counts.
export const SECRET_MAX = 1280;

/** Never trims or echoes the value: whitespace can be part of a password. */
export function secretValidator(label: Label, required: boolean): ValidatorFn {
  return (control: AbstractControl): ValidationErrors | null => {
    const length = String(control.value ?? '').length;
    if (length === 0) {
      return required ? fail('required', { label }) : null;
    }
    return length > SECRET_MAX ? fail('maxLength', { label, max: SECRET_MAX }) : null;
  };
}
