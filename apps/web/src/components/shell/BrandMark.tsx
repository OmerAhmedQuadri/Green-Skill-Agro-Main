import { Sprout } from 'lucide-react';
import { useTranslations } from 'next-intl';

export function BrandMark({ inverse = false, compact = false }: { inverse?: boolean; compact?: boolean }) {
  const t = useTranslations('app');
  return (
    <div className="flex items-center gap-2.5">
      <span className={`grid size-9 place-items-center rounded-lg ${inverse ? 'bg-white/10 text-white' : 'bg-brand-800 text-white'}`}>
        <Sprout className="size-5" aria-hidden />
      </span>
      <span className="leading-tight">
        <span className={`block text-sm font-semibold ${inverse ? 'text-white' : 'text-stone-900'}`}>{t('name')}</span>
        {compact ? null : <span className={`block text-xs ${inverse ? 'text-brand-100' : 'text-stone-500'}`}>{t('tagline')}</span>}
      </span>
    </div>
  );
}
