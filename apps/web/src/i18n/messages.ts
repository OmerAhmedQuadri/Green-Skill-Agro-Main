import type { ErrorCode, PermissionCode } from '@gsa/core';
import arMessages from '../messages/ar.json';
import en from '../messages/en.json';

/** English is the reference shape. */
export type Messages = typeof en;

// I18N-001: typing Arabic against English makes a missing Arabic key a compile error.
const ar: Messages = arMessages;

export const MESSAGES = { en, ar } as const;

// Every domain error code has a message (ARCHITECTURE §6.9) — a missing one fails tsc.
type UnmessagedErrors = Exclude<ErrorCode, keyof Messages['errors']>;
const errorCoverage: Record<UnmessagedErrors, never> = {};

// Every permission has a label for the permission editor — a missing one fails tsc.
type Labelled<C> = C extends `${infer M}.${infer A}`
  ? M extends keyof Messages['permissions'] ? (A extends keyof Messages['permissions'][M] ? never : C) : C
  : C;
const permissionCoverage: Record<Labelled<PermissionCode>, never> = {};

void errorCoverage;
void permissionCoverage;

export type ErrorKey = keyof Messages['errors'];
export const isErrorKey = (code: string): code is ErrorKey => code in en.errors;
