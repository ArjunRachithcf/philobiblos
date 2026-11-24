// The Library and the settings (spec §4): your own, and the household's budget (admins). The rules are in src/library/
// and src/household/budget.ts.
import type { FastifyInstance, FastifyReply } from 'fastify';
import type { Config } from '../config';
import type { Db } from '../db/open';
import { SealError, isSealed, keyProblem, seal, sealingKey, unseal } from '../household/sealed';
import { EMAIL } from '../month/order-mail';
import { SEALED } from './month';
import { BudgetError, getBudget, setBudget } from '../household/budget';
import { getPerson } from '../household/people';
import { LibraryError, getLibrary, setReading } from '../library/library';
import { SettingsError, personSettings, updatePersonSettings } from '../library/settings';
import * as ex from '../stubs/examples';
import { SealKeyMissing, aiView, checkAi } from '../ai/settings';
import { CycleError, cycleView, setCycle } from '../jobs/schedule';
import { MoneyError, checkMoney, getMoney } from '../household/money';
import { enabledConnectors } from '../connectors/enabled';
import type { Registry } from '../connectors/load';
import { mailView } from '../mail/oauth';

export const ADDRESS_MAX = 300;

/** Settings.order: the bookshop's address and the delivery address, sealed (household/sealed.ts); admins set them. */
function checkOrder(v: unknown): { bookshopEmail?: string | null; deliveryAddress?: string | null } {
  if (!v || typeof v !== 'object' || Array.isArray(v)) throw new SettingsError('order: a JSON object is needed');
  const o = { ...(v as Record<string, unknown>) };
  // Lines end in \n however the browser or a script sent them (\r\n and \r are the same line break).
  if (typeof o.deliveryAddress === 'string') o.deliveryAddress = o.deliveryAddress.replace(/\r\n?/g, '\n');
  for (const k of Object.keys(o)) if (k !== 'bookshopEmail' && k !== 'deliveryAddress') throw new SettingsError(`order: ${k} is not one of its settings`);
  if (o.bookshopEmail !== undefined && o.bookshopEmail !== null && (typeof o.bookshopEmail !== 'string' || !EMAIL.test(o.bookshopEmail.trim()))) throw new SettingsError('order.bookshopEmail: one e-mail address');
  if (o.deliveryAddress !== undefined && o.deliveryAddress !== null && (typeof o.deliveryAddress !== 'string' || !o.deliveryAddress.trim() || o.deliveryAddress.length > ADDRESS_MAX || [...o.deliveryAddress].some((c) => (c < ' ' && c !== '\n') || c === '\u007f'))) {
    throw new SettingsError(`order.deliveryAddress: up to ${ADDRESS_MAX} characters, lines of plain text (no tabs or other control characters)`);
  }
  return {
    ...(o.bookshopEmail !== undefined ? { bookshopEmail: typeof o.bookshopEmail === 'string' ? o.bookshopEmail.trim() : null } : {}),
    ...(o.deliveryAddress !== undefined ? { deliveryAddress: typeof o.deliveryAddress === 'string' ? o.deliveryAddress.trim() : null } : {}),
  };
}

