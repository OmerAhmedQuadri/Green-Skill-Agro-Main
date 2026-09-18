import arMessages from '../messages/ar.json';
import en from '../messages/en.json';

/** English is the reference shape. */
export type Messages = typeof en;

// I18N-001: typing Arabic against English makes a missing Arabic key a compile error.
const ar: Messages = arMessages;

export const MESSAGES = { en, ar } as const;
