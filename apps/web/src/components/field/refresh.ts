/**
 * How often the seller's screens ask again (ADR-0056): what a manager changes
 * in the console — a vehicle taken back or assigned, a load, a handover —
 * shows on the phone within a minute, and at once when the app comes back to
 * the front. A plain module, so any screen can read it.
 */
export const FIELD_REFRESH_MS = 60_000;
