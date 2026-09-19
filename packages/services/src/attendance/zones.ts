import { assertLocation, DomainError } from '@gsa/core';
import { schema } from '@gsa/db';
import { asc, eq } from 'drizzle-orm';
import { authorize, type Ctx, type Patch } from '../context';
import { audit, inTx } from '../platform';
import { getDb } from '../runtime';

const { checkInZones } = schema;

export type Zone = { readonly id: string; readonly name: string; readonly lat: number; readonly lng: number; readonly radiusM: number; readonly isActive: boolean; readonly version: number };
type ZoneInput = { name: string; lat: number; lng: number; radiusM: number; isActive?: boolean | undefined };

const toZone = (z: typeof checkInZones.$inferSelect): Zone => ({ id: z.id, name: z.name, lat: Number(z.lat), lng: Number(z.lng), radiusM: z.radiusM, isActive: z.isActive, version: z.version });

function validate(input: Pick<ZoneInput, 'name' | 'lat' | 'lng' | 'radiusM'>) {
  const name = input.name.trim();
  if (!name) throw new DomainError('INVALID_NAME');
  assertLocation(input);
  if (!Number.isInteger(input.radiusM) || input.radiusM < 25 || input.radiusM > 50_000) throw new DomainError('INVALID_SETTING', { field: 'radiusM' });
  return { name, lat: input.lat.toFixed(6), lng: input.lng.toFixed(6), radiusM: input.radiusM };
}

/** ATT-008 (ADR-0032): the places a check-in may be restricted to. */
export async function listZones(ctx: Ctx): Promise<Zone[]> {
  authorize(ctx, 'system.configure');
  return (await getDb().select().from(checkInZones).orderBy(asc(checkInZones.name))).map(toZone);
}

export async function createZone(ctx: Ctx, input: ZoneInput): Promise<Zone> {
  authorize(ctx, 'system.configure');
  const values = validate(input);
  return inTx(ctx, async (tx) => {
    const [row] = await tx.insert(checkInZones).values({ ...values, isActive: input.isActive ?? true, branchId: ctx.branchId, createdBy: ctx.user.id, updatedBy: ctx.user.id }).returning();
    if (!row) throw new Error('zone insert returned nothing');
    await audit(tx, ctx, { action: 'attendance.zone_created', entityType: 'check_in_zone', entityId: row.id, after: values });
    return toZone(row);
  });
}

export async function updateZone(ctx: Ctx, id: string, input: Patch<ZoneInput> & { version: number }): Promise<Zone> {
  authorize(ctx, 'system.configure');
  return inTx(ctx, async (tx) => {
    const [current] = await tx.select().from(checkInZones).where(eq(checkInZones.id, id)).for('update');
    if (!current) throw new DomainError('NOT_FOUND', { entity: 'check_in_zone', id });
    if (current.version !== input.version) throw new DomainError('VERSION_CONFLICT', { entity: 'check_in_zone', id });
    const values = validate({
      name: input.name ?? current.name, lat: input.lat ?? Number(current.lat), lng: input.lng ?? Number(current.lng), radiusM: input.radiusM ?? current.radiusM,
    });
    const [row] = await tx.update(checkInZones).set({ ...values, isActive: input.isActive ?? current.isActive, updatedAt: ctx.now, updatedBy: ctx.user.id, version: current.version + 1 })
      .where(eq(checkInZones.id, id)).returning();
    if (!row) throw new Error('zone update returned nothing');
    await audit(tx, ctx, { action: 'attendance.zone_updated', entityType: 'check_in_zone', entityId: id, before: toZone(current), after: toZone(row) });
    return toZone(row);
  });
}
