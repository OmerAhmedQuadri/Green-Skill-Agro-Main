/**
 * The delivery document (DOC-001..006, ADR-0019, ADR-0037): an unofficial
 * delivery record, never a tax invoice. Its row is the render job.
 */
export const DELIVERY_DOCUMENT_STATUSES = ['PENDING', 'READY', 'FAILED'] as const;
export type DeliveryDocumentStatus = (typeof DELIVERY_DOCUMENT_STATUSES)[number];

/** DOC-004: whether the seller must send it, may, or cannot. A copy is kept in every case (DOC-005). */
export const DOCUMENT_SENDING_MODES = ['OPTIONAL', 'COMPULSORY', 'DISABLED'] as const;
export type DocumentSendingMode = (typeof DOCUMENT_SENDING_MODES)[number];

/** DOC-003, OQ-007: the phone's share sheet (WhatsApp, SMS, …) or email from the server. */
export const DOCUMENT_SEND_CHANNELS = ['SHARE', 'EMAIL'] as const;
export type DocumentSendChannel = (typeof DOCUMENT_SEND_CHANNELS)[number];

/** Attempts before a render is given up as FAILED; each waits longer than the last. */
export const DOCUMENT_RENDER_MAX_ATTEMPTS = 6;
export const documentRenderBackoffMs = (attempt: number): number => Math.min(30 * 60_000, 15_000 * 2 ** (attempt - 1));
