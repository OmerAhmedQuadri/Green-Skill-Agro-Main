import type { DomainError } from '@gsa/core';
import { describe, expect, it } from 'vitest';
import { anAccount, ctxFor } from '../../test/factories';
import { ownerQuery } from '../../test/db';
import { audit } from './audit';
import { runIdempotent } from './idempotency';

describe('idempotent mutations (ADR-0009, NFR-006)', () => {
  it('NFR-006: a retried request runs once and replays the stored response', async () => {
    const ctx = await ctxFor(await anAccount('SELLER'));
    let runs = 0;
    const work = async (c: typeof ctx) => {
      runs += 1;
      if (!c.tx) throw new Error('work must join the idempotency transaction');
      await audit(c.tx, c, { action: 'test.mutation', entityType: 'test' });
      return { status: 201, body: { run: runs } };
    };
    const first = await runIdempotent(ctx, { key: 'k-1', hash: 'h' }, work);
    const retry = await runIdempotent(ctx, { key: 'k-1', hash: 'h' }, work);
    expect(runs).toBe(1);
    expect(first).toEqual({ status: 201, body: { run: 1 }, replayed: false });
    expect(retry).toEqual({ status: 201, body: { run: 1 }, replayed: true });
    expect(await ownerQuery("select 1 from audit_log where action = 'test.mutation'")).toHaveLength(1);
  });

  it('NFR-006: two simultaneous requests with one key still run once', async () => {
    const ctx = await ctxFor(await anAccount('SELLER'));
    let runs = 0;
    const slow = async () => {
      runs += 1;
      await new Promise((r) => setTimeout(r, 300));
      return { status: 201, body: { ok: true } };
    };
    const [a, b] = await Promise.all([
      runIdempotent(ctx, { key: 'k-2', hash: 'h' }, slow),
      runIdempotent(ctx, { key: 'k-2', hash: 'h' }, slow),
    ]);
    expect(runs).toBe(1);
    expect([a.replayed, b.replayed].sort()).toEqual([false, true]);
  });

  it('reusing a key for a different request is refused', async () => {
    const ctx = await ctxFor(await anAccount('SELLER'));
    const work = () => Promise.resolve({ status: 201, body: {} });
    await runIdempotent(ctx, { key: 'k-3', hash: 'body-a' }, work);
    const refused = await runIdempotent(ctx, { key: 'k-3', hash: 'body-b' }, work).then(() => 'NO_ERROR', (e: DomainError) => e.code);
    expect(refused).toBe('IDEMPOTENCY_KEY_REUSED');
  });

  it('a failed attempt leaves no key behind, so the retry runs afresh', async () => {
    const ctx = await ctxFor(await anAccount('SELLER'));
    await runIdempotent(ctx, { key: 'k-4', hash: 'h' }, () => Promise.reject(new Error('transient'))).catch(() => undefined);
    const retry = await runIdempotent(ctx, { key: 'k-4', hash: 'h' }, () => Promise.resolve({ status: 201, body: { ok: 1 } }));
    expect(retry.replayed).toBe(false);
  });
});
