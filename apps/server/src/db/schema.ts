// Drizzle schema of contracts/schema.sql (the source of truth). test/migrations.contract.test.ts checks that the
// migrations build the same tables, columns, keys, indexes and CHECK constraints as that file.
import { sql } from 'drizzle-orm';
import { blob, check, index, uniqueIndex, integer, primaryKey, real, sqliteTable, text, type AnySQLiteColumn } from 'drizzle-orm/sqlite-core';

// People ---------------------------------------------------------------
export const person = sqliteTable('person', {
  id: text('id').primaryKey(),
  externalId: text('external_id').unique(),
  name: text('name').notNull(),
  role: text('role', { enum: ['admin', 'adult', 'kid'] }).notNull(),
  birthYear: integer('birth_year'),
  settingsJson: text('settings_json').notNull().default('{}'),
  handle: text('handle'),
}, (t) => [check('person_role', sql`${t.role} IN ('admin','adult','kid')`), uniqueIndex('person_handle').on(t.handle)]);

// Sign-in (standalone; ADR 0010) ---------------------------------------
export const passkey = sqliteTable('passkey', {
  id: text('id').primaryKey(),
  personId: text('person_id').notNull().references(() => person.id, { onDelete: 'cascade' }),
  publicKey: blob('public_key', { mode: 'buffer' }).notNull(),
  counter: integer('counter').notNull().default(0),
  transportsJson: text('transports_json').notNull().default('[]'),
  backedUp: integer('backed_up').notNull().default(0),
  label: text('label').notNull(),
  createdAt: text('created_at').notNull(),
  lastUsedAt: text('last_used_at'),
  invitedBy: text('invited_by').references(() => person.id, { onDelete: 'set null' }),
});

export const session = sqliteTable('session', {
  id: text('id').primaryKey(),
  personId: text('person_id').notNull().references(() => person.id, { onDelete: 'cascade' }),
  createdAt: text('created_at').notNull(),
  lastSeenAt: text('last_seen_at').notNull(),
  expiresAt: text('expires_at').notNull(),
  passkeyId: text('passkey_id').references(() => passkey.id, { onDelete: 'cascade' }),
});

export const invite = sqliteTable('invite', {
  id: text('id').primaryKey(),
  kind: text('kind', { enum: ['setup', 'admin', 'self', 'recovery'] }).notNull(),
  personId: text('person_id').references(() => person.id, { onDelete: 'cascade' }),
  tokenHash: text('token_hash').notNull().unique(),
  createdBy: text('created_by').references(() => person.id, { onDelete: 'set null' }),
  createdAt: text('created_at').notNull(),
  expiresAt: text('expires_at').notNull(),
  usedAt: text('used_at'),
}, (t) => [check('invite_kind', sql`${t.kind} IN ('setup','admin','self','recovery')`)]);

export const householdSettings = sqliteTable('household_settings', {
  id: integer('id').primaryKey(),
  budgetMinC: integer('budget_min_c').notNull().default(10000),
  budgetMaxC: integer('budget_max_c').notNull().default(15000),
  adultPicks: integer('adult_picks').notNull().default(2),
  newAuthorsOnly: integer('new_authors_only').notNull().default(1),
  aiProvider: text('ai_provider', { enum: ['claude', 'ollama', 'none'] }).notNull().default('ollama'),
  aiJobsJson: text('ai_jobs_json').notNull().default('{"read":true,"link":true,"suggest":true,"explain":true,"wildcards":true}'),
  cycleDay: integer('cycle_day').notNull().default(1),
  cycleTime: text('cycle_time').notNull().default('20:17'),
  timezone: text('timezone').notNull().default('Europe/Zurich'),
}, (t) => [
  check('household_settings_one', sql`${t.id} = 1`),
  check('household_settings_ai_provider', sql`${t.aiProvider} IN ('claude','ollama','none')`),
]);

export const monthOverride = sqliteTable('month_override', {
  month: text('month').primaryKey(),
  budgetMinC: integer('budget_min_c'),
  budgetMaxC: integer('budget_max_c'),
  note: text('note'),
});

// Books ------------------------------------------------------------------
export const book = sqliteTable('book', {
  id: text('id').primaryKey(),
  title: text('title').notNull(),
  subtitle: text('subtitle'),
  authorsJson: text('authors_json').notNull().default('[]'),
  isbn13: text('isbn13').unique(),
  language: text('language').default('en'),
  audience: text('audience', { enum: ['adult', 'kids'] }).notNull(),
  isFiction: integer('is_fiction').notNull().default(0),
  ageBand: text('age_band', { enum: ['0-2', '3-5', '6-8', '9-12'] }),
  coverPath: text('cover_path'),
  normKey: text('norm_key').notNull(),
  createdAt: text('created_at').notNull(),
}, (t) => [
  check('book_audience', sql`${t.audience} IN ('adult','kids')`),
  check('book_age_band', sql`${t.ageBand} IN ('0-2','3-5','6-8','9-12')`),
  index('book_norm').on(t.normKey),
]);

