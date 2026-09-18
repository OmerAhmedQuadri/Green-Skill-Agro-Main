import { bilingualName, DomainError, type CategoryId, type SubCategoryId } from '@gsa/core';
import { schema } from '@gsa/db';
import { and, asc, eq } from 'drizzle-orm';
import { authorize, authorizeAny, type Ctx } from '../context';
import { audit, inTx, mapUniqueViolations, snapshot, type Executor } from '../platform';
import { getDb } from '../runtime';
import { CATALOGUE_READERS } from './access';

const { categories, subCategories } = schema;

export type SubCategory = {
  readonly id: SubCategoryId; readonly categoryId: CategoryId; readonly nameEn: string; readonly nameAr: string;
  readonly sortOrder: number; readonly isActive: boolean; readonly version: number;
};
export type Category = {
  readonly id: CategoryId; readonly nameEn: string; readonly nameAr: string; readonly expiryWarningDays: number | null;
  readonly sortOrder: number; readonly isActive: boolean; readonly version: number; readonly subCategories: readonly SubCategory[];
};

const duplicateName = new DomainError('DUPLICATE_NAME', { field: 'nameEn' });

const categoryColumns = {
  id: categories.id, nameEn: categories.nameEn, nameAr: categories.nameAr, expiryWarningDays: categories.expiryWarningDays,
  sortOrder: categories.sortOrder, isActive: categories.isActive, version: categories.version,
};
const subCategoryColumns = {
  id: subCategories.id, categoryId: subCategories.categoryId, nameEn: subCategories.nameEn, nameAr: subCategories.nameAr,
  sortOrder: subCategories.sortOrder, isActive: subCategories.isActive, version: subCategories.version,
};

/** CAT-001/002: the maintained structure, inactive entries included so they can be reactivated. */
export async function listCategories(ctx: Ctx): Promise<Category[]> {
  authorizeAny(ctx, CATALOGUE_READERS);
  return loadStructure(getDb());
}

async function loadStructure(db: Executor): Promise<Category[]> {
  const [cats, subs] = await Promise.all([
    db.select(categoryColumns).from(categories).orderBy(asc(categories.sortOrder), asc(categories.nameEn)),
    db.select(subCategoryColumns).from(subCategories).orderBy(asc(subCategories.sortOrder), asc(subCategories.nameEn)),
  ]);
  return cats.map((c) => ({
    ...c, id: c.id as CategoryId,
    subCategories: subs.filter((s) => s.categoryId === c.id)
      .map((s) => ({ ...s, id: s.id as SubCategoryId, categoryId: s.categoryId as CategoryId })),
  }));
}

type CategoryInput = { nameEn: string; nameAr: string; expiryWarningDays?: number | null | undefined; sortOrder?: number | undefined };

export async function createCategory(ctx: Ctx, input: CategoryInput): Promise<Category> {
  authorize(ctx, 'catalogue.manage_structure');
  const name = bilingualName(input);
  return inTx(ctx, async (tx) => {
    const [row] = await mapUniqueViolations(tx.insert(categories).values({
      ...name, expiryWarningDays: input.expiryWarningDays ?? null, sortOrder: input.sortOrder ?? 0,
      createdBy: ctx.user.id, updatedBy: ctx.user.id,
    }).returning({ id: categories.id }), { categories_name_en_unique: duplicateName });
    if (!row) throw new Error('category insert returned nothing');
    await audit(tx, ctx, { action: 'catalogue.category_created', entityType: 'category', entityId: row.id, after: { ...name, expiryWarningDays: input.expiryWarningDays ?? null } });
    return findCategory(tx, row.id);
  });
}

export async function updateCategory(
  ctx: Ctx, id: string, input: Partial<CategoryInput> & { version: number; isActive?: boolean | undefined },
): Promise<Category> {
  authorize(ctx, 'catalogue.manage_structure');
  return inTx(ctx, async (tx) => {
    const current = await findCategory(tx, id);
    const name = bilingualName({ nameEn: input.nameEn ?? current.nameEn, nameAr: input.nameAr ?? current.nameAr });
    const next = {
      ...name,
      expiryWarningDays: input.expiryWarningDays === undefined ? current.expiryWarningDays : input.expiryWarningDays,
      sortOrder: input.sortOrder ?? current.sortOrder,
      isActive: input.isActive ?? current.isActive,
    };
    const [row] = await mapUniqueViolations(tx.update(categories)
      .set({ ...next, updatedAt: ctx.now, updatedBy: ctx.user.id, version: current.version + 1 })
      .where(and(eq(categories.id, id), eq(categories.version, input.version)))
      .returning({ id: categories.id }), { categories_name_en_unique: duplicateName });
    if (!row) throw new DomainError('VERSION_CONFLICT', { entity: 'category', id });
    await audit(tx, ctx, {
      action: 'catalogue.category_updated', entityType: 'category', entityId: id,
      before: snapshot(current, next), after: next,
    });
    return findCategory(tx, id);
  });
}

type SubCategoryInput = { nameEn: string; nameAr: string; sortOrder?: number | undefined };

export async function createSubCategory(ctx: Ctx, categoryId: string, input: SubCategoryInput): Promise<Category> {
  authorize(ctx, 'catalogue.manage_structure');
  const name = bilingualName(input);
  return inTx(ctx, async (tx) => {
    await findCategory(tx, categoryId);
    const [row] = await mapUniqueViolations(tx.insert(subCategories).values({
      categoryId, ...name, sortOrder: input.sortOrder ?? 0, createdBy: ctx.user.id, updatedBy: ctx.user.id,
    }).returning({ id: subCategories.id }), { sub_categories_name_en_unique: duplicateName });
    if (!row) throw new Error('sub-category insert returned nothing');
    await audit(tx, ctx, { action: 'catalogue.sub_category_created', entityType: 'sub_category', entityId: row.id, after: { categoryId, ...name } });
    return findCategory(tx, categoryId);
  });
}

export async function updateSubCategory(
  ctx: Ctx, id: string, input: Partial<SubCategoryInput> & { version: number; isActive?: boolean | undefined },
): Promise<Category> {
  authorize(ctx, 'catalogue.manage_structure');
  return inTx(ctx, async (tx) => {
    const [current] = await tx.select(subCategoryColumns).from(subCategories).where(eq(subCategories.id, id));
    if (!current) throw new DomainError('NOT_FOUND', { entity: 'sub_category', id });
    const name = bilingualName({ nameEn: input.nameEn ?? current.nameEn, nameAr: input.nameAr ?? current.nameAr });
    const next = { ...name, sortOrder: input.sortOrder ?? current.sortOrder, isActive: input.isActive ?? current.isActive };
    const [row] = await mapUniqueViolations(tx.update(subCategories)
      .set({ ...next, updatedAt: ctx.now, updatedBy: ctx.user.id, version: current.version + 1 })
      .where(and(eq(subCategories.id, id), eq(subCategories.version, input.version)))
      .returning({ id: subCategories.id }), { sub_categories_name_en_unique: duplicateName });
    if (!row) throw new DomainError('VERSION_CONFLICT', { entity: 'sub_category', id });
    await audit(tx, ctx, { action: 'catalogue.sub_category_updated', entityType: 'sub_category', entityId: id, before: snapshot(current, next), after: next });
    return findCategory(tx, current.categoryId);
  });
}

async function findCategory(db: Executor, id: string): Promise<Category> {
  const found = (await loadStructure(db)).find((c) => c.id === id);
  if (!found) throw new DomainError('NOT_FOUND', { entity: 'category', id });
  return found;
}
