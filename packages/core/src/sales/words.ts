import { dec, type Money } from '../numeric';

/**
 * DOC-008 (ADR-0053): the total in words, as Saudi commercial papers write it —
 * in English, and in Arabic with the counted nouns agreeing with their
 * numbers (riyal is masculine, halala feminine). Up to 999,999,999.99.
 */
export function amountInWords(amount: Money, language: 'en' | 'ar'): string {
  const value = dec(amount);
  if (value.isNegative() || value.gte(1_000_000_000)) throw new RangeError(`amount out of range: ${amount}`);
  const riyals = value.floor().toNumber();
  const halalas = value.minus(value.floor()).times(100).toDecimalPlaces(0).toNumber();
  return language === 'en' ? english(riyals, halalas) : arabic(riyals, halalas);
}

// ---------------------------------------------------------------- English

const EN_ONES = [
  '', 'ONE', 'TWO', 'THREE', 'FOUR', 'FIVE', 'SIX', 'SEVEN', 'EIGHT', 'NINE', 'TEN',
  'ELEVEN', 'TWELVE', 'THIRTEEN', 'FOURTEEN', 'FIFTEEN', 'SIXTEEN', 'SEVENTEEN', 'EIGHTEEN', 'NINETEEN',
];
const EN_TENS = ['', '', 'TWENTY', 'THIRTY', 'FORTY', 'FIFTY', 'SIXTY', 'SEVENTY', 'EIGHTY', 'NINETY'];

function enBelow100(n: number): string {
  if (n < 20) return EN_ONES[n] ?? '';
  const unit = n % 10;
  return `${EN_TENS[Math.floor(n / 10)] ?? ''}${unit ? `-${EN_ONES[unit] ?? ''}` : ''}`;
}

function enBelow1000(n: number): string {
  const hundreds = Math.floor(n / 100);
  const rest = n % 100;
  const head = hundreds ? `${EN_ONES[hundreds] ?? ''} HUNDRED` : '';
  if (!rest) return head;
  return head ? `${head} AND ${enBelow100(rest)}` : enBelow100(rest);
}

function enNumber(n: number): string {
  if (n === 0) return 'ZERO';
  const parts: string[] = [];
  for (const [size, name] of [[1_000_000, 'MILLION'], [1_000, 'THOUSAND']] as const) {
    if (n >= size) {
      parts.push(`${enBelow1000(Math.floor(n / size))} ${name}`);
      n %= size;
    }
  }
  // British usage: "two thousand and four" — "and" before a last part under a hundred.
  if (n) parts.push(parts.length && n < 100 ? `AND ${enBelow100(n)}` : enBelow1000(n));
  return parts.join(' ');
}

function english(riyals: number, halalas: number): string {
  const r = `${enNumber(riyals)} SAUDI ${riyals === 1 ? 'RIYAL' : 'RIYALS'}`;
  if (!halalas) return r;
  const h = `${enNumber(halalas)} ${halalas === 1 ? 'HALALA' : 'HALALAS'}`;
  return riyals ? `${r} AND ${h}` : h;
}

// ---------------------------------------------------------------- Arabic

type Gender = 'm' | 'f';
const AR_UNITS: Record<Gender, readonly string[]> = {
  m: ['', 'واحد', 'اثنان', 'ثلاثة', 'أربعة', 'خمسة', 'ستة', 'سبعة', 'ثمانية', 'تسعة', 'عشرة'],
  f: ['', 'واحدة', 'اثنتان', 'ثلاث', 'أربع', 'خمس', 'ست', 'سبع', 'ثماني', 'تسع', 'عشر'],
};
/** A unit before "و" and the tens: "إحدى وعشرون", "ثمان وستون". */
const AR_COMPOUND_UNITS: Record<Gender, readonly string[]> = {
  m: ['', 'واحد', 'اثنان', 'ثلاثة', 'أربعة', 'خمسة', 'ستة', 'سبعة', 'ثمانية', 'تسعة'],
  f: ['', 'إحدى', 'اثنتان', 'ثلاث', 'أربع', 'خمس', 'ست', 'سبع', 'ثمان', 'تسع'],
};
const AR_TEENS: Record<Gender, readonly string[]> = {
  m: ['أحد عشر', 'اثنا عشر', 'ثلاثة عشر', 'أربعة عشر', 'خمسة عشر', 'ستة عشر', 'سبعة عشر', 'ثمانية عشر', 'تسعة عشر'],
  f: ['إحدى عشرة', 'اثنتا عشرة', 'ثلاث عشرة', 'أربع عشرة', 'خمس عشرة', 'ست عشرة', 'سبع عشرة', 'ثماني عشرة', 'تسع عشرة'],
};
const AR_TENS = ['', '', 'عشرون', 'ثلاثون', 'أربعون', 'خمسون', 'ستون', 'سبعون', 'ثمانون', 'تسعون'];
const AR_HUNDREDS = ['', 'مائة', 'مائتان', 'ثلاثمائة', 'أربعمائة', 'خمسمائة', 'ستمائة', 'سبعمائة', 'ثمانمائة', 'تسعمائة'];

