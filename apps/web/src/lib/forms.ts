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

/** A whole number as a person types it — either script of digits, spaces around ignored — or null. */
export function wholeNumber(value: string | null | undefined): number | null {
  const v = latinDigits(value ?? '').trim();
  return /^\d+$/.test(v) ? Number.parseInt(v, 10) : null;
}
