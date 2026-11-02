import {
  FormArray,
  type AbstractControl,
  type ValidationErrors,
  type ValidatorFn,
} from '@angular/forms';
import { TuiValidationError } from '@taiga-ui/cdk';
import { VARIABLE_NAME } from '../../shared/template';
import { secretValidator } from '../project-tree/validators';

export const MAX_VARIABLES = 200;
export const PLAIN_VALUE_MAX = 4096;

function fail(message: string): ValidationErrors {
  return { invalid: new TuiValidationError(message) };
}

/** The control sits in a row group inside the rows array; duplicates are case-insensitive. */
export function variableNameValidator(control: AbstractControl): ValidationErrors | null {
  const name = String(control.value ?? '');
  if (!name) {
    return fail('Name is required');
  }
  if (!VARIABLE_NAME.test(name)) {
    return fail('Use letters, digits, "_", "." or "-", starting with a letter or "_" (max 64)');
  }
  const rows = control.parent?.parent;
  if (rows instanceof FormArray) {
    const lower = name.toLowerCase();
    const same = rows.controls.filter(
      (row) => String(row.get('name')?.value ?? '').toLowerCase() === lower,
    );
    if (same.length > 1) {
      return fail('This name is already used in this scope');
    }
  }
  return null;
}

const secretValue = secretValidator('Secret value', false);

/** Depends on the sibling `kind` control: a plain value or a newly typed secret. */
export const variableValueValidator: ValidatorFn = (control) => {
  if (control.parent?.get('kind')?.value === 'secret') {
    return secretValue(control);
  }
  return String(control.value ?? '').length > PLAIN_VALUE_MAX
    ? fail(`Value must be at most ${PLAIN_VALUE_MAX} characters`)
    : null;
};
