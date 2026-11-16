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
  // The AI's models (M3 g): {"ollama": {"model", "visionModel"}, "claude": {"model"}}; the Claude key is sealed, never here.
  aiModelsJson: text('ai_models_json').notNull().default('{}'),
  // The lines of Settings' "what leaves" an admin accepted with Claude (JSON array; ai/settings.ts leavesAccepted).
  aiLeavesAccepted: text('ai_leaves_accepted'),
  // The household's AI allowance with Claude: tokens (input and output) in any 24 hours, across every run (ai/run.ts).
  aiDailyTokens: integer('ai_daily_tokens').notNull().default(200000),
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

// What Open Library says about a book (contracts/connectors.md "Metadata"): looked up once, refreshed by hand.
export const bookMeta = sqliteTable('book_meta', {
  bookId: text('book_id').primaryKey().references(() => book.id, { onDelete: 'cascade' }),
  source: text('source').notNull(),
  externalId: text('external_id'),
  description: text('description'),
  subjectsJson: text('subjects_json').notNull().default('[]'),
  coverId: text('cover_id'),
  status: text('status', { enum: ['found', 'not_found'] }).notNull(),
  fetchedAt: text('fetched_at').notNull(),
}, (t) => [check('book_meta_status', sql`${t.status} IN ('found','not_found')`)]);

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
  // Who decided (null: nobody yet, or the seed). Only a person moves a proposal to confirmed or rejected.
  reviewedBy: text('reviewed_by').references(() => person.id, { onDelete: 'set null' }),
  reviewedAt: text('reviewed_at'),
  // Written from this person's takeaways (shelf#3): only they see its reason and decide it. Kept when the run is purged.
  privateTo: text('private_to').references(() => person.id, { onDelete: 'cascade' }),
}, (t) => [
  primaryKey({ columns: [t.bookId, t.ideaId] }),
  check('book_idea_layer', sql`${t.layer} IN ('intro','core','deep','counterpoint')`),
  check('book_idea_state', sql`${t.state} IN ('proposed','confirmed','rejected')`),
]);

// A new idea the AI proposed for a book (M3 g): only a name on a proposal. No idea row exists for it until a person
// confirms it (knowledge/knowledge.ts reviewIdeaProposal), so a name a model made up never joins the household's
// vocabulary, and never reaches another prompt, on the model's word alone.
export const ideaProposal = sqliteTable('idea_proposal', {
  id: text('id').primaryKey(),
  bookId: text('book_id').notNull().references(() => book.id, { onDelete: 'cascade' }),
  name: text('name').notNull(),
  layer: text('layer', { enum: ['intro', 'core', 'deep', 'counterpoint'] }).notNull(),
  confidence: real('confidence').notNull(),
  state: text('state', { enum: ['proposed', 'confirmed', 'rejected'] }).notNull().default('proposed'),
  aiRunId: text('ai_run_id').references(() => aiRun.id),
  // The idea it became once confirmed (an existing one of that name, or a new one).
  ideaId: text('idea_id').references(() => idea.id),
  reviewedBy: text('reviewed_by').references(() => person.id, { onDelete: 'set null' }),
  reviewedAt: text('reviewed_at'),
  privateTo: text('private_to').references(() => person.id, { onDelete: 'cascade' }),
}, (t) => [
  uniqueIndex('idea_proposal_book_name').on(t.bookId, t.name),
  check('idea_proposal_layer', sql`${t.layer} IN ('intro','core','deep','counterpoint')`),
  check('idea_proposal_state', sql`${t.state} IN ('proposed','confirmed','rejected')`),
]);

// A merge leaves the rows as they were: an idea points at the one it went into (one step; merging again re-points), and
// readers resolve it. The log says who merged and when, and what was re-pointed, so an admin can undo it.
export const ideaMerge = sqliteTable('idea_merge', {
  id: text('id').primaryKey(),
  ideaId: text('idea_id').notNull().references(() => idea.id),
  intoId: text('into_id').notNull().references(() => idea.id),
  repointedJson: text('repointed_json').notNull().default('[]'),
  mergedBy: text('merged_by').references(() => person.id, { onDelete: 'set null' }),
  mergedAt: text('merged_at').notNull(),
  undoneBy: text('undone_by').references(() => person.id, { onDelete: 'set null' }),
  undoneAt: text('undone_at'),
});

export const bookLink = sqliteTable('book_link', {
  fromBook: text('from_book').notNull().references(() => book.id, { onDelete: 'cascade' }),
  toBook: text('to_book').notNull().references(() => book.id, { onDelete: 'cascade' }),
  reason: text('reason').notNull(),
  confidence: real('confidence').notNull(),
  state: text('state', { enum: ['proposed', 'confirmed', 'rejected'] }).notNull().default('proposed'),
  aiRunId: text('ai_run_id').references(() => aiRun.id),
  // Who decided (null: nobody yet, or the seed). Only a person moves a proposal to confirmed or rejected.
  reviewedBy: text('reviewed_by').references(() => person.id, { onDelete: 'set null' }),
  reviewedAt: text('reviewed_at'),
  // Written from this person's takeaways (shelf#3): only they see its reason and decide it. Kept when the run is purged.
  privateTo: text('private_to').references(() => person.id, { onDelete: 'cascade' }),
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
  snoozedUntil: text('snoozed_until'),
}, (t) => [
  primaryKey({ columns: [t.personId, t.bookId] }),
  check('candidate_origin', sql`${t.origin} IN ('wishlist','to_buy','share','ai','manual','seed')`),
  check('candidate_state', sql`${t.state} IN ('active','not_for_me','snoozed','picked','owned')`),
]);

