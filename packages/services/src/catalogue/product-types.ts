import {
  assertValidTemplate, bilingualName, DomainError, PRODUCT_ATTRIBUTES, templateFrom,
  type CountUnit, type ProductTypeId, type Template,
} from '@gsa/core';
import { schema } from '@gsa/db';
import { and, asc, eq } from 'drizzle-orm';
import { authorize, authorizeAny, type Ctx } from '../context';
import { audit, inTx, mapUniqueViolations, snapshot, type Executor } from '../platform';
import { getDb } from '../runtime';
import { CATALOGUE_READERS } from './access';

const { productTypes, productTypeAttributes } = schema;

export type ProductType = {
  readonly id: ProductTypeId; readonly code: string; readonly nameEn: string; readonly nameAr: string;
  readonly countUnit: CountUnit; readonly isActive: boolean; readonly version: number; readonly template: Template;
};

const duplicateName = new DomainError('DUPLICATE_NAME', { field: 'nameEn' });
const uniques = { product_types_name_en_unique: duplicateName, product_types_code_unique: duplicateName };

export async function loadProductTypes(db: Executor): Promise<ProductType[]> {
  const [types, attributes] = await Promise.all([
    db.select().from(productTypes).orderBy(asc(productTypes.createdAt)),
    db.select().from(productTypeAttributes),
  ]);
  return types.map((t) => ({
    id: t.id as ProductTypeId, code: t.code, nameEn: t.nameEn, nameAr: t.nameAr, countUnit: t.countUnit,
    isActive: t.isActive, version: t.version,
    template: templateFrom(attributes.filter((a) => a.productTypeId === t.id)),
  }));
}

export async function loadProductType(db: Executor, id: string): Promise<ProductType> {
  const found = (await loadProductTypes(db)).find((t) => t.id === id);
  if (!found) throw new DomainError('NOT_FOUND', { entity: 'product_type', id });
  return found;
}

/** CAT-013: types with their templates — the product form is built from these. */
export async function listProductTypes(ctx: Ctx): Promise<ProductType[]> {
  authorizeAny(ctx, CATALOGUE_READERS);
  return loadProductTypes(getDb());
}

async function writeTemplate(tx: Executor, productTypeId: string, template: Template) {
  assertValidTemplate(template);
  await tx.delete(productTypeAttributes).where(eq(productTypeAttributes.productTypeId, productTypeId));
  await tx.insert(productTypeAttributes).values(PRODUCT_ATTRIBUTES.map((attribute) => ({ productTypeId, attribute, mode: template[attribute] })));
}

/** SYS-004: a new product type, e.g. a further range of essentials. */
export async function createProductType(
  ctx: Ctx, input: { nameEn: string; nameAr: string; countUnit: CountUnit; template: Template },
): Promise<ProductType> {
  authorize(ctx, 'system.manage_templates');
  const name = bilingualName(input);
  const code = name.nameEn.toUpperCase().replace(/[^A-Z0-9]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 30) || 'TYPE';
  return inTx(ctx, async (tx) => {
    const [row] = await mapUniqueViolations(tx.insert(productTypes).values({
      code, ...name, countUnit: input.countUnit, createdBy: ctx.user.id, updatedBy: ctx.user.id,
    }).returning({ id: productTypes.id }), uniques);
    if (!row) throw new Error('product type insert returned nothing');
    await writeTemplate(tx, row.id, input.template);
    await audit(tx, ctx, { action: 'system.product_type_created', entityType: 'product_type', entityId: row.id, after: { ...name, countUnit: input.countUnit, template: input.template } });
    return loadProductType(tx, row.id);
  });
}

/** SYS-004, CAT-015: rename, retire, or change which attributes the type shows and requires. */
export async function updateProductType(
  ctx: Ctx, id: string,
  input: { version: number; nameEn?: string | undefined; nameAr?: string | undefined; countUnit?: CountUnit | undefined; isActive?: boolean | undefined; template?: Template | undefined },
): Promise<ProductType> {
  authorize(ctx, 'system.manage_templates');
  return inTx(ctx, async (tx) => {
    const current = await loadProductType(tx, id);
    const next = {
      ...bilingualName({ nameEn: input.nameEn ?? current.nameEn, nameAr: input.nameAr ?? current.nameAr }),
      countUnit: input.countUnit ?? current.countUnit,
      isActive: input.isActive ?? current.isActive,
    };
    const [row] = await mapUniqueViolations(tx.update(productTypes)
      .set({ ...next, updatedAt: ctx.now, updatedBy: ctx.user.id, version: current.version + 1 })
      .where(and(eq(productTypes.id, id), eq(productTypes.version, input.version)))
      .returning({ id: productTypes.id }), uniques);
    if (!row) throw new DomainError('VERSION_CONFLICT', { entity: 'product_type', id });
    if (input.template) await writeTemplate(tx, id, input.template);
    await audit(tx, ctx, {
      action: 'system.product_type_updated', entityType: 'product_type', entityId: id,
      before: { ...snapshot(current, next), template: current.template },
      after: { ...next, template: input.template ?? current.template },
    });
    return loadProductType(tx, id);
  });
}