export const bookOffer = sqliteTable('book_offer', {
  bookId: text('book_id').notNull().references(() => book.id, { onDelete: 'cascade' }),
  source: text('source').notNull(),
  externalId: text('external_id'),
  priceC: integer('price_c'),
  availability: text('availability'),
  seenAt: text('seen_at').notNull(),
}, (t) => [primaryKey({ columns: [t.bookId, t.source] })]);

export const copy = sqliteTable('copy', {
  id: text('id').primaryKey(),
  bookId: text('book_id').notNull().references(() => book.id),
  source: text('source', { enum: ['order', 'invoice', 'manual', 'seed'] }).notNull(),
  orderId: text('order_id').references(() => order.id),
  priceC: integer('price_c'),
  acquiredAt: text('acquired_at').notNull(),
}, (t) => [check('copy_source', sql`${t.source} IN ('order','invoice','manual','seed')`)]);

export const reading = sqliteTable('reading', {
  personId: text('person_id').notNull().references(() => person.id, { onDelete: 'cascade' }),
  bookId: text('book_id').notNull().references(() => book.id, { onDelete: 'cascade' }),
  status: text('status', { enum: ['to_read', 'reading', 'read', 'abandoned'] }).notNull(),
  feedback: text('feedback', { enum: ['loved', 'meh', 'not_yet'] }),
  takeaway: text('takeaway'),
  finishedAt: text('finished_at'),
  updatedAt: text('updated_at').notNull(),
}, (t) => [
  primaryKey({ columns: [t.personId, t.bookId] }),
  check('reading_status', sql`${t.status} IN ('to_read','reading','read','abandoned')`),
  check('reading_feedback', sql`${t.feedback} IN ('loved','meh','not_yet')`),
]);

// Knowledge --------------------------------------------------------------
export const idea = sqliteTable('idea', {
  id: text('id').primaryKey(),
  name: text('name').notNull().unique(),
  mergedInto: text('merged_into').references((): AnySQLiteColumn => idea.id),
});

export const bookIdea = sqliteTable('book_idea', {
  bookId: text('book_id').notNull().references(() => book.id, { onDelete: 'cascade' }),
  ideaId: text('idea_id').notNull().references(() => idea.id),
  layer: text('layer', { enum: ['intro', 'core', 'deep', 'counterpoint'] }).notNull(),
  confidence: real('confidence').notNull(),
  state: text('state', { enum: ['proposed', 'confirmed', 'rejected'] }).notNull().default('proposed'),
  aiRunId: text('ai_run_id').references(() => aiRun.id),
}, (t) => [
  primaryKey({ columns: [t.bookId, t.ideaId] }),
  check('book_idea_layer', sql`${t.layer} IN ('intro','core','deep','counterpoint')`),
  check('book_idea_state', sql`${t.state} IN ('proposed','confirmed','rejected')`),
]);

export const bookLink = sqliteTable('book_link', {
  fromBook: text('from_book').notNull().references(() => book.id, { onDelete: 'cascade' }),
  toBook: text('to_book').notNull().references(() => book.id, { onDelete: 'cascade' }),
  reason: text('reason').notNull(),
  confidence: real('confidence').notNull(),
  state: text('state', { enum: ['proposed', 'confirmed', 'rejected'] }).notNull().default('proposed'),
  aiRunId: text('ai_run_id').references(() => aiRun.id),
}, (t) => [
  primaryKey({ columns: [t.fromBook, t.toBook] }),
  check('book_link_state', sql`${t.state} IN ('proposed','confirmed','rejected')`),
]);

export const redundancy = sqliteTable('redundancy', {
  bookId: text('book_id').notNull().references(() => book.id),
  repeatsBook: text('repeats_book').notNull().references(() => book.id),
  reason: text('reason').notNull(),
  state: text('state').notNull().default('proposed'),
}, (t) => [primaryKey({ columns: [t.bookId, t.repeatsBook] })]);

export const bookTheme = sqliteTable('book_theme', {
  bookId: text('book_id').notNull().references(() => book.id, { onDelete: 'cascade' }),
  theme: text('theme').notNull(),
}, (t) => [primaryKey({ columns: [t.bookId, t.theme] })]);