export async function libraryRoutes(app: FastifyInstance, cfg: Config, db: Db, connectors: Registry) {
  const fail = (reply: FastifyReply, e: unknown) => {
    if (e instanceof LibraryError) return reply.code(e.status).send({ error: e.message });
    if (e instanceof SettingsError || e instanceof BudgetError || e instanceof CycleError) return reply.code(400).send({ error: e.message });
    if (e instanceof SealKeyMissing) return reply.code(409).send({ error: e.message });
    if (e instanceof MoneyError) return reply.code(e.status).send({ error: e.message });
    if (e instanceof SealError) return reply.code(409).send({ error: 'the sealing key is missing or wrong; see PHILOBIBLOS_SEALING_KEY' });
    throw e;
  };

  app.get<{ Params: { personId: string } }>('/people/:personId/library', async (req, reply) => {
    try { return getLibrary(db, req.caller!.personId, req.params.personId); } catch (e) { return fail(reply, e); }
  });

  app.put<{ Params: { personId: string; bookId: string } }>('/people/:personId/reading/:bookId', async (req, reply) => {
    try { return setReading(db, req.caller!.personId, req.params.personId, req.params.bookId, req.body); } catch (e) { return fail(reply, e); }
  });

  // Your own part, the budget, where orders go and the AI are real; the other household parts stay examples until their screens.
  app.get('/settings', async (req, reply) => {
    try {
      // The delivery address never leaves sealed storage except in a Compose text; Settings says only whether it is set.
      // The key is read only when something is sealed (a standalone Philobiblos makes its key on the first seal).
      // A key that was replaced or lost leaves the sealed rows unreadable: Settings still answers, without them, and says
      // they need entering again (docs/security.md, "Rotating the sealing key").
      let email: string | null = null;
      let needsReentry = false;
      // A key that is missing or unreadable is the server's configuration, not the addresses: canSeal false says so.
      const problem = keyProblem(cfg);
      if (!problem) {
        for (const name of [SEALED.bookshopEmail, SEALED.deliveryAddress]) {
          if (!isSealed(db, name)) continue;
          try { const v = unseal(db, sealingKey(cfg), name); if (name === SEALED.bookshopEmail) email = v; } catch (e) { if (!(e instanceof SealError)) throw e; needsReentry = true; }
        }
      }
      const order = { bookshopEmail: email, hasDelivery: isSealed(db, SEALED.deliveryAddress), canSeal: problem === null, ...(problem ? { keyProblem: problem } : {}), needsReentry };
      // The mailbox as configured in the environment (its password never leaves it), and with XOAUTH2 what connecting
      // allows and whether it is connected (never a token).
      const mail = mailView(db, cfg);
      return { ...ex.settings, budget: getBudget(db), cycle: cycleView(db, 'monthly'), person: personSettings(getPerson(db, req.caller!.personId)!), order, mail, ai: aiView(db, cfg), money: getMoney(db) };
    } catch (e) { return fail(reply, e); }
  });
  app.patch<{ Body: { person?: unknown; budget?: unknown; order?: unknown; ai?: unknown; cycle?: unknown; money?: unknown } }>('/settings', async (req, reply) => {
    const body = req.body;
    if (!body || typeof body !== 'object' || Array.isArray(body)) return reply.code(400).send({ error: 'a JSON object is needed' });
    // The household's settings are admins'; parts not stored yet answer 400: never a silent 200.
    const household = Object.keys(body).filter((k) => k !== 'person');
    if (household.length && req.caller!.role !== 'admin') return reply.code(403).send({ error: 'admins change the household\'s settings' });
    const unstored = household.filter((k) => k !== 'budget' && k !== 'order' && k !== 'ai' && k !== 'cycle' && k !== 'money');
    if (unstored.length) return reply.code(400).send({ error: `not stored yet: ${unstored.join(', ')}` });
    try {
      // All or nothing: both parts are checked before either is written.
      const order = body.order === undefined ? null : checkOrder(body.order);
      if (order && keyProblem(cfg)) return reply.code(409).send({ error: `the sealing key is ${keyProblem(cfg)}: fix PHILOBIBLOS_SEALING_KEY (or PHILOBIBLOS_SEALING_KEY_FILE) on the server` });
      const key = order ? sealingKey(cfg) : null;
      // The AI part: the opt-in and the Claude key's sealing are checked here too, before anything is written.
      const ai = body.ai === undefined ? null : checkAi(db, cfg, body.ai);
      // The currency never changes under an enabled connector in another one (household/money.ts).
      const money = body.money === undefined ? null : checkMoney(body.money, enabledConnectors(db, connectors).map((e) => ({ name: e.connector.name, currency: e.connector.locale.currency })));
      db.transaction((tx) => {
        ai?.(tx as unknown as Db);
        money?.(tx as unknown as Db);
        if (body.budget !== undefined) setBudget(tx as unknown as Db, body.budget);
        if (body.cycle !== undefined) setCycle(tx as unknown as Db, body.cycle);
        if (order?.bookshopEmail !== undefined) seal(tx as unknown as Db, key!, SEALED.bookshopEmail, order.bookshopEmail);
        if (order?.deliveryAddress !== undefined) seal(tx as unknown as Db, key!, SEALED.deliveryAddress, order.deliveryAddress);
        if (body.person !== undefined) updatePersonSettings(tx as unknown as Db, getPerson(tx as unknown as Db, req.caller!.personId)!, body.person);
      });
      return {};
    } catch (e) { return fail(reply, e); }
  });
}
