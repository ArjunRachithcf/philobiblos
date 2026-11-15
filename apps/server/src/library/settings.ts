// A person's own settings (Settings.person in contracts/openapi.yaml), kept in person.settings_json. Only the keys
// below are stored; each has a default, so a new person needs nothing.
import { eq } from 'drizzle-orm';
import type { components } from '@shelf/contracts/openapi';
import type { Db } from '../db/open';
import * as t from '../db/schema';
import type { Person } from '../household/people';
import { purgeTakeawayRuns } from './ai-context';

type PersonSettings = Required<Omit<NonNullable<components['schemas']['Settings']['person']>, 'weights'>>;

export const DEFAULTS: PersonSettings = {
  mix: 'deepen_connect',
  unreadLimit: 4,
  counterpoints: true,
  takeaways: true, // ask for one line when a book is marked read
  takeawaysToAi: false, // no AI reads takeaways unless the person turns this on (ADR 0009)
  fiction: false,
};

export class SettingsError extends Error {}

export function personSettings(p: Pick<Person, 'settingsJson'>): PersonSettings {
  let stored: Record<string, unknown> = {};
  try { stored = JSON.parse(p.settingsJson) as Record<string, unknown>; } catch { /* a broken value falls back to the defaults */ }
  const out = { ...DEFAULTS };
  for (const k of Object.keys(DEFAULTS) as (keyof PersonSettings)[]) {
    if (k in stored && validate(k, stored[k]) === null) (out as Record<string, unknown>)[k] = stored[k];
  }
  return out;
}

function validate(k: keyof PersonSettings, v: unknown): string | null {
  switch (k) {
    case 'mix': return v === 'deepen_connect' || v === 'deepen_broaden' || v === 'ai' ? null : 'mix: deepen_connect, deepen_broaden or ai';
    case 'unreadLimit': return Number.isInteger(v) && (v as number) >= 0 && (v as number) <= 50 ? null : 'unreadLimit: a whole number from 0 to 50';
    default: return typeof v === 'boolean' ? null : `${k}: true or false`;
  }
}

/** Applies a partial Settings.person to a person; throws SettingsError with a message for people on a bad value. */
export function updatePersonSettings(db: Db, p: Person, patch: unknown): PersonSettings {
  if (!patch || typeof patch !== 'object' || Array.isArray(patch)) throw new SettingsError('person: a JSON object is needed');
  const next = personSettings(p) as Record<string, unknown>;
  for (const [k, v] of Object.entries(patch)) {
    if (!(k in DEFAULTS)) throw new SettingsError(`person: unknown or not yet stored setting ${k}`);
    const err = validate(k as keyof PersonSettings, v);
    if (err) throw new SettingsError(err);
    next[k] = v;
  }
  const wasOn = personSettings(p).takeawaysToAi;
  db.update(t.person).set({ settingsJson: JSON.stringify(next) }).where(eq(t.person.id, p.id)).run();
  if (wasOn && next.takeawaysToAi === false) purgeTakeawayRuns(db, p.id);
  return next as PersonSettings;
}
