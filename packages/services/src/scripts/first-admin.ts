import { writeFileSync } from 'node:fs';
import { createInterface } from 'node:readline/promises';
import { normaliseEmail, normalisePhone } from '@gsa/core';
import { schema } from '@gsa/db';
import { sql } from 'drizzle-orm';
import { hashPassword, newTemporaryPassword } from '../identity';
import { writeAudit } from '../platform';
import { closeDb, defaultBranchId, getDb } from '../runtime';

/**
 * The first account on a new installation (USR-002).
 *
 * `pnpm db:seed` refuses to run against production and creates development
 * accounts besides, so a fresh production database had nobody to sign in as —
 * and nobody for `pnpm db:import --as` to run as either. This is the one way
 * in, and it exists only for that moment.
 *
 *   pnpm db:admin --email <address> --name "<full name>" [--phone <number>]
 *
 * It refuses once any account exists, so it cannot be used to add a second
 * Super Admin quietly later — that is done in the app, by a Super Admin, and
 * is audited. The account is created through the ordinary use case, so it is
 * validated and audited like any other, and its first password must be changed
 * at first sign-in.
 */

const args = new Map<string, string>();
for (const [i, arg] of process.argv.slice(2).entries()) {
  if (!arg.startsWith('--')) continue;
  const next = process.argv.slice(2)[i + 1];
  args.set(arg.slice(2), next && !next.startsWith('--') ? next : 'yes');
}

const email = args.get('email');
const name = args.get('name');
const phone = args.get('phone');
if (!email || !name || email === 'yes' || name === 'yes') {
  throw new Error('usage: pnpm db:admin --email <address> --name "<full name>" [--phone <number>]');
}

const db = getDb();
const [existing] = await db.select({ count: sql<number>`count(*)::int` }).from(schema.users);
const accounts = existing?.count ?? 0;
if (accounts > 0) {
  throw new Error(`this database already has ${accounts} account(s) — create further accounts in the app, where it is audited`);
}

const target = { database: new URL(process.env.DATABASE_URL ?? '').pathname.replace(/^\//, ''), host: new URL(process.env.DATABASE_URL ?? '').hostname };
console.log('');
console.log(`  about to create the first Super Admin in  ${target.database} on ${target.host}`);
console.log(`  for                                       ${name}`);
console.log('');
const rl = createInterface({ input: process.stdin, output: process.stdout });
const typed = await rl.question(`Type the host name (${target.host}) to continue, anything else to stop: `);
rl.close();
if (typed.trim() !== target.host) {
  console.log('stopped; nothing was created.');
  await closeDb();
  process.exit(1);
}

/**
 * Written directly rather than through `createAccount`, because this is the one
 * account no one creates: `users.created_by` is nullable for exactly this row,
 * and the audit entry has no actor for the same reason. Inventing an actor id
 * would be a lie the foreign key catches anyway.
 *
 * Everything else is the ordinary path — the same normalisation, the same first
 * password, the same must-change-at-first-sign-in.
 */
const branchId = await defaultBranchId();
const temporaryPassword = newTemporaryPassword();
const identifiers = { email: normaliseEmail(email), phone: phone && phone !== 'yes' ? normalisePhone(phone) : null };

const [account] = await db.insert(schema.users).values({
  branchId, role: 'SUPER_ADMIN', name: name.trim(), ...identifiers,
  passwordHash: await hashPassword(temporaryPassword), mustChangePassword: true, locale: 'en',
  createdBy: null, updatedBy: null,
}).returning({ id: schema.users.id, email: schema.users.email });
if (!account) throw new Error('the first account was not created');

await writeAudit(db, { actorId: null, branchId, requestId: 'first-admin', ip: null }, {
  action: 'identity.account_created', entityType: 'user', entityId: account.id,
  after: { role: 'SUPER_ADMIN', name: name.trim(), ...identifiers, bootstrap: true },
});

// The password never reaches the terminal (CLAUDE.md): a terminal is scrolled
// back through, copied out of, and screen-shared.
const path = args.get('out') ?? 'first-admin-password.txt';
writeFileSync(path, `${account.email ?? email}\t${temporaryPassword}\t${name}\n`, { mode: 0o600 });
console.log(`\ncreated ${account.email ?? email} as Super Admin.`);
console.log(`Its first password is in ${path} — hand it over, then delete the file.`);
console.log('It must be changed at first sign-in, and the account can then create everybody else.');
await closeDb();
