import { distanceMetres, type GeoPoint } from '../attendance';
import { DomainError } from '../errors';

// ---------------------------------------------------------------- states (STATE-MACHINES §4)

export const STORE_STATUSES = ['PENDING_APPROVAL', 'ACTIVE', 'REJECTED', 'INACTIVE'] as const;
export type StoreStatus = (typeof STORE_STATUSES)[number];
export type StoreAction = 'approve' | 'reject' | 'deactivate' | 'reactivate';

const STORE_RULES: Record<StoreAction, { from: StoreStatus; to: StoreStatus }> = {
  approve: { from: 'PENDING_APPROVAL', to: 'ACTIVE' },
  reject: { from: 'PENDING_APPROVAL', to: 'REJECTED' },
  deactivate: { from: 'ACTIVE', to: 'INACTIVE' },
  reactivate: { from: 'INACTIVE', to: 'ACTIVE' },
};

/** STO-009: with approval on, a new store waits; with it off (STO-010), it starts active. */
export const initialStoreStatus = (approvalRequired: boolean): StoreStatus => (approvalRequired ? 'PENDING_APPROVAL' : 'ACTIVE');

/**
 * The only way a store changes state. Approval is four-eyes — never by whoever
 * onboarded the store; a rejection needs a reason.
 */
export function transitionStore(
  store: { status: StoreStatus; onboardedBy: string }, action: StoreAction, actorId: string, reason?: string | null,
): StoreStatus {
  const rule = STORE_RULES[action];
  if (store.status !== rule.from) {
    throw new DomainError(store.status === 'REJECTED' || (action === 'approve' || action === 'reject') ? 'ALREADY_DECIDED' : 'INVALID_TRANSITION', { status: store.status, action });
  }
  if (action === 'approve' && store.onboardedBy === actorId) throw new DomainError('FOUR_EYES', { rule: 'ONBOARDER_CANNOT_APPROVE' });
  if (action === 'reject' && !reason?.trim()) throw new DomainError('REASON_REQUIRED', { action });
  return rule.to;
}

// ---------------------------------------------------------------- identity (STO-001)

/**
 * A store's contact number: a Saudi mobile or landline in any common local
 * form, as E.164 (+966…), or any number already in E.164.
 */
export function normaliseContactNumber(raw: string): string {
  const compact = raw.replace(/[\s\-().]/g, '');
  const saudi = /^(?:\+966|00966|966|0)?([1-9]\d{7,8})$/.exec(compact);
  if (saudi?.[1]) return `+966${saudi[1]}`;
  if (/^\+[1-9]\d{7,14}$/.test(compact)) return compact;
  throw new DomainError('INVALID_PHONE', { phone: raw });
}

// ---------------------------------------------------------------- duplicates (STO-008, OQ-006)

/**
 * A name as it is compared: Arabic letter forms that people write
 * interchangeably are folded together (أ إ آ → ا, ة → ه, ى → ي), tatweel
 * and diacritics dropped; Latin lower-cased; anything else is a word break.
 */
export function normaliseStoreName(name: string): string {
  return name.normalize('NFKC').toLowerCase()
    .replace(/[ً-ٰٟـ]/g, '')
    .replace(/[أإآٱ]/g, 'ا').replace(/ة/g, 'ه').replace(/ى/g, 'ي')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();
}

function trigrams(name: string): Set<string> {
  const out = new Set<string>();
  for (const word of normaliseStoreName(name).split(' ').filter(Boolean)) {
    const chars = [' ', ' ', ...word, ' '];
    for (let i = 0; i + 3 <= chars.length; i += 1) out.add(chars.slice(i, i + 3).join(''));
  }
  return out;
}

/** Trigram similarity as PostgreSQL's pg_trgm computes it: shared ÷ all, 0 to 1. */
export function nameSimilarity(a: string, b: string): number {
  const x = trigrams(a);
  const y = trigrams(b);
  if (x.size === 0 || y.size === 0) return 0;
  let shared = 0;
  for (const t of x) if (y.has(t)) shared += 1;
  return shared / (x.size + y.size - shared);
}

export type DuplicateThresholds = { readonly radiusM: number; readonly nameRadiusM: number; readonly nameSimilarityPercent: number };
export type DuplicateMatch = {
  readonly storeId: string; readonly name: string; readonly distanceM: number; readonly similarityPercent: number;
  readonly reasons: readonly ('NEARBY' | 'SIMILAR_NAME')[];
};

/**
 * STO-008 (OQ-006): a warning, not a block. Nearby — within the radius — or a
 * similar name within the wider radius. Closest first.
 */
export function findDuplicates(
  candidate: GeoPoint & { name: string }, existing: readonly (GeoPoint & { id: string; name: string })[], t: DuplicateThresholds,
): DuplicateMatch[] {
  return existing.flatMap((s) => {
    const distanceM = Math.round(distanceMetres(candidate, s));
    const similarityPercent = Math.round(nameSimilarity(candidate.name, s.name) * 100);
    const reasons: ('NEARBY' | 'SIMILAR_NAME')[] = [];
    if (distanceM <= t.radiusM) reasons.push('NEARBY');
    if (distanceM <= t.nameRadiusM && similarityPercent >= t.nameSimilarityPercent) reasons.push('SIMILAR_NAME');
    return reasons.length ? [{ storeId: s.id, name: s.name, distanceM, similarityPercent, reasons }] : [];
  }).sort((a, b) => a.distanceM - b.distanceM);
}

/** A latitude/longitude box around a point, to narrow candidates before measuring. */
export function boundingBox(p: GeoPoint, radiusM: number): { minLat: number; maxLat: number; minLng: number; maxLng: number } {
  const dLat = radiusM / 111_195;
  const dLng = radiusM / (111_195 * Math.max(Math.cos((p.lat * Math.PI) / 180), 0.01));
  return { minLat: p.lat - dLat, maxLat: p.lat + dLat, minLng: p.lng - dLng, maxLng: p.lng + dLng };
}
