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
