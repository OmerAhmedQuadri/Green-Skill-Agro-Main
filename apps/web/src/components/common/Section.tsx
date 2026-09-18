import type { ReactNode } from 'react';
import { Card, CardHeader } from '@gsa/ui';

export function Section({ title, description, actions, children, id }: {
  title: ReactNode; description?: ReactNode; actions?: ReactNode; children: ReactNode; id?: string;
}) {
  return (
    <Card id={id}>
      <CardHeader title={title} description={description} actions={actions} />
      {children}
    </Card>
  );
}

/** A read-only label/value list. */
export function Facts({ items }: { items: { label: ReactNode; value: ReactNode }[] }) {
  return (
    <dl className="grid gap-x-6 gap-y-4 p-5 sm:grid-cols-2">
      {items.map((item, i) => (
        <div key={i}>
          <dt className="text-xs font-medium uppercase tracking-wide text-stone-500">{item.label}</dt>
          <dd className="mt-1 text-sm text-stone-900">{item.value}</dd>
        </div>
      ))}
    </dl>
  );
}
