'use client';

import { useInfiniteQuery } from '@tanstack/react-query';
import { Plus, Search } from 'lucide-react';
import Link from 'next/link';
import { useTranslations } from 'next-intl';
import { useDeferredValue, useState } from 'react';
import { Alert, Badge, Button, Card, CardHeader, Input, Select } from '@gsa/ui';
import { api } from '@/lib/api';
import { useErrorText } from '@/lib/hooks';
import { CreateAccountForm } from './CreateAccountForm';
import type { Account, Role } from './types';

type Page = { items: Account[]; nextCursor: string | null };

export function UsersPage({ roles }: { roles: Role[] }) {
  const t = useTranslations();
  const errorText = useErrorText();
  const [search, setSearch] = useState('');
  const [role, setRole] = useState('');
  const [status, setStatus] = useState('');
  const [creating, setCreating] = useState(false);
  const query = useDeferredValue(search);

  const list = useInfiniteQuery({
    queryKey: ['users', { query, role, status }],
    initialPageParam: '',
    queryFn: ({ pageParam }) => {
      const qs = new URLSearchParams({ limit: '50' });
      if (query) qs.set('search', query);
      if (role) qs.set('role', role);
      if (status) qs.set('status', status);
      if (pageParam) qs.set('cursor', pageParam);
      return api<Page>(`/users?${qs.toString()}`);
    },
    getNextPageParam: (last) => last.nextCursor ?? undefined,
  });
  const rows = list.data?.pages.flatMap((p) => p.items) ?? [];

  return (
    <div className="mx-auto max-w-6xl space-y-6">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold">{t('users.title')}</h1>
          <p className="mt-1 text-sm text-stone-500">{t('users.subtitle')}</p>
        </div>
        {!creating ? <Button onClick={() => setCreating(true)}><Plus className="size-4" aria-hidden />{t('users.newAccount')}</Button> : null}
      </div>

      {creating ? (
        <Card>
          <CardHeader title={t('users.newAccount')} />
          <div className="p-5"><CreateAccountForm roles={roles} onDone={() => setCreating(false)} /></div>
        </Card>
      ) : null}

      <Card>
        <div className="flex flex-wrap gap-3 border-b border-stone-200 p-4">
          <div className="relative min-w-56 flex-1">
            <Search className="pointer-events-none absolute start-3 top-1/2 size-4 -translate-y-1/2 text-stone-400" aria-hidden />
            <Input value={search} onChange={(e) => setSearch(e.target.value)} placeholder={t('users.searchPlaceholder')} aria-label={t('common.search')} className="ps-9" />
          </div>
          <Select value={role} onChange={(e) => setRole(e.target.value)} aria-label={t('users.filterRole')} className="w-auto">
            <option value="">{t('users.allRoles')}</option>
            {roles.map((r) => <option key={r} value={r}>{t(`roles.${r}`)}</option>)}
          </Select>
          <Select value={status} onChange={(e) => setStatus(e.target.value)} aria-label={t('users.filterStatus')} className="w-auto">
            <option value="">{t('users.allStatuses')}</option>
            <option value="ACTIVE">{t('status.ACTIVE')}</option>
            <option value="DEACTIVATED">{t('status.DEACTIVATED')}</option>
          </Select>
        </div>

        {list.error ? <div className="p-4"><Alert>{errorText(list.error)}</Alert></div> : null}
        {list.isPending ? <p className="p-5 text-sm text-stone-500">{t('common.loading')}</p> : null}
        {!list.isPending && rows.length === 0 ? <p className="p-5 text-sm text-stone-500">{t('users.empty')}</p> : null}

        {rows.length > 0 ? (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="bg-stone-50 text-start text-xs uppercase tracking-wide text-stone-500">
                <tr>
                  <th className="px-4 py-2.5 text-start font-medium">{t('users.colName')}</th>
                  <th className="px-4 py-2.5 text-start font-medium">{t('users.colRole')}</th>
                  <th className="px-4 py-2.5 text-start font-medium">{t('users.colContact')}</th>
                  <th className="px-4 py-2.5 text-start font-medium">{t('users.colStatus')}</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-stone-100">
                {rows.map((u) => (
                  <tr key={u.id} className="hover:bg-stone-50">
                    <td className="px-4 py-3">
                      <Link href={`/console/users/${u.id}`} className="font-medium text-brand-800 hover:underline">{u.name}</Link>
                    </td>
                    <td className="px-4 py-3">{t(`roles.${u.role}`)}</td>
                    <td className="px-4 py-3 text-stone-600"><bdi dir="ltr">{u.email ?? u.phone}</bdi></td>
                    <td className="px-4 py-3">
                      <Badge tone={u.status === 'ACTIVE' ? 'success' : 'neutral'}>{t(`status.${u.status}`)}</Badge>
                      {u.mustChangePassword ? <Badge tone="warning" className="ms-2">{t('users.mustChangeBadge')}</Badge> : null}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : null}

        {list.hasNextPage ? (
          <div className="border-t border-stone-200 p-3 text-center">
            <Button variant="ghost" onClick={() => void list.fetchNextPage()} disabled={list.isFetchingNextPage}>{t('users.loadMore')}</Button>
          </div>
        ) : null}
      </Card>
    </div>
  );
}
