'use client';

import { Check, Copy } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { useState } from 'react';
import { Alert, Button } from '@gsa/ui';

/** Shown once, never stored for replay (SECURITY §5). */
export function TemporaryPassword({ value, title }: { value: string; title: string }) {
  const t = useTranslations();
  const [copied, setCopied] = useState(false);
  return (
    <Alert tone="success" className="space-y-2">
      <p className="font-medium">{title}</p>
      <div className="flex flex-wrap items-center gap-3">
        <span className="text-xs text-brand-900">{t('users.temporaryPassword')}</span>
        <code dir="ltr" className="rounded bg-white px-2 py-1 font-mono text-base tracking-wider">{value}</code>
        <Button size="sm" variant="secondary" onClick={() => { void navigator.clipboard.writeText(value); setCopied(true); }}>
          {copied ? <Check className="size-4" aria-hidden /> : <Copy className="size-4" aria-hidden />}
          {copied ? t('common.copied') : t('common.copy')}
        </Button>
      </div>
      <p className="text-xs">{t('users.temporaryPasswordNote')}</p>
    </Alert>
  );
}
