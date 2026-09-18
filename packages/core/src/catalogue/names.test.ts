import { describe, expect, it } from 'vitest';
import { type DomainError } from '../errors';
import { countryCode, COUNTRY_CODES } from './countries';
import { bilingualName } from './names';

const code = (fn: () => unknown) => { try { fn(); return 'NO_ERROR'; } catch (e) { return (e as DomainError).code; } };

describe('names and countries', () => {
  it('CAT-004: a name is held in English and Arabic, whitespace collapsed', () => {
    expect(bilingualName({ nameEn: '  Okra   F1 ', nameAr: ' بامية ' })).toEqual({ nameEn: 'Okra F1', nameAr: 'بامية' });
    expect(code(() => bilingualName({ nameEn: 'Okra', nameAr: '   ' }))).toBe('INVALID_NAME');
  });

  it('CAT-005: country of origin is an ISO 3166-1 code', () => {
    expect(COUNTRY_CODES).toHaveLength(249);
    expect(countryCode(' in ')).toBe('IN');
    expect(code(() => countryCode('Holland'))).toBe('INVALID_COUNTRY');
    expect(code(() => countryCode('EU'))).toBe('INVALID_COUNTRY');
  });
});
