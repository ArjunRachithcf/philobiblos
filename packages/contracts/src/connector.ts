// A bookshop as data (contracts/connector.schema.json, contracts/connectors.md): its type and its strict validator.
import { Ajv2020 } from 'ajv/dist/2020.js';
import connectorSchema from '../../../contracts/connector.schema.json' with { type: 'json' };

export const CONNECTOR_SCHEMA = connectorSchema;

type Phrases = string[];
export interface Connector {
  schema: 1;
  id: string;
  name: string;
  locale: { currency: string; language: string };
  /** `decimal`, `groups`: how its amounts are written (contracts/connector.schema.json; philobiblos#62). */
  money: { before: string[]; after: string[]; decimal?: '.' | ','; groups?: (',' | '.' | "'" | ' ')[] };
  mail?: {
    domains: string[];
    dkim_domains?: string[];
    /** schema.org Order and Invoice markup in its signed mail counts (philobiblos#27). */
    markup?: boolean;
    reply?: { separators: Phrases; header_labels: Phrases; attribution_starts: Phrases; attribution_verbs: Phrases };
    summary?: string[];
    unavailable?: Phrases;
    quote?: {
      senders: string[];
      labels: { author: Phrases; title: Phrases; isbn: Phrases; price: Phrases; delivery: Phrases };
      confirm_phrases: Phrases;
      order_number_labels: Phrases;
    };
    shop?: { online_order_subjects?: string[]; click_collect_subjects?: string[]; book_kinds: string[]; skip_kinds: string[]; by: string; ean_label: string };
    invoice?: { subjects: string[]; unit: string; total_words: string[]; postage_words: string[] };
  };
  order?: { to: string };
  prices?: SearchTiles | { kind: 'jsonld'; url: string };
}

/**
 * What a price lookup sends its host: a book's title and first author (`{query}`), or its ISBN-13 alone (`{isbn}`, a
 * jsonld lookup only), the one placeholder its URL has.
 */
export const priceAsks = (url: string): 'title' | 'isbn' => (url.includes('{isbn}') ? 'isbn' : 'title');
/** The URL with its placeholder filled by a harmless word: what it reads as, to check or to show its host. */
export const priceUrlShape = (url: string): string => url.replace(/\{(?:query|isbn)\}/, 'q');

/** A price lookup on the shop's search page, read as text: its result tiles. */
export interface SearchTiles {
  kind: 'search_tiles';
  url: string;
  article: { path: string; id_prefix: string; id_digits: [number, number] };
  print_formats: Phrases;
  want_languages: Phrases;
  other_languages: Phrases;
  availability: { phrases: Phrases; joiners: Phrases; units: Phrases };
}

// strict: the schema itself must be one Ajv reads without guessing (an unknown keyword is an error, not ignored).
const ajv = new Ajv2020({ allErrors: true, strict: true, strictTuples: false });
const validate = ajv.compile(connectorSchema);

/** The schema's verdict: the object, or the first few problems (a JSON pointer and why). */
export function checkConnectorShape(v: unknown): { ok: true; connector: Connector } | { ok: false; errors: string[] } {
  if (validate(v)) return { ok: true, connector: v as unknown as Connector };
  return { ok: false, errors: (validate.errors ?? []).slice(0, 5).map((e) => `${e.instancePath || '/'} ${e.message ?? 'is invalid'}${e.params && 'additionalProperty' in e.params ? ` (${String(e.params.additionalProperty).slice(0, 40)})` : ''}`) };
}
