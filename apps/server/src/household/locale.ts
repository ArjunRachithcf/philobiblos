// The household's locale (PHILOBIBLOS_LOCALE, philobiblos#60) and the words that come with a language. None of them is
// a core constant: the order letter (one file a language) and the delivery-address filter's words (address.json, by
// language and by region) are data in the repository's locales/. A language without a letter is English's; a locale
// without address words has English's. No imports but the data, so config.ts and mail/read.ts can read it.
import ADDRESS from '../../../../locales/address.json';
import de from '../../../../locales/de.json';
import en from '../../../../locales/en.json';

/** The order letter in one language: its month names and texts; `{name}` is filled in, nothing else is read. */
export interface Letter {
  language: string;
  months: string[];
  /** {month} {year} */
  subject: string;
  greeting: string;
  one: string;
  /** {count} */
  many: string;
  /** {isbn} */
  isbn: string;
  sendTo: string;
  quote: string;
  thanks: string;
  /** What the Compose link carries when the order is too long for it. */
  tooLong: string;
}

const TEXTS = ['greeting', 'one', 'sendTo', 'quote', 'thanks', 'tooLong'] as const;
const NEEDS: Partial<Record<keyof Letter, string[]>> = { subject: ['month', 'year'], many: ['count'], isbn: ['isbn'] };

/** A letter as Philobiblos takes it: every text, 12 month names, and each placeholder its text needs. Throws otherwise. */
export function checkLetter(l: Letter): Letter {
  const bad = (why: string) => new Error(`the ${String(l?.language).slice(0, 20)} order letter: ${why}`);
  if (typeof l?.language !== 'string' || !/^[a-z]{2,3}$/.test(l.language)) throw bad('language: a lower-case ISO 639 code');
  if (!Array.isArray(l.months) || l.months.length !== 12 || l.months.some((m) => typeof m !== 'string' || !/^\p{L}+$/u.test(m))) throw bad('months: the 12 month names, letters only');
  for (const k of [...TEXTS, ...Object.keys(NEEDS) as (keyof Letter)[]]) {
    const v = l[k];
    if (typeof v !== 'string' || !v.trim() || /[\r\n]/.test(v)) throw bad(`${k}: one line of text`);
    for (const p of NEEDS[k] ?? []) if (!v.includes(`{${p}}`)) throw bad(`${k}: needs {${p}}`);
  }
  return l;
}

/** The letters that ship, by language. */
export const LETTERS: Readonly<Record<string, Letter>> = Object.freeze(Object.fromEntries([en, de].map((l) => [l.language, checkLetter(l)])));

/** A text with its `{name}`s filled in: one pass, so a value is never read again (a title holding `{count}` or `$&`). */
export const fill = (text: string, values: Record<string, string | number>) =>
  text.replace(/\{([a-z]+)\}/g, (all, k: string) => (Object.hasOwn(values, k) ? String(values[k]) : all));

/** A tag's language and region, canonical; null when it is not a BCP 47 tag. */
export function parseLocale(tag: string | null | undefined): { tag: string; language: string; region: string | null } | null {
  if (typeof tag !== 'string' || !tag.trim() || tag.length > 64) return null;
  try {
    const canonical = Intl.getCanonicalLocales(tag.trim())[0]!;
    const l = new Intl.Locale(canonical);
    return { tag: canonical, language: l.language, region: l.region ?? null };
  } catch { return null; }
}

/**
 * The letter Compose writes: in the bookshop connector's language, else the household's, else English. A language
 * Philobiblos has no letter in counts for nothing (the next one is tried).
 */
export function letterFor(o: { connector?: string | null; household?: string | null }): Letter {
  for (const tag of [o.connector, o.household]) {
    const l = parseLocale(tag);
    if (l && Object.hasOwn(LETTERS, l.language)) return LETTERS[l.language]!;
  }
  return LETTERS.en!;
}

/**
 * The enabled connector a letter to this address goes to: the one whose order address it is, else the one whose mail
 * domain it is at (an admin's own address at the shop). None: the household's language.
 */
export function letterShop<E extends { id: string; connector: { order?: { to: string }; mail?: { domains: string[] } } }>(to: string | null, enabled: E[]): E | null {
  if (!to) return null;
  const addr = to.toLowerCase();
  const domain = addr.slice(addr.lastIndexOf('@') + 1);
  return enabled.find((e) => e.connector.order?.to.toLowerCase() === addr)
    ?? enabled.find((e) => (e.connector.mail?.domains ?? []).some((d) => d.toLowerCase() === domain)) ?? null;
}

interface AddressData { same: { as: string; words: string[]; endings: string[] }[]; common: Record<string, string[]>; regions: Record<string, string[]> }

/** The address words as the filter takes them: lower-case ASCII letters for what builds its patterns, letters for the rest. */
function checkAddress(a: AddressData): AddressData {
  const ascii = (w: unknown) => typeof w === 'string' && /^[a-z]{2,40}$/.test(w);
  const letters = (w: unknown) => typeof w === 'string' && /^\p{Ll}{2,40}$/u.test(w);
  for (const g of a.same) if (!ascii(g.as) || !g.words.every(ascii) || !g.endings.every(ascii)) throw new Error('locales/address.json: same: lower-case ASCII words');
  for (const ws of [...Object.values(a.common), ...Object.values(a.regions)]) if (!ws.every(letters)) throw new Error('locales/address.json: lower-case words');
  return a;
}
const WORDS = checkAddress(ADDRESS);

/** Spellings that are compared as one word (`as`), whole or as a word's ending: every locale's, whatever the household's. */
export const SAME_WORDS: readonly { as: string; words: readonly string[]; endings: readonly string[] }[] = WORDS.same;

/**
 * The words of an address too common to drop a field for on their own, for the household's locale: each compared
 * spelling, its language's street words (English's when it has none or no locale is set) and its region's country names.
 */
export function commonAddressWords(locale: string | null): Set<string> {
  const l = parseLocale(locale);
  const lang = l && Object.hasOwn(WORDS.common, l.language) ? l.language : 'en';
  const region = l?.region && Object.hasOwn(WORDS.regions, l.region) ? WORDS.regions[l.region]! : [];
  return new Set([...WORDS.same.map((g) => g.as), ...(WORDS.common[lang] ?? []), ...region]);
}
