// Connectors as data (contracts/connectors.md, docs/connectors.md): `connectors/<id>/connector.yaml`, from the folder that
// ships with Philobiblos and the household's own (PHILOBIBLOS_CONNECTORS_DIR). Read once at start, strictly:
// - each a plain file of at most 64 KB in a plain folder (a symbolic link is refused: a connector names no other file);
// - YAML with no aliases, no tags, no duplicate keys; then contracts/connector.schema.json, which refuses every key it
//   does not name (so no file can carry a setting the core does not have, such as unsigned mail or a private host);
// - then what a schema cannot say: the id is its folder's name, a quote sender is at one of its own mail domains, a
//   signing domain is aligned with one of them, its currency is one this server knows, a subject template has words
//   around its number, a price URL's host is exact and its query is the only thing filled.
// Read once means a file edited on disk shows as changed (and counts for nothing) only after a restart; its bytes are
// hashed and parsed from one buffer, so what was checked is what was read. An entry that cannot be looked at is a problem
// row, not a failed start. Accepted (the folders are the trust root): the folder check and the open are two steps, so
// whoever can write to a connectors folder could swap a folder for a link between them; they could as well write the file.
// A connector that fails any of it is listed with its reason and can never be enabled. Its version is the SHA-256 of
// its bytes: an admin's enabling holds for those bytes only (enabled.ts).
import { createHash } from 'node:crypto';
import { closeSync, constants, fstatSync, lstatSync, openSync, readSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { parseDocument } from 'yaml';
import { checkConnectorShape, priceAsks, priceUrlShape, type Connector } from '@philobiblos/contracts/connector';
import { relaxedAligned } from '../mail/verify';
import { fold } from './text';
import { validCurrency } from '../household/currency';

export const CONNECTOR_LIMITS = { fileBytes: 64 * 1024, perFolder: 64 } as const;
export const CONNECTOR_FILE = 'connector.yaml';

export interface LoadedConnector {
  id: string;
  origin: 'builtin' | 'local';
  /** SHA-256 of the file's bytes (hex); '' when it could not be read. */
  version: string;
  connector: Connector | null;
  /** Why it cannot be used (null when it can). */
  problem: string | null;
}

export interface Registry {
  all: LoadedConnector[];
  get(id: string): LoadedConnector | undefined;
}

export const registry = (all: LoadedConnector[]): Registry => ({ all, get: (id) => all.find((c) => c.id === id) });

const domainOf = (address: string) => address.slice(address.lastIndexOf('@') + 1);

/** What the schema cannot check. Null when the connector is sound. */
export function soundness(c: Connector, folder: string): string | null {
  if (c.id !== folder) return `its id (${c.id}) is not its folder's name`;
  // Its amounts are read as the household's (household/money.ts): a code no screen can write is no currency.
  if (!validCurrency(c.locale.currency)) return `its currency ${c.locale.currency} is not an ISO 4217 code this server knows`;
  if (c.mail) {
    for (const s of c.mail.quote?.senders ?? []) if (!c.mail.domains.includes(domainOf(s))) return `the quote sender ${s} is not at one of its mail domains`;
    // A signer aligned with none of its From domains could never count (verify.ts): Settings must not show it as one.
    for (const d of c.mail.dkim_domains ?? []) if (!c.mail.domains.some((m) => relaxedAligned(d, m))) return `the signing domain ${d} is not aligned with any of its mail domains`;
    for (const t of [...(c.mail.shop?.online_order_subjects ?? []), ...(c.mail.shop?.click_collect_subjects ?? []), ...(c.mail.invoice?.subjects ?? [])]) {
      // A subject must say something besides its number, or any number would be the shop's mail.
      if (fold(t.replace('{number}', '')).replace(/[^\p{L}]/gu, '').length < 4) return `the subject ${t.slice(0, 60)} has too few words around its number`;
    }
  }
  if (c.prices) {
    if (c.prices.kind === 'search_tiles') {
      const [lo, hi] = c.prices.article.id_digits;
      if (lo > hi) return 'its article id has fewer digits at most than at least';
    }
    let u: URL;
    try { u = new URL(priceUrlShape(c.prices.url)); } catch { return 'its price URL does not read'; }
    // The schema's pattern already holds this; checked again on the parsed URL, which is what the client will see. One
    // placeholder, {query}, or {isbn} in a jsonld lookup (the tiles are read by their titles).
    const holes = c.prices.url.split(/\{(?:query|isbn)\}/).length - 1;
    const isbn = priceAsks(c.prices.url) === 'isbn';
    if (u.protocol !== 'https:' || u.port || u.username || u.password || u.hash || holes !== 1 || (isbn && c.prices.kind !== 'jsonld')) return 'its price URL must be https on the default port, with {query} once (or {isbn}, for a jsonld lookup)';
  }
  return null;
}

/** One connector's file: its bytes in, the connector or its problem out (pure). */
export function readConnector(bytes: Buffer, folder: string): { connector: Connector } | { problem: string } {
  if (bytes.length > CONNECTOR_LIMITS.fileBytes) return { problem: `${CONNECTOR_FILE} is larger than ${CONNECTOR_LIMITS.fileBytes} bytes` };
  let text: string;
  try { text = new TextDecoder('utf-8', { fatal: true }).decode(bytes); } catch { return { problem: `${CONNECTOR_FILE} is not UTF-8` }; }
  // maxAliasCount 0: an alias is refused outright (no billion laughs); the core schema has no tags beyond the plain ones.
  const doc = parseDocument(text, { uniqueKeys: true, schema: 'core', strict: true, prettyErrors: false, merge: false });
  if (doc.errors.length || doc.warnings.length) return { problem: `${CONNECTOR_FILE} is not plain YAML: ${(doc.errors[0] ?? doc.warnings[0])!.code}` };
  let tagged = false;
  // A tag (`!!js/function`, `!custom`) is never data: refused even where the core schema would resolve it.
  const visit = (n: unknown) => {
    if (!n || typeof n !== 'object') return;
    if ('tag' in n && typeof (n as { tag?: unknown }).tag === 'string' && (n as { tag: string }).tag) tagged = true;
    if ('anchor' in n && (n as { anchor?: unknown }).anchor) tagged = true;
    for (const k of ['items', 'key', 'value', 'contents']) if (k in n) { const v = (n as Record<string, unknown>)[k]; if (Array.isArray(v)) v.forEach(visit); else visit(v); }
  };
  visit(doc.contents);
  if (tagged) return { problem: `${CONNECTOR_FILE} uses a YAML tag or anchor` };
  let value: unknown;
  try { value = doc.toJS({ maxAliasCount: 0 }); } catch { return { problem: `${CONNECTOR_FILE} is not plain YAML` }; }
  const shape = checkConnectorShape(value);
  if (!shape.ok) return { problem: `it does not follow the connector schema: ${shape.errors.join('; ')}` };
  const problem = soundness(shape.connector, folder);
  return problem ? { problem } : { connector: shape.connector };
}

/** A plain file's bytes, at most `max` + 1 of them (more is refused by the caller), never through a symbolic link. */
function readPlain(path: string, max: number): Buffer | string {
  let fd: number;
  try { fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW); } catch { return `${CONNECTOR_FILE} cannot be opened (or is a link)`; }
  try {
    if (!fstatSync(fd).isFile()) return `${CONNECTOR_FILE} is not a plain file`;
    const buf = Buffer.alloc(max + 1);
    let n = 0;
    for (let r; n < buf.length && (r = readSync(fd, buf, n, buf.length - n, null)) > 0;) n += r;
    return buf.subarray(0, n);
  } finally {
    closeSync(fd);
  }
}

