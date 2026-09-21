import { parse, TYPE, type MessageFormatElement } from '@formatjs/icu-messageformat-parser';
import { expect, test } from '@playwright/test';
import ar from '../src/messages/ar.json' with { type: 'json' };
import en from '../src/messages/en.json' with { type: 'json' };

/**
 * I18N-004: the interface's Arabic lives entirely in the message files, so it
 * can be corrected without touching code.
 *
 * A missing Arabic key is already a compile error (`src/i18n/messages.ts` types
 * Arabic against English), which is stronger than a test. What nothing catches
 * is a translation that drops an argument: both are strings, both parse, and
 * the screen renders "left for" with no name in it.
 *
 * These are data assertions with no page, which is why they sit apart from the
 * workflows. They run in the same suite because that is where the messages are
 * already imported and checked in CI.
 */

type Leaf = { key: string; value: string };

function leaves(node: unknown, prefix = '', found: Leaf[] = []): Leaf[] {
  for (const [key, value] of Object.entries(node as Record<string, unknown>)) {
    const path = prefix ? `${prefix}.${key}` : key;
    if (typeof value === 'string') found.push({ key: path, value });
    else if (value && typeof value === 'object') leaves(value, path, found);
  }
  return found;
}

/**
 * The names a message expects to be given, from the parsed message rather than
 * a pattern over the text — the text of a plural or select branch is full of
 * words in braces that are not arguments at all.
 */
const TAKES_AN_ARGUMENT: readonly TYPE[] = [TYPE.argument, TYPE.number, TYPE.date, TYPE.time, TYPE.select, TYPE.plural];

function argumentsOf(message: string): string[] {
  const names = new Set<string>();
  const walk = (elements: MessageFormatElement[]) => {
    for (const element of elements) {
      // A tag's value is its name and a literal's is its text; neither is asked for.
      if (TAKES_AN_ARGUMENT.includes(element.type) && 'value' in element) names.add(String(element.value));
      if ('options' in element) for (const option of Object.values(element.options)) walk(option.value);
      if ('children' in element) walk(element.children);
    }
  };
  walk(parse(message));
  return [...names].sort();
}

test.describe('interface messages (I18N-001, I18N-004)', () => {
  const english = leaves(en);
  const arabic = new Map(leaves(ar).map((l) => [l.key, l.value]));

  test('I18N-004: every Arabic message takes the same arguments as its English', () => {
    const mismatched = english
      .map(({ key, value }) => ({ key, en: argumentsOf(value), ar: argumentsOf(arabic.get(key) ?? '') }))
      .filter((m) => m.en.join() !== m.ar.join());
    // Named rather than counted: a dropped argument renders as a gap on screen,
    // and the key is what someone needs to go and fix it.
    expect(mismatched.map((m) => `${m.key}: en(${m.en.join()}) ar(${m.ar.join()})`)).toEqual([]);
  });

  test('I18N-004: every message is valid ICU in both languages', () => {
    const broken: string[] = [];
    for (const { key, value } of english) {
      for (const [locale, text] of [['en', value], ['ar', arabic.get(key) ?? '']] as const) {
        try { parse(text); } catch (error) { broken.push(`${key} (${locale}): ${String(error).slice(0, 80)}`); }
      }
    }
    expect(broken).toEqual([]);
  });

  test('I18N-001: the two files hold the same keys', () => {
    expect(english.map((l) => l.key).filter((k) => !arabic.has(k))).toEqual([]);
    expect([...arabic.keys()].filter((k) => !english.some((l) => l.key === k))).toEqual([]);
  });
});