function arBelow100(n: number, g: Gender): string {
  if (n <= 10) return AR_UNITS[g][n] ?? '';
  if (n < 20) return AR_TEENS[g][n - 11] ?? '';
  const unit = n % 10;
  const tens = AR_TENS[Math.floor(n / 10)] ?? '';
  return unit ? `${AR_COMPOUND_UNITS[g][unit] ?? ''} و${tens}` : tens;
}

/** `beforeNoun`: two hundred in construct with what it counts ("مائتا ألف"). */
function arBelow1000(n: number, g: Gender, beforeNoun = false): string {
  const hundreds = Math.floor(n / 100);
  const rest = n % 100;
  const head = hundreds === 2 && !rest && beforeNoun ? 'مائتا' : (AR_HUNDREDS[hundreds] ?? '');
  if (!rest) return head;
  return head ? `${head} و${arBelow100(rest, g)}` : arBelow100(rest, g);
}

/**
 * A count of thousands or millions, the noun agreeing: one, two (dual), three
 * to ten (plural), eleven to ninety-nine (singular, accusative — unless the
 * counted noun follows at once: "خمسة عشر ألف ريال"), otherwise singular — by
 * the count's last two digits.
 */
function arScale(count: number, forms: { one: string; two: string; plural: string; accusative: string }, nounFollows: boolean): string {
  if (count === 1) return forms.one;
  if (count === 2) return forms.two;
  const last = count % 100;
  if (last >= 3 && last <= 10) return `${arBelow1000(count, 'm')} ${forms.plural}`;
  if (last >= 11) return `${arBelow1000(count, 'm')} ${nounFollows ? forms.one : forms.accusative}`;
  return `${arBelow1000(count, 'm', true)} ${forms.one}`;
}

function arNumber(n: number, g: Gender): string {
  const parts: string[] = [];
  const millions = Math.floor(n / 1_000_000);
  const thousands = Math.floor((n % 1_000_000) / 1_000);
  const rest = n % 1_000;
  if (millions) parts.push(arScale(millions, { one: 'مليون', two: 'مليونان', plural: 'ملايين', accusative: 'مليونًا' }, !thousands && !rest));
  if (thousands) parts.push(arScale(thousands, { one: 'ألف', two: 'ألفان', plural: 'آلاف', accusative: 'ألفًا' }, !rest));
  if (rest) parts.push(arBelow1000(rest, g));
  return parts.join(' و');
}

/** The counted noun, by the number's last two digits — "ريالات" for 3–10, "ريالًا" for 11–99. */
function arCounted(n: number, g: Gender, forms: { one: string; two: string; plural: string; accusative: string; singular: string }): string {
  if (n === 1) return forms.one;
  if (n === 2) return forms.two;
  const last = n % 100;
  const words = arNumber(n, g);
  if (last >= 3 && last <= 10) return `${words} ${forms.plural}`;
  if (last >= 11) return `${words} ${forms.accusative}`;
  return `${words} ${forms.singular}`;
}

function arabic(riyals: number, halalas: number): string {
  const parts: string[] = [];
  if (riyals || !halalas) {
    parts.push(riyals === 0 ? 'صفر ريال سعودي' : arCounted(riyals, 'm', {
      one: 'ريال سعودي واحد', two: 'ريالان سعوديان', plural: 'ريالات سعودية', accusative: 'ريالًا سعوديًا', singular: 'ريال سعودي',
    }));
  }
  if (halalas) {
    parts.push(arCounted(halalas, 'f', { one: 'هللة واحدة', two: 'هللتان', plural: 'هللات', accusative: 'هللة', singular: 'هللة' }));
  }
  return `فقط ${parts.join(' و')} لا غير`;
}
