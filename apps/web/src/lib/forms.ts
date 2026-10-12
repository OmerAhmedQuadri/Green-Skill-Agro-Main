/** A text field's value. FormData can also hold files, which never stringify usefully. */
export function formText(form: FormData, name: string): string {
  const value = form.get(name);
  return typeof value === 'string' ? value.trim() : '';
}

/** Passwords are taken exactly as typed — never trimmed. */
export function formSecret(form: FormData, name: string): string {
  const value = form.get(name);
  return typeof value === 'string' ? value : '';
}

/** Arabic-Indic (٠–٩) and Persian (۰–۹) digits as Latin — what an Arabic keyboard types (ADR-0026). */
export function latinDigits(value: string): string {
  return value
    .replace(/[٠-٩]/g, (d) => String(d.charCodeAt(0) - 0x0660))
    .replace(/[۰-۹]/g, (d) => String(d.charCodeAt(0) - 0x06F0));
}

/**
 * A whole number as a person types it — either script of digits, spaces
 * around ignored, thousands grouped by a comma, the Arabic thousands separator
 * (٬) or a space ("300,180", "٣٠٠٬١٨٠") — or null. Only groups of three:
 * "1,5" is not a whole number.
 */
export function wholeNumber(value: string | null | undefined): number | null {
  const v = latinDigits(value ?? '').trim();
  if (/^\d+$/.test(v)) return Number.parseInt(v, 10);
  return /^\d{1,3}(?:[,٬\s]\d{3})+$/.test(v) ? Number.parseInt(v.replace(/[,٬\s]/g, ''), 10) : null;
}

/**
 * A decimal as a person types it — Arabic-Indic digits, the Arabic decimal
 * separator (٫), the Arabic thousands separator (٬) and spaces — in the plain
 * form the API expects, e.g. "١٢٫٥" → "12.5". The server still validates it.
 */
export function decimalText(value: string | null | undefined): string {
  return latinDigits(value ?? '').replace(/٫/g, '.').replace(/[٬\s]/g, '');
}