export const savedFilter = sqliteTable('saved_filter', {
  id: text('id').primaryKey(),
  personId: text('person_id').notNull().references(() => person.id, { onDelete: 'cascade' }),
  name: text('name').notNull(),
  q: text('q').notNull(),
  createdAt: text('created_at').notNull(),
});

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
  // Who may read the AI's why (null: everyone who sees the plan): its pick's person when it was built on something
  // private to them (a link or a book idea from their takeaways), so only they see it.
  whyAudience: text('why_audience'),
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
  title: text('title'),
  caption: text('caption'),
  mediaTotal: integer('media_total').notNull().default(0),
  mediaRefused: integer('media_refused').notNull().default(0),
  error: text('error'),
  // The share token it came with (null: the PWA, a session), and when the AI read it: the daily AI reads are counted
  // per person and per token (ai/jobs.ts SHARE_AI).
  tokenId: text('token_id').references(() => shareToken.id, { onDelete: 'set null' }),
  aiReadAt: text('ai_read_at'),
}, (t) => [check('share_status', sql`${t.status} IN ('received','reading','done','failed')`)]);

// What a person decided in the Inbox (M3 e): one row per book of an item, idx -1 for the whole item dismissed.
export const inboxDecision = sqliteTable('inbox_decision', {
  item: text('item').notNull(),
  idx: integer('idx').notNull(),
  decision: text('decision', { enum: ['added', 'skipped', 'dismissed'] }).notNull(),
  personId: text('person_id').references(() => person.id, { onDelete: 'set null' }),
  bookId: text('book_id').references(() => book.id, { onDelete: 'set null' }),
  decidedAt: text('decided_at').notNull(),
}, (t) => [
  primaryKey({ columns: [t.item, t.idx] }),
  check('inbox_decision_decision', sql`${t.decision} IN ('added','skipped','dismissed')`),
]);

export const mailSeen = sqliteTable('mail_seen', {
  messageId: text('message_id').primaryKey(),
  kind: text('kind').notNull(),
  parsedJson: text('parsed_json'),
  parserVersion: text('parser_version').notNull(),
  seenAt: text('seen_at').notNull(),
  authJson: text('auth_json'),
  accepted: integer('accepted').notNull().default(0),
});

// Where the mail reader stopped, per folder (ADR 0007): new messages are those after last_uid while uid_validity holds.
export const mailCursor = sqliteTable('mail_cursor', {
  folder: text('folder').primaryKey(),
  uidValidity: integer('uid_validity').notNull(),
  lastUid: integer('last_uid').notNull(),
  configKey: text('config_key').notNull(),
  updatedAt: text('updated_at').notNull(),
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
  // Whose takeaways were in the input (null: nobody's). Turning takeawaysToAi off deletes these runs and what they
  // proposed (src/library/ai-context.ts).
  takeawaysOf: text('takeaways_of').references(() => person.id, { onDelete: 'cascade' }),
  // Whose request it served (a share's sharer, the person a suggestion is for); null for the household's (a book's tags).
  personId: text('person_id').references(() => person.id, { onDelete: 'cascade' }),
  // Tokens the provider counted (input and output, every attempt): the household's daily allowance sums them.
  tokens: integer('tokens').notNull().default(0),
  // A share's run: the share token the share came with (its part of the allowance is counted by it).
  shareTokenId: text('share_token_id').references(() => shareToken.id, { onDelete: 'set null' }),
}, (t) => [index('ai_run_cache').on(t.job, t.promptVersion, t.inputHash), index('ai_run_spend').on(t.provider, t.startedAt)]);

export const jobRun = sqliteTable('job_run', {
  id: text('id').primaryKey(),
  job: text('job').notNull(),
  status: text('status').notNull(),
  detail: text('detail'),
  startedAt: text('started_at').notNull(),
  finishedAt: text('finished_at'),
  // A scheduled run's period ('YYYY-MM'); null when an admin ran it by hand.
  period: text('period'),
});

// The scheduler's claim on a period (jobs/schedule.ts): a period runs once, whatever restarts, overlaps or clocks do.
export const jobPeriod = sqliteTable('job_period', {
  job: text('job').notNull(),
  period: text('period').notNull(),
  status: text('status', { enum: ['running', 'retry', 'done', 'gave_up'] }).notNull(),
  attempts: integer('attempts').notNull().default(0),
  stepsJson: text('steps_json').notNull().default('[]'),
  leaseUntil: text('lease_until'),
  nextTryAt: text('next_try_at'),
  runId: text('run_id').references(() => jobRun.id, { onDelete: 'set null' }),
  updatedAt: text('updated_at').notNull(),
}, (t) => [primaryKey({ columns: [t.job, t.period] }), check('job_period_status', sql`${t.status} IN ('running','retry','done','gave_up')`)]);
