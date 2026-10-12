'use client';

import { BRAND_MARK } from '@gsa/core';
import { Sprout } from 'lucide-react';
import Image from 'next/image';
import { useTranslations } from 'next-intl';
import { useEffect, useRef, useState } from 'react';
import emblem from './brand/emblem.webp';
import logo from './brand/logo.webp';

/**
 * ADR-0057: Green Agro's mark. On a page of its own — signing in, a file — the
 * full logo, both names in it; in the console's green bar, its emblem in a
 * white circle beside the name; in the phone's header, the emblem beside the
 * name. The sprout symbol takes its place when switched back (`BRAND_MARK`),
 * or when the file cannot be shown.
 */
export function BrandMark({ inverse = false, compact = false }: { inverse?: boolean; compact?: boolean }) {
  const t = useTranslations('app');
  const [failed, setFailed] = useState(false);
  const image = useRef<HTMLImageElement>(null);
  // An image that failed before the page came to life raised its error unheard.
  useEffect(() => {
    if (image.current?.complete && image.current.naturalWidth === 0) setFailed(true);
  }, []);
  const showLogo = BRAND_MARK === 'LOGO' && !failed;

  if (showLogo && !inverse && !compact) {
    return (
      <Image ref={image} src={logo} alt={t('name')} unoptimized loading="eager" onError={() => setFailed(true)}
        className="h-20 w-auto" data-testid="brand-logo" />
    );
  }
  return (
    <div className="flex items-center gap-2.5">
      {showLogo ? (
        <span className={`grid size-9 shrink-0 place-items-center overflow-hidden rounded-full bg-white ${inverse ? '' : 'ring-1 ring-stone-200'}`}>
          {/* eslint-disable-next-line no-restricted-syntax -- an empty alt is no text: the emblem is decorative, its name stands beside it */}
          <Image ref={image} src={emblem} alt="" unoptimized loading="eager" onError={() => setFailed(true)} className="size-8" data-testid="brand-emblem" />
        </span>
      ) : (
        <span className={`grid size-9 place-items-center rounded-lg ${inverse ? 'bg-white/10 text-white' : 'bg-brand-800 text-white'}`} data-testid="brand-symbol">
          <Sprout className="size-5" aria-hidden />
        </span>
      )}
      <span className="leading-tight">
        <span className={`block text-sm font-semibold ${inverse ? 'text-white' : 'text-stone-900'}`}>{t('name')}</span>
        {compact ? null : <span className={`block text-xs ${inverse ? 'text-brand-100' : 'text-stone-500'}`}>{t('tagline')}</span>}
      </span>
    </div>
  );
}