// Backlog ----------------------------------------------------------------
export const candidate = sqliteTable('candidate', {
  personId: text('person_id').notNull().references(() => person.id, { onDelete: 'cascade' }),
  bookId: text('book_id').notNull().references(() => book.id, { onDelete: 'cascade' }),
  origin: text('origin', { enum: ['wishlist', 'to_buy', 'share', 'ai', 'manual', 'seed'] }).notNull(),
  shareId: text('share_id').references(() => share.id),
  state: text('state', { enum: ['active', 'not_for_me', 'snoozed', 'picked', 'owned'] }).notNull().default('active'),
  addedAt: text('added_at').notNull(),
  touchedAt: text('touched_at').notNull(),
  score: real('score'),
  scorePartsJson: text('score_parts_json'),
  move: text('move'),
}, (t) => [
  primaryKey({ columns: [t.personId, t.bookId] }),
  check('candidate_origin', sql`${t.origin} IN ('wishlist','to_buy','share','ai','manual','seed')`),
  check('candidate_state', sql`${t.state} IN ('active','not_for_me','snoozed','picked','owned')`),
]);

// Orders -----------------------------------------------------------------
export const order = sqliteTable('order', {
  id: text('id').primaryKey(),
  month: text('month').notNull(),
  status: text('status', { enum: ['picked', 'drafted', 'quoted', 'invoiced', 'closed'] }).notNull(),
  mailThreadRef: text('mail_thread_ref'),
  estimateC: integer('estimate_c'),
  quotedC: integer('quoted_c'),
  invoicedC: integer('invoiced_c'),
  createdAt: text('created_at').notNull(),
}, (t) => [check('order_status', sql`${t.status} IN ('picked','drafted','quoted','invoiced','closed')`)]);

export const orderLine = sqliteTable('order_line', {
  orderId: text('order_id').notNull().references(() => order.id, { onDelete: 'cascade' }),
  bookId: text('book_id').notNull().references(() => book.id),
  forPerson: text('for_person').notNull().references(() => person.id),
  move: text('move'),
  why: text('why'),
  estimateC: integer('estimate_c'),
  quotedC: integer('quoted_c'),
  delivery: text('delivery'),
  state: text('state', { enum: ['planned', 'quoted', 'unavailable', 'delivered', 'rolled_over'] }).notNull().default('planned'),
}, (t) => [
  primaryKey({ columns: [t.orderId, t.bookId] }),
  check('order_line_state', sql`${t.state} IN ('planned','quoted','unavailable','delivered','rolled_over')`),
]);

// Sources ----------------------------------------------------------------
export const share = sqliteTable('share', {
  id: text('id').primaryKey(),
  personId: text('person_id').notNull().references(() => person.id),
  url: text('url'),
  note: text('note'),
  mediaJson: text('media_json').notNull().default('[]'),
  status: text('status', { enum: ['received', 'reading', 'done', 'failed'] }).notNull(),
  foundJson: text('found_json'),
  createdAt: text('created_at').notNull(),
}, (t) => [check('share_status', sql`${t.status} IN ('received','reading','done','failed')`)]);

export const mailSeen = sqliteTable('mail_seen', {
  messageId: text('message_id').primaryKey(),
  kind: text('kind').notNull(),
  parsedJson: text('parsed_json'),
  parserVersion: text('parser_version').notNull(),
  seenAt: text('seen_at').notNull(),
  authJson: text('auth_json'),
  accepted: integer('accepted').notNull().default(0),
});

export const shareToken = sqliteTable('share_token', {
  id: text('id').primaryKey(),
  personId: text('person_id').notNull().references(() => person.id, { onDelete: 'cascade' }),
  label: text('label').notNull(),
  tokenHash: text('token_hash').notNull().unique(),
  createdAt: text('created_at').notNull(),
  lastUsedAt: text('last_used_at'),
  revokedAt: text('revoked_at'),
});

export const sealedSecret = sqliteTable('sealed_secret', {
  key: text('key').primaryKey(),
  ciphertext: blob('ciphertext', { mode: 'buffer' }).notNull(),
  keyId: text('key_id').notNull(),
  updatedAt: text('updated_at').notNull(),
});

export const aiRun = sqliteTable('ai_run', {
  id: text('id').primaryKey(),
  job: text('job').notNull(),
  provider: text('provider').notNull(),
  model: text('model').notNull(),
  promptVersion: text('prompt_version').notNull(),
  inputHash: text('input_hash').notNull(),
  outputJson: text('output_json'),
  costC: integer('cost_c'),
  startedAt: text('started_at').notNull(),
  finishedAt: text('finished_at'),
  error: text('error'),
});

export const jobRun = sqliteTable('job_run', {
  id: text('id').primaryKey(),
  job: text('job').notNull(),
  status: text('status').notNull(),
  detail: text('detail'),
  startedAt: text('started_at').notNull(),
  finishedAt: text('finished_at'),
});
