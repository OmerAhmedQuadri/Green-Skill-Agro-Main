import type { Messages } from './i18n/messages';

// Every t('…') key is checked against en.json at compile time.
declare module 'next-intl' {
  interface AppConfig {
    Messages: Messages;
    Locale: 'en' | 'ar';
  }
}
