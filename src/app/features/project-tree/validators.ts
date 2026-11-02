import type { AbstractControl, ValidationErrors, ValidatorFn } from '@angular/forms';
import { TuiValidationError } from '@taiga-ui/cdk';
import {
  hasReferences,
  invalidReference,
  secretReferenceName,
  TEMPLATE_MAX,
} from '../../shared/template';

const WHITESPACE = /\s/;
const ABSOLUTE_PATH = /^(\/|~\/|[A-Za-z]:[\\/])/;

function fail(message: string): ValidationErrors {
  return { invalid: new TuiValidationError(message) };
}

export function nameValidator(label: string, max: number): ValidatorFn {
  return (control: AbstractControl): ValidationErrors | null => {
    const value = String(control.value ?? '');
    if (value.trim().length === 0) {
      return fail(`${label} is required`);
    }
    return value.length > max ? fail(`${label} must be at most ${max} characters`) : null;
  };
}

export function noWhitespaceValidator(label: string, max: number): ValidatorFn {
  return (control: AbstractControl): ValidationErrors | null => {
    const value = String(control.value ?? '');
    if (value.length === 0) {
      return fail(`${label} is required`);
    }
    if (value.length > max) {
      return fail(`${label} must be at most ${max} characters`);
    }
    return WHITESPACE.test(value) ? fail(`${label} must not contain whitespace`) : null;
  };
}

const HOSTNAME_CHARS = /^[A-Za-z0-9.:-]+$/;

export function hostnameValidator(max: number): ValidatorFn {
  const base = noWhitespaceValidator('Hostname', max);
  return (control: AbstractControl): ValidationErrors | null =>
    base(control) ??
    (HOSTNAME_CHARS.test(String(control.value))
      ? null
      : fail('Hostname may only contain letters, digits, ".", "-" and ":"'));
}

export function portValidator(control: AbstractControl): ValidationErrors | null {
  const value = String(control.value ?? '').trim();
  if (value.length === 0) {
    return fail('Port is required');
  }
  const port = Number(value);
  return /^\d+$/.test(value) && port >= 1 && port <= 65535
    ? null
    : fail('Port must be between 1 and 65535');
}

/** A field with `${name}` references is checked after resolution; only its size is checked here. */
export function templated(label: string, literal: ValidatorFn): ValidatorFn {
  return (control: AbstractControl): ValidationErrors | null => {
    const value = String(control.value ?? '');
    const invalid = invalidReference(value);
    if (invalid) {
      return fail(`"${invalid}" is not a valid variable reference; write $$ for a literal $`);
    }
    if (!hasReferences(value)) {
      return literal(control);
    }
    return value.length > TEMPLATE_MAX
      ? fail(`${label} must be at most ${TEMPLATE_MAX} characters`)
      : null;
  };
}

/** Digits, or exactly one `${name}`. */
export function portTemplateValidator(control: AbstractControl): ValidationErrors | null {
  const value = String(control.value ?? '').trim();
  if (!value.includes('$')) {
    return portValidator(control);
  }
  return secretReferenceName(value)
    ? null
    : fail('Port must be digits or a single variable like ${port}');
}

/** Empty means "ask when connecting"; anything else must be exactly one `${name}`. */
export function secretReferenceValidator(label: string): ValidatorFn {
  return (control: AbstractControl): ValidationErrors | null => {
    const value = String(control.value ?? '').trim();
    if (!value || secretReferenceName(value)) {
      return null;
    }
    return fail(`${label} must be a secret variable reference like \${db_password}`);
  };
}

export function keyPathValidator(control: AbstractControl): ValidationErrors | null {
  const value = String(control.value ?? '').trim();
  if (value.length === 0) {
    return fail('Key path is required');
  }
  if (value.startsWith('\\\\')) {
    return fail('Network paths are not supported');
  }
  return ABSOLUTE_PATH.test(value) ? null : fail('Use an absolute path or one starting with ~/');
}

// Windows Credential Manager stores at most 1280 UTF-16 code units, which is what `length` counts.
export const SECRET_MAX = 1280;

/** Never trims or echoes the value: whitespace can be part of a password. */
export function secretValidator(label: string, required: boolean): ValidatorFn {
  return (control: AbstractControl): ValidationErrors | null => {
    const length = String(control.value ?? '').length;
    if (length === 0) {
      return required ? fail(`${label} is required`) : null;
    }
    return length > SECRET_MAX ? fail(`${label} must be at most ${SECRET_MAX} characters`) : null;
  };
}
