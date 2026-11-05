import {
  FormArray,
  type AbstractControl,
  type ValidationErrors,
  type ValidatorFn,
} from '@angular/forms';
import { VARIABLE_NAME } from '../../shared/template';
import { uiText } from '../../shared/ui-text';
import { failWith, secretValidator } from '../project-tree/validators';

export const MAX_VARIABLES = 200;
export const PLAIN_VALUE_MAX = 4096;

function fail(key: string, params?: Readonly<Record<string, unknown>>): ValidationErrors {
  return failWith(`variables.validation.${key}`, params);
}

/** The control sits in a row group inside the rows array; duplicates are case-insensitive. */
export function variableNameValidator(control: AbstractControl): ValidationErrors | null {
  const name = String(control.value ?? '');
  if (!name) {
    return fail('nameRequired');
  }
  if (!VARIABLE_NAME.test(name)) {
    return fail('namePattern');
  }
  const rows = control.parent?.parent;
  if (rows instanceof FormArray) {
    const lower = name.toLowerCase();
    const same = rows.controls.filter(
      (row) => String(row.get('name')?.value ?? '').toLowerCase() === lower,
    );
    if (same.length > 1) {
      return fail('duplicate');
    }
  }
  return null;
}

const secretValue = secretValidator(() => uiText('variables.validation.secretLabel'), false);

/** Depends on the sibling `kind` control: a plain value or a newly typed secret. */
export const variableValueValidator: ValidatorFn = (control) => {
  if (control.parent?.get('kind')?.value === 'secret') {
    return secretValue(control);
  }
  return String(control.value ?? '').length > PLAIN_VALUE_MAX
    ? fail('valueMax', { max: PLAIN_VALUE_MAX })
    : null;
};