/** How the folders are looked at (tests stand in for an entry that vanishes while Philobiblos starts). */
export interface ConnectorFs { lstat: (path: string) => { isDirectory(): boolean } }

function loadFolder(dir: string, origin: LoadedConnector['origin'], fs: ConnectorFs): LoadedConnector[] {
  let names: string[];
  try { names = readdirSync(dir).filter((n) => !n.startsWith('.')).sort(); } catch { return []; }
  const out: LoadedConnector[] = [];
  for (const name of names.slice(0, CONNECTOR_LIMITS.perFolder)) {
    const path = join(dir, name);
    let isFolder: boolean;
    try { isFolder = fs.lstat(path).isDirectory(); } catch { out.push({ id: name, origin, version: '', connector: null, problem: 'its folder cannot be read' }); continue; }
    if (!isFolder) continue;
    const bytes = readPlain(join(path, CONNECTOR_FILE), CONNECTOR_LIMITS.fileBytes);
    if (typeof bytes === 'string') { out.push({ id: name, origin, version: '', connector: null, problem: bytes }); continue; }
    const version = createHash('sha256').update(bytes).digest('hex');
    const r = readConnector(bytes, name);
    out.push({ id: name, origin, version, connector: 'connector' in r ? r.connector : null, problem: 'problem' in r ? r.problem : null });
  }
  return out;
}

/** The connectors of both folders; the household's own may not reuse an id of one that ships with Philobiblos. */
export function loadConnectors(dirs: { builtin: string | null; local: string | null }, fs: ConnectorFs = { lstat: lstatSync }): Registry {
  const builtin = dirs.builtin ? loadFolder(dirs.builtin, 'builtin', fs) : [];
  const local = (dirs.local ? loadFolder(dirs.local, 'local', fs) : []).map((c) => (builtin.some((b) => b.id === c.id)
    ? { ...c, connector: null, problem: 'a connector that ships with Philobiblos has this id' } : c));
  return registry([...builtin, ...local]);
}
