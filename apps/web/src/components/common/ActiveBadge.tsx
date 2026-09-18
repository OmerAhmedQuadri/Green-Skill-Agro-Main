'use client';

import { useTranslations } from 'next-intl';
import { Badge } from '@gsa/ui';

export function ActiveBadge({ active }: { active: boolean }) {
  const t = useTranslations('common');
  return <Badge tone={active ? 'success' : 'neutral'}>{active ? t('active') : t('inactive')}</Badge>;
}
