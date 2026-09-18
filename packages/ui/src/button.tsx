import { cva, type VariantProps } from 'class-variance-authority';
import type { ButtonHTMLAttributes } from 'react';
import { cn } from './cn';

const button = cva(
  'inline-flex items-center justify-center gap-2 rounded-md font-medium transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand-600 disabled:pointer-events-none disabled:opacity-50',
  {
    variants: {
      variant: {
        primary: 'bg-brand-800 text-white hover:bg-brand-900',
        secondary: 'border border-stone-300 bg-white text-stone-800 hover:bg-stone-50',
        ghost: 'text-stone-700 hover:bg-stone-100',
        danger: 'bg-red-700 text-white hover:bg-red-800',
      },
      // Touch targets ≥ 44 px on the field app (CONVENTIONS §7).
      size: { sm: 'h-9 px-3 text-sm', md: 'h-11 px-4 text-sm', lg: 'h-12 px-5 text-base' },
      block: { true: 'w-full' },
    },
    defaultVariants: { variant: 'primary', size: 'md' },
  },
);

export type ButtonProps = ButtonHTMLAttributes<HTMLButtonElement> & VariantProps<typeof button>;

export function Button({ className, variant, size, block, type = 'button', ...props }: ButtonProps) {
  return <button type={type} className={cn(button({ variant, size, block }), className)} {...props} />;
}
