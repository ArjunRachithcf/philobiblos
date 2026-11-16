// Open Library: subjects, a description and a cover id for a book (contracts/connectors.md "Metadata"). By ISBN when
// the book has one, else by title and first author. The answers are untrusted JSON: only the fields below are read,
// each checked for its type and cut to a length; nothing in them is followed except the work key, on the same host.
import type { Egress } from '../net/egress';
import { norm } from '../seed/import';

const BASE = 'https://openlibrary.org';
export interface Meta { externalId: string; description: string | null; subjects: string[]; coverId: string | null }

const str = (v: unknown, max: number): string | null => (typeof v === 'string' && v.trim() ? v.trim().slice(0, max) : null);
const WORK_KEY = /^\/works\/OL\d+W$/;
const ISBN13 = /^97[89]\d{10}$/;

function obj(body: Buffer): Record<string, unknown> {
  const v: unknown = JSON.parse(body.toString('utf8'));
  if (!v || typeof v !== 'object' || Array.isArray(v)) throw new Error('not a JSON object');
  return v as Record<string, unknown>;
}

/** A work's description (a string or `{ value }`), at most 2000 characters, up to 20 subjects and its first cover. */
export function parseWork(w: Record<string, unknown>): { description: string | null; subjects: string[]; coverId: string | null } {
  const d = w.description;
  const description = str(typeof d === 'object' && d ? (d as { value?: unknown }).value : d, 2000);
  return { description, subjects: subjectsOf(w.subjects), coverId: coverOf(w.covers) };
}

function subjectsOf(v: unknown): string[] {
  if (!Array.isArray(v)) return [];
  const out: string[] = [];
  for (const s of v) {
    const t = str(s, 80);
    if (t && !out.includes(t)) out.push(t);
    if (out.length === 20) break;
  }
  return out;
}

const coverOf = (v: unknown): string | null => {
  const first = Array.isArray(v) ? v[0] : v;
  return typeof first === 'number' && Number.isInteger(first) && first > 0 ? String(first) : null;
};

/** The search result whose title matches (normalised) and whose authors include the first author, if any. */
export function pickSearchDoc(docs: unknown, title: string, author: string | undefined): Record<string, unknown> | null {
  if (!Array.isArray(docs)) return null;
  const want = norm(title);
  const surname = author ? norm(author.split(/\s+/).at(-1) ?? '') : '';
  for (const d of docs.slice(0, 10)) {
    if (!d || typeof d !== 'object') continue;
    const r = d as Record<string, unknown>;
    const t = str(r.title, 300);
    if (!t || norm(t) !== want || typeof r.key !== 'string' || !WORK_KEY.test(r.key)) continue;
    const authors = Array.isArray(r.author_name) ? r.author_name.filter((a): a is string => typeof a === 'string') : [];
    if (surname && !authors.some((a) => norm(a).endsWith(surname))) continue;
    return r;
  }
  return null;
}

/** The facts Open Library has for a book, or null when it has none that match. Network errors are thrown. */
export async function lookup(egress: Egress, b: { title: string; authors: string[]; isbn13: string | null }): Promise<Meta | null> {
  let workKey: string | null = null;
  let coverId: string | null = null;
  let subjects: string[] = [];
  if (b.isbn13 && ISBN13.test(b.isbn13)) {
    try {
      const ed = obj((await egress.get(`${BASE}/isbn/${b.isbn13}.json`, 'json')).body);
      const works = Array.isArray(ed.works) ? ed.works : [];
      const k = (works[0] as { key?: unknown } | undefined)?.key;
      workKey = typeof k === 'string' && WORK_KEY.test(k) ? k : null;
      coverId = coverOf(ed.covers);
    } catch (e) {
      // Not known by this ISBN (404) or an edition without a usable work: try title and author.
      if ((e as { status?: number }).status !== 404 && !(e instanceof SyntaxError) && !(e instanceof Error && e.message === 'not a JSON object')) throw e;
    }
  }
  if (!workKey) {
    const q = new URLSearchParams({ title: b.title.slice(0, 200), limit: '10', fields: 'key,title,author_name,cover_i,subject' });
    if (b.authors[0]) q.set('author', b.authors[0].slice(0, 100));
    const doc = pickSearchDoc(obj((await egress.get(`${BASE}/search.json?${q}`, 'json')).body).docs, b.title, b.authors[0]);
    if (!doc) return null;
    workKey = doc.key as string;
    coverId ??= coverOf(doc.cover_i);
    subjects = subjectsOf(doc.subject);
  }
  const work = parseWork(obj((await egress.get(`${BASE}${workKey}.json`, 'json')).body));
  coverId ??= work.coverId;
  return { externalId: workKey, description: work.description, subjects: work.subjects.length ? work.subjects : subjects, coverId };
}
