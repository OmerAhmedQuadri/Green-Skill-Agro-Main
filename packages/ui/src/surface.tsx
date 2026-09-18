import type { HTMLAttributes, ReactNode } from 'react';
import { cn } from './cn';

export function Card({ className, ...props }: HTMLAttributes<HTMLDivElement>) {
  return <div className={cn('rounded-lg border border-stone-200 bg-white shadow-xs', className)} {...props} />;
}

export function CardHeader({ title, description, actions }: { title: ReactNode; description?: ReactNode; actions?: ReactNode }) {
  return (
    <div className="flex flex-wrap items-start justify-between gap-3 border-b border-stone-200 px-5 py-4">
      <div>
        <h2 className="text-base font-semibold text-stone-900">{title}</h2>
        {description ? <p className="mt-0.5 text-sm text-stone-500">{description}</p> : null}
      </div>
      {actions}
    </div>
  );
}

const tones = {
  neutral: 'bg-stone-100 text-stone-700',
  success: 'bg-brand-50 text-brand-800',
  warning: 'bg-amber-50 text-amber-800',
  danger: 'bg-red-50 text-red-800',
} as const;

export function Badge({ tone = 'neutral', className, ...props }: HTMLAttributes<HTMLSpanElement> & { tone?: keyof typeof tones }) {
  return <span className={cn('inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium', tones[tone], className)} {...props} />;
}

export function Alert({ tone = 'danger', className, ...props }: HTMLAttributes<HTMLDivElement> & { tone?: 'danger' | 'warning' | 'success' | 'info' }) {
  const styles = {
    danger: 'border-red-200 bg-red-50 text-red-800',
    warning: 'border-amber-200 bg-amber-50 text-amber-900',
    success: 'border-brand-200 bg-brand-50 text-brand-900',
    info: 'border-stone-200 bg-stone-50 text-stone-800',
  }[tone];
  return <div role={tone === 'danger' ? 'alert' : 'status'} className={cn('rounded-md border px-4 py-3 text-sm', styles, className)} {...props} />;
}
