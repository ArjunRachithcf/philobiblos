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
  money: { before: string[]; after: string[] };
  mail?: {
    domains: string[];
    dkim_domains?: string[];
    reply: { separators: Phrases; header_labels: Phrases; attribution_starts: Phrases; attribution_verbs: Phrases };
    summary: string[];
    unavailable: Phrases;
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
  prices?: {
    kind: 'search_tiles';
    url: string;
    article: { path: string; id_prefix: string; id_digits: [number, number] };
    print_formats: Phrases;
    want_languages: Phrases;
    other_languages: Phrases;
    availability: { phrases: Phrases; joiners: Phrases; units: Phrases };
  };
}

// strict: the schema itself must be one Ajv reads without guessing (an unknown keyword is an error, not ignored).
const ajv = new Ajv2020({ allErrors: true, strict: true, strictTuples: false });
const validate = ajv.compile(connectorSchema);

/** The schema's verdict: the object, or the first few problems (a JSON pointer and why). */
export function checkConnectorShape(v: unknown): { ok: true; connector: Connector } | { ok: false; errors: string[] } {
  if (validate(v)) return { ok: true, connector: v as unknown as Connector };
  return { ok: false, errors: (validate.errors ?? []).slice(0, 5).map((e) => `${e.instancePath || '/'} ${e.message ?? 'is invalid'}${e.params && 'additionalProperty' in e.params ? ` (${String(e.params.additionalProperty).slice(0, 40)})` : ''}`) };
}
