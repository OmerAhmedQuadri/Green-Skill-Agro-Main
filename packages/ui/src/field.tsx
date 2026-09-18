import type { ComponentProps, ReactNode } from 'react';
import { cn } from './cn';

const control =
  'block w-full rounded-md border border-stone-300 bg-white px-3 text-sm text-stone-900 shadow-xs placeholder:text-stone-400 focus:border-brand-600 focus:outline-2 focus:outline-brand-600/30 aria-invalid:border-red-600 disabled:bg-stone-100';

export function Input({ className, ...props }: ComponentProps<'input'>) {
  return <input className={cn(control, 'h-11', className)} {...props} />;
}

export function Select({ className, ...props }: ComponentProps<'select'>) {
  return <select className={cn(control, 'h-11', className)} {...props} />;
}

/** Label + control + error, wired for assistive technology. */
export function Field({
  id, label, error, hint, children,
}: { id: string; label: ReactNode; error?: ReactNode; hint?: ReactNode; children: ReactNode }) {
  return (
    <div className="space-y-1.5">
      <label htmlFor={id} className="block text-sm font-medium text-stone-800">{label}</label>
      {children}
      {hint && !error ? <p className="text-xs text-stone-500">{hint}</p> : null}
      {error ? <p id={`${id}-error`} role="alert" className="text-xs text-red-700">{error}</p> : null}
    </div>
  );
}

// React 19: `ref` is an ordinary prop, carried by ComponentProps.
export function Checkbox({ className, ...props }: Omit<ComponentProps<'input'>, 'type'>) {
  return <input type="checkbox" className={cn('size-4 rounded border-stone-400 accent-brand-700', className)} {...props} />;
}
