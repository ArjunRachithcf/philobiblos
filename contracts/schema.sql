-- Shelf database schema v8 (SQLite). Source of truth: the migrations must build exactly this (apps/server/test).
-- Conventions: ids are text (ULID), timestamps ISO-8601 UTC text, money in centimes (integer CHF*100).

PRAGMA foreign_keys = ON;

-- People ---------------------------------------------------------------
CREATE TABLE person (
  id            TEXT PRIMARY KEY NOT NULL,
  external_id   TEXT UNIQUE,              -- HomersLab person id when SHELF_MODE=homerslab
  name          TEXT NOT NULL,
  role          TEXT NOT NULL CHECK (role IN ('admin','adult','kid')),
  birth_year    INTEGER,                  -- kids: drives age band
  settings_json TEXT NOT NULL DEFAULT '{}', -- per-person: mix, unread_limit, counterpoints, takeaways, takeaways_to_claude (default off), fiction, weights
  handle        TEXT                      -- short lower-case name for the backlog's for:/by: (e.g. 'alex'); unique
);
CREATE UNIQUE INDEX person_handle ON person(handle);

-- Sign-in (standalone; ADR 0010) ---------------------------------------
CREATE TABLE passkey (                     -- WebAuthn credentials; user verification required at enrolment and sign-in
  id              TEXT PRIMARY KEY NOT NULL, -- credential id (base64url)
  person_id       TEXT NOT NULL REFERENCES person(id) ON DELETE CASCADE,
  public_key      BLOB NOT NULL,
  counter         INTEGER NOT NULL DEFAULT 0,
  transports_json TEXT NOT NULL DEFAULT '[]',
  backed_up       INTEGER NOT NULL DEFAULT 0,
  label           TEXT NOT NULL,           -- e.g. 'Laptop'
  created_at      TEXT NOT NULL,
  last_used_at    TEXT,
  invited_by      TEXT REFERENCES person(id) ON DELETE SET NULL -- whose invite made it (null: the setup link, or the person's own)
);

CREATE TABLE session (                     -- a signed-in browser; the cookie holds a random value, this table its hash
  id           TEXT PRIMARY KEY NOT NULL,  -- SHA-256 of the cookie value
  person_id    TEXT NOT NULL REFERENCES person(id) ON DELETE CASCADE,
  created_at   TEXT NOT NULL,
  last_seen_at TEXT NOT NULL,
  expires_at   TEXT NOT NULL,              -- absolute end; idle sessions end earlier (see ADR 0010)
  passkey_id   TEXT REFERENCES passkey(id) ON DELETE CASCADE -- the passkey that signed in: removing it ends the session
);

CREATE TABLE invite (                      -- one-time link to enrol a passkey (ADR 0010)
  id          TEXT PRIMARY KEY NOT NULL,
  kind        TEXT NOT NULL CHECK (kind IN ('setup','admin','self','recovery')), -- the first admin's; an admin's invite;
                                           -- your own for another device; `shelf recover`'s
  person_id   TEXT REFERENCES person(id) ON DELETE CASCADE, -- null for 'setup' (the admin is created when it is used)
  token_hash  TEXT NOT NULL UNIQUE,        -- SHA-256 of the link's token; the token itself is never stored
  created_by  TEXT REFERENCES person(id) ON DELETE SET NULL,
  created_at  TEXT NOT NULL,
  expires_at  TEXT NOT NULL,
  used_at     TEXT
);

CREATE TABLE household_settings (
  id                INTEGER PRIMARY KEY NOT NULL CHECK (id = 1),
  budget_min_c      INTEGER NOT NULL DEFAULT 10000,
  budget_max_c      INTEGER NOT NULL DEFAULT 15000,
  adult_picks       INTEGER NOT NULL DEFAULT 2,
  new_authors_only  INTEGER NOT NULL DEFAULT 1,
  ai_provider       TEXT NOT NULL DEFAULT 'ollama' CHECK (ai_provider IN ('claude','ollama','none')),
  ai_jobs_json      TEXT NOT NULL DEFAULT '{"read":true,"link":true,"suggest":true,"explain":true,"wildcards":true}',
  cycle_day         INTEGER NOT NULL DEFAULT 1,
  cycle_time        TEXT NOT NULL DEFAULT '20:17',
  timezone          TEXT NOT NULL DEFAULT 'Europe/Zurich',
  ai_models_json    TEXT NOT NULL DEFAULT '{}',  -- the AI's models (Ollama's text and vision model, Claude's); the Claude key is sealed, never here
  ai_leaves_accepted TEXT,                      -- JSON: the lines of what leaves with Claude an admin accepted; Claude runs only while they cover it
  ai_daily_tokens   INTEGER NOT NULL DEFAULT 200000 -- the household's Claude allowance: tokens in any 24 hours, every run together
);

CREATE TABLE month_override (             -- "just this month" budget changes
  month       TEXT PRIMARY KEY NOT NULL,             -- 'YYYY-MM'
  budget_min_c INTEGER, budget_max_c INTEGER, note TEXT
);

-- Books ------------------------------------------------------------------
CREATE TABLE book (
  id           TEXT PRIMARY KEY NOT NULL,
  title        TEXT NOT NULL,
  subtitle     TEXT,
  authors_json TEXT NOT NULL DEFAULT '[]',
  isbn13       TEXT UNIQUE,
  language     TEXT DEFAULT 'en',
  audience     TEXT NOT NULL CHECK (audience IN ('adult','kids')),
  is_fiction   INTEGER NOT NULL DEFAULT 0,
  age_band     TEXT CHECK (age_band IN ('0-2','3-5','6-8','9-12')),
  cover_path   TEXT,                       -- cached locally under /data/covers
  norm_key     TEXT NOT NULL,              -- normalised title+first author for matching
  created_at   TEXT NOT NULL
);
CREATE INDEX book_norm ON book(norm_key);

CREATE TABLE book_offer (                  -- price estimates and retailer ids
  book_id     TEXT NOT NULL REFERENCES book(id) ON DELETE CASCADE,
  source      TEXT NOT NULL,               -- 'orellfuessli' | 'quote' | 'invoice' | 'manual'
  external_id TEXT,                        -- e.g. A0000000000
  price_c     INTEGER,
  availability TEXT,                       -- raw text, informational only
  seen_at     TEXT NOT NULL,
  PRIMARY KEY (book_id, source)
);

CREATE TABLE book_meta (                   -- Open Library's facts about a book; looked up once, refreshed by hand
  book_id       TEXT PRIMARY KEY NOT NULL REFERENCES book(id) ON DELETE CASCADE,
  source        TEXT NOT NULL,             -- 'openlibrary'
  external_id   TEXT,                      -- e.g. /works/OL0000000W
  description   TEXT,                      -- at most 2000 characters
  subjects_json TEXT NOT NULL DEFAULT '[]',
  cover_id      TEXT,                      -- the source's cover id; the image is fetched, re-encoded and kept as book.cover_path
  status        TEXT NOT NULL CHECK (status IN ('found','not_found')),
  fetched_at    TEXT NOT NULL
);

CREATE TABLE copy (                        -- the household owns it
  id         TEXT PRIMARY KEY NOT NULL,
  book_id    TEXT NOT NULL REFERENCES book(id),
  source     TEXT NOT NULL CHECK (source IN ('order','invoice','manual','seed')),
  order_id   TEXT REFERENCES "order"(id),
  price_c    INTEGER,
  acquired_at TEXT NOT NULL
);

CREATE TABLE reading (                     -- one person's relationship with a book
  person_id  TEXT NOT NULL REFERENCES person(id) ON DELETE CASCADE,
  book_id    TEXT NOT NULL REFERENCES book(id) ON DELETE CASCADE,
  status     TEXT NOT NULL CHECK (status IN ('to_read','reading','read','abandoned')),
  feedback   TEXT CHECK (feedback IN ('loved','meh','not_yet')), -- kids
  takeaway   TEXT,
  finished_at TEXT,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (person_id, book_id)
);

-- Knowledge --------------------------------------------------------------
CREATE TABLE idea (
  id        TEXT PRIMARY KEY NOT NULL,
  name      TEXT NOT NULL UNIQUE,
  merged_into TEXT REFERENCES idea(id)
);

CREATE TABLE book_idea (
  book_id    TEXT NOT NULL REFERENCES book(id) ON DELETE CASCADE,
  idea_id    TEXT NOT NULL REFERENCES idea(id),
  layer      TEXT NOT NULL CHECK (layer IN ('intro','core','deep','counterpoint')),
  confidence REAL NOT NULL,
  state      TEXT NOT NULL DEFAULT 'proposed' CHECK (state IN ('proposed','confirmed','rejected')),
  ai_run_id  TEXT REFERENCES ai_run(id),
  reviewed_by TEXT REFERENCES person(id) ON DELETE SET NULL, -- who confirmed or rejected it; only a person does
  reviewed_at TEXT,
  private_to TEXT REFERENCES person(id) ON DELETE CASCADE, -- written from this person's takeaways: theirs alone (shelf#3)
  PRIMARY KEY (book_id, idea_id)
);

CREATE TABLE idea_proposal (              -- a new idea the AI proposed for a book: a name only, no idea row until a person confirms it
  id          TEXT PRIMARY KEY NOT NULL,
  book_id     TEXT NOT NULL REFERENCES book(id) ON DELETE CASCADE,
  name        TEXT NOT NULL,
  layer       TEXT NOT NULL CHECK (layer IN ('intro','core','deep','counterpoint')),
  confidence  REAL NOT NULL,
  state       TEXT NOT NULL DEFAULT 'proposed' CHECK (state IN ('proposed','confirmed','rejected')),
  ai_run_id   TEXT REFERENCES ai_run(id),
  idea_id     TEXT REFERENCES idea(id),     -- the idea it became once confirmed
  reviewed_by TEXT REFERENCES person(id) ON DELETE SET NULL,
  reviewed_at TEXT,
  private_to  TEXT REFERENCES person(id) ON DELETE CASCADE
);
CREATE UNIQUE INDEX idea_proposal_book_name ON idea_proposal (book_id, name);

CREATE TABLE idea_merge (                  -- who merged which idea into which, and when; an admin can undo it
  id             TEXT PRIMARY KEY NOT NULL,
  idea_id        TEXT NOT NULL REFERENCES idea(id),
  into_id        TEXT NOT NULL REFERENCES idea(id),
  repointed_json TEXT NOT NULL DEFAULT '[]', -- ideas that pointed at idea_id and were re-pointed at into_id
  merged_by      TEXT REFERENCES person(id) ON DELETE SET NULL,
  merged_at      TEXT NOT NULL,
  undone_by      TEXT REFERENCES person(id) ON DELETE SET NULL,
  undone_at      TEXT
);

CREATE TABLE book_link (                   -- candidate builds on a book (the "↳" links), with a reason
  from_book  TEXT NOT NULL REFERENCES book(id) ON DELETE CASCADE,
  to_book    TEXT NOT NULL REFERENCES book(id) ON DELETE CASCADE,
  reason     TEXT NOT NULL,
  confidence REAL NOT NULL,
  state      TEXT NOT NULL DEFAULT 'proposed' CHECK (state IN ('proposed','confirmed','rejected')),
  ai_run_id  TEXT REFERENCES ai_run(id),
  reviewed_by TEXT REFERENCES person(id) ON DELETE SET NULL, -- who confirmed or rejected it; only a person does
  reviewed_at TEXT,
  private_to TEXT REFERENCES person(id) ON DELETE CASCADE, -- written from this person's takeaways: theirs alone (shelf#3)
  PRIMARY KEY (from_book, to_book)
);

CREATE TABLE redundancy (                  -- c repeats r (e.g. a summary of a book already read)
  book_id TEXT NOT NULL REFERENCES book(id), repeats_book TEXT NOT NULL REFERENCES book(id),
  reason TEXT NOT NULL, state TEXT NOT NULL DEFAULT 'proposed', PRIMARY KEY (book_id, repeats_book)
);

CREATE TABLE book_theme (                  -- kids
  book_id TEXT NOT NULL REFERENCES book(id) ON DELETE CASCADE,
  theme   TEXT NOT NULL,                   -- one of the 14 in spec §7
  PRIMARY KEY (book_id, theme)
);

-- Backlog ----------------------------------------------------------------
CREATE TABLE candidate (
  person_id   TEXT NOT NULL REFERENCES person(id) ON DELETE CASCADE, -- adult or kid it is for
  book_id     TEXT NOT NULL REFERENCES book(id) ON DELETE CASCADE,
  origin      TEXT NOT NULL CHECK (origin IN ('wishlist','to_buy','share','ai','manual','seed')),
  share_id    TEXT REFERENCES share(id),
  state       TEXT NOT NULL DEFAULT 'active' CHECK (state IN ('active','not_for_me','snoozed','picked','owned')),
  added_at    TEXT NOT NULL,
  touched_at  TEXT NOT NULL,
  score       REAL,                        -- cache; recomputed by packages/scoring
  score_parts_json TEXT,
  move        TEXT,
  snoozed_until TEXT,                      -- a snoozed candidate opens again after this
  PRIMARY KEY (person_id, book_id)
);

CREATE TABLE saved_filter (                -- the Backlog's saved filters, per person (contracts/backlog-query.md)
  id          TEXT PRIMARY KEY NOT NULL,
  person_id   TEXT NOT NULL REFERENCES person(id) ON DELETE CASCADE,
  name        TEXT NOT NULL,
  q           TEXT NOT NULL,
  created_at  TEXT NOT NULL
);

-- Orders -----------------------------------------------------------------
CREATE TABLE "order" (
  id          TEXT PRIMARY KEY NOT NULL,
  month       TEXT NOT NULL,               -- 'YYYY-MM'
  status      TEXT NOT NULL CHECK (status IN ('picked','drafted','quoted','invoiced','closed')),
  mail_thread_ref TEXT,                    -- Message-ID/References that tie the bookshop's mails to this order
  estimate_c  INTEGER, quoted_c INTEGER, invoiced_c INTEGER,
  created_at  TEXT NOT NULL
);
CREATE TABLE order_line (
  order_id  TEXT NOT NULL REFERENCES "order"(id) ON DELETE CASCADE,
  book_id   TEXT NOT NULL REFERENCES book(id),
  for_person TEXT NOT NULL REFERENCES person(id),
  move      TEXT,                          -- Deepen/Connect/... or kids theme
  why       TEXT,
  estimate_c INTEGER, quoted_c INTEGER, delivery TEXT,
  state     TEXT NOT NULL DEFAULT 'planned' CHECK (state IN ('planned','quoted','unavailable','delivered','rolled_over')),
  why_audience TEXT,                       -- who may read the AI's why (NULL: everyone); its person when built on something private to them
  PRIMARY KEY (order_id, book_id)
);

-- Sources ----------------------------------------------------------------
CREATE TABLE share (
  id         TEXT PRIMARY KEY NOT NULL,
  person_id  TEXT NOT NULL REFERENCES person(id),
  url        TEXT, note TEXT,
  media_json TEXT NOT NULL DEFAULT '[]',   -- stored image/frame paths: the media worker's re-encoded JPEGs only
  status     TEXT NOT NULL CHECK (status IN ('received','reading','done','failed')),
  found_json TEXT,                         -- AI extraction result (contracts/ai/extract_titles.schema.json)
  created_at TEXT NOT NULL,
  title      TEXT, caption TEXT,            -- what the phone sent with it (untrusted: marked so in prompts, shown as text)
  media_total INTEGER NOT NULL DEFAULT 0,  -- files received; progress = kept + refused of this
  media_refused INTEGER NOT NULL DEFAULT 0,-- files the media worker refused (not an image, too many pixels, unreadable)
  error      TEXT,                         -- Shelf's own words when it failed
  token_id   TEXT REFERENCES share_token(id) ON DELETE SET NULL, -- the share token it came with (NULL: a session)
  ai_read_at TEXT                          -- when the AI read it: daily AI reads counted per person and per token
);

CREATE TABLE inbox_decision (              -- what a person decided in the Inbox (M3 e); idx -1: the whole item dismissed
  item        TEXT NOT NULL,               -- 's_<share id>' or 'm_<hash of the mail's key>'
  idx         INTEGER NOT NULL,
  decision    TEXT NOT NULL CHECK (decision IN ('added','skipped','dismissed')),
  person_id   TEXT REFERENCES person(id) ON DELETE SET NULL, -- who decided
  book_id     TEXT REFERENCES book(id) ON DELETE SET NULL,   -- the book it added
  decided_at  TEXT NOT NULL,
  PRIMARY KEY (item, idx)
);

CREATE TABLE mail_seen (                   -- IMAP messages already read (ADR 0007); mail is hostile input
  message_id TEXT PRIMARY KEY NOT NULL, kind TEXT NOT NULL, parsed_json TEXT, parser_version TEXT NOT NULL, seen_at TEXT NOT NULL,
  auth_json  TEXT,                         -- sender, DKIM and ARC results as checked; nothing acts on a mail that fails them
  accepted   INTEGER NOT NULL DEFAULT 0    -- 1 only if the sender and authentication checks passed
);

CREATE TABLE mail_cursor (                 -- where the mail reader stopped, per folder (ADR 0007)
  folder       TEXT PRIMARY KEY NOT NULL,
  uid_validity INTEGER NOT NULL,           -- the folder's UIDVALIDITY; when it changes, reading starts over (mail_seen keeps it idempotent)
  last_uid     INTEGER NOT NULL,
  config_key   TEXT NOT NULL,              -- the checks' settings it read under; when they change, the window is read again
  updated_at   TEXT NOT NULL
);

CREATE TABLE share_token (                 -- phone share tokens (ADR 0009): per person, write-only to /api/shares
  id          TEXT PRIMARY KEY NOT NULL,
  person_id   TEXT NOT NULL REFERENCES person(id) ON DELETE CASCADE,
  label       TEXT NOT NULL,               -- e.g. 'iPhone Shortcut'
  token_hash  TEXT NOT NULL UNIQUE,        -- SHA-256 of the token; the token is shown once and never stored
  created_at  TEXT NOT NULL,
  last_used_at TEXT,
  revoked_at  TEXT
);

CREATE TABLE sealed_secret (               -- the delivery address (ADR 0009); the card number is never stored
  key         TEXT PRIMARY KEY NOT NULL,            -- 'order_address'
  ciphertext  BLOB NOT NULL,               -- AES-256-GCM; the key is outside the database (SHELF_SEALING_KEY_FILE)
  key_id      TEXT NOT NULL,
  updated_at  TEXT NOT NULL
);

CREATE TABLE ai_run (
  id TEXT PRIMARY KEY NOT NULL, job TEXT NOT NULL, provider TEXT NOT NULL, model TEXT NOT NULL,
  prompt_version TEXT NOT NULL, input_hash TEXT NOT NULL, output_json TEXT, cost_c INTEGER,
  started_at TEXT NOT NULL, finished_at TEXT, error TEXT,
  takeaways_of TEXT REFERENCES person(id) ON DELETE CASCADE, -- whose takeaways the input held; purged when they opt out
  person_id    TEXT REFERENCES person(id) ON DELETE CASCADE, -- whose request it served (a share's sharer, a suggestion's person); NULL: the household's
  tokens       INTEGER NOT NULL DEFAULT 0  -- tokens the provider counted (input and output, every attempt): the daily allowance sums them
);
CREATE INDEX ai_run_cache ON ai_run (job, prompt_version, input_hash); -- identical input + prompt version reuses the output
CREATE INDEX ai_run_spend ON ai_run (provider, started_at);

CREATE TABLE job_run (
  id TEXT PRIMARY KEY NOT NULL, job TEXT NOT NULL, status TEXT NOT NULL, detail TEXT, started_at TEXT NOT NULL, finished_at TEXT
);

-- Privacy of proposals (shelf#3): private_to follows the AI run's takeaways_of, whoever writes the row.
CREATE TRIGGER book_link_private_to_check_insert BEFORE INSERT ON book_link
WHEN NEW.ai_run_id IS NOT NULL AND NEW.private_to IS NOT NULL AND NEW.private_to IS NOT (SELECT takeaways_of FROM ai_run WHERE id = NEW.ai_run_id)
BEGIN SELECT RAISE(ABORT, 'book_link.private_to must be its run''s takeaways_of'); END;
CREATE TRIGGER book_link_private_to_check_update BEFORE UPDATE OF ai_run_id, private_to ON book_link
WHEN NEW.ai_run_id IS NOT NULL AND NEW.private_to IS NOT (SELECT takeaways_of FROM ai_run WHERE id = NEW.ai_run_id)
BEGIN SELECT RAISE(ABORT, 'book_link.private_to must be its run''s takeaways_of'); END;
CREATE TRIGGER book_link_private_to_fill AFTER INSERT ON book_link
WHEN NEW.ai_run_id IS NOT NULL AND NEW.private_to IS NULL AND (SELECT takeaways_of FROM ai_run WHERE id = NEW.ai_run_id) IS NOT NULL
BEGIN UPDATE book_link SET private_to = (SELECT takeaways_of FROM ai_run WHERE id = NEW.ai_run_id) WHERE from_book = NEW.from_book AND to_book = NEW.to_book; END;
CREATE TRIGGER book_idea_private_to_check_insert BEFORE INSERT ON book_idea
WHEN NEW.ai_run_id IS NOT NULL AND NEW.private_to IS NOT NULL AND NEW.private_to IS NOT (SELECT takeaways_of FROM ai_run WHERE id = NEW.ai_run_id)
BEGIN SELECT RAISE(ABORT, 'book_idea.private_to must be its run''s takeaways_of'); END;
CREATE TRIGGER book_idea_private_to_check_update BEFORE UPDATE OF ai_run_id, private_to ON book_idea
WHEN NEW.ai_run_id IS NOT NULL AND NEW.private_to IS NOT (SELECT takeaways_of FROM ai_run WHERE id = NEW.ai_run_id)
BEGIN SELECT RAISE(ABORT, 'book_idea.private_to must be its run''s takeaways_of'); END;
CREATE TRIGGER book_idea_private_to_fill AFTER INSERT ON book_idea
WHEN NEW.ai_run_id IS NOT NULL AND NEW.private_to IS NULL AND (SELECT takeaways_of FROM ai_run WHERE id = NEW.ai_run_id) IS NOT NULL
BEGIN UPDATE book_idea SET private_to = (SELECT takeaways_of FROM ai_run WHERE id = NEW.ai_run_id) WHERE book_id = NEW.book_id AND idea_id = NEW.idea_id; END;
CREATE TRIGGER book_link_private_to_kept BEFORE UPDATE OF private_to ON book_link
WHEN OLD.private_to IS NOT NULL AND NEW.private_to IS NOT OLD.private_to
BEGIN SELECT RAISE(ABORT, 'book_link.private_to never changes once set (delete the row instead)'); END;
CREATE TRIGGER book_idea_private_to_kept BEFORE UPDATE OF private_to ON book_idea
WHEN OLD.private_to IS NOT NULL AND NEW.private_to IS NOT OLD.private_to
BEGIN SELECT RAISE(ABORT, 'book_idea.private_to never changes once set (delete the row instead)'); END;
CREATE TRIGGER ai_run_takeaways_of_fixed BEFORE UPDATE OF takeaways_of ON ai_run
WHEN NEW.takeaways_of IS NOT OLD.takeaways_of AND (EXISTS (SELECT 1 FROM book_link WHERE ai_run_id = OLD.id) OR EXISTS (SELECT 1 FROM book_idea WHERE ai_run_id = OLD.id))
BEGIN SELECT RAISE(ABORT, 'ai_run.takeaways_of is fixed once the run has proposals'); END;
CREATE TRIGGER ai_run_with_takeaways_delete BEFORE DELETE ON ai_run
WHEN OLD.takeaways_of IS NOT NULL AND (EXISTS (SELECT 1 FROM book_link WHERE ai_run_id = OLD.id) OR EXISTS (SELECT 1 FROM book_idea WHERE ai_run_id = OLD.id))
BEGIN SELECT RAISE(ABORT, 'a run with takeaways goes only after its proposals are deleted or let go (purgeTakeawayRuns)'); END;
-- An insert over a private row (INSERT OR REPLACE) must itself name the same private_to; leaving it to the fill trigger
-- is refused too, since that runs after the insert.
CREATE TRIGGER book_link_private_not_replaced BEFORE INSERT ON book_link
WHEN EXISTS (SELECT 1 FROM book_link WHERE from_book = NEW.from_book AND to_book = NEW.to_book AND private_to IS NOT NULL AND private_to IS NOT NEW.private_to)
BEGIN SELECT RAISE(ABORT, 'book_link: a private row is never replaced (INSERT OR REPLACE) without its private_to'); END;
CREATE TRIGGER book_idea_private_not_replaced BEFORE INSERT ON book_idea
WHEN EXISTS (SELECT 1 FROM book_idea WHERE book_id = NEW.book_id AND idea_id = NEW.idea_id AND private_to IS NOT NULL AND private_to IS NOT NEW.private_to)
BEGIN SELECT RAISE(ABORT, 'book_idea: a private row is never replaced (INSERT OR REPLACE) without its private_to'); END;
-- A new idea's proposal (M3 g): private_to is its run's takeaways_of, and never changes.
CREATE TRIGGER idea_proposal_private_to_check_insert BEFORE INSERT ON idea_proposal
WHEN NEW.ai_run_id IS NOT NULL AND NEW.private_to IS NOT (SELECT takeaways_of FROM ai_run WHERE id = NEW.ai_run_id)
BEGIN SELECT RAISE(ABORT, 'idea_proposal.private_to must be its run''s takeaways_of'); END;
CREATE TRIGGER idea_proposal_private_to_kept BEFORE UPDATE OF private_to ON idea_proposal
WHEN NEW.private_to IS NOT OLD.private_to
BEGIN SELECT RAISE(ABORT, 'idea_proposal.private_to never changes (delete the row instead)'); END;
