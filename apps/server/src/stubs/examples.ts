// Example payloads for the M0 stubs. contracts/openapi.yaml has no `example`s, so these are made up; they are typed
// against the generated API types and checked against the spec at runtime (test/routes.contract.test.ts).
import type { components } from '@shelf/contracts/openapi';

type S = components['schemas'];

export const alex: S['Person'] = { id: 'p_alex', name: 'Alex', role: 'admin', ageBand: null };
export const sam: S['Person'] = { id: 'p_sam', name: 'Sam', role: 'adult', ageBand: null };
export const kid: S['Person'] = { id: 'p_kid1', name: 'Kid 1', role: 'kid', ageBand: '3-5' };

const valueBeyondPrice: S['BookRef'] = { id: 'b_value', title: 'Value Beyond Price', authors: ['Mira Okafor'], audience: 'adult', isFiction: false };
const longTide: S['BookRef'] = { id: 'b_tide', title: 'The Long Tide of Markets', authors: ['Mira Okafor'], audience: 'adult', isFiction: false };
const kite: S['BookRef'] = { id: 'b_kite', title: 'The Brave Little Kite', authors: ['Noor Haddad'], audience: 'kids', isFiction: false };

export const candidate: S['Candidate'] = {
  id: 'p_alex:b_value',
  book: valueBeyondPrice,
  for: alex,
  state: 'open',
  closedReason: null,
  move: 'connect',
  ideas: [{ id: 'i_markets', name: 'Markets and value', layer: 'core' }],
  theme: null,
  buildsOn: [{ book: longTide, reason: "the same author's sequel", confidence: 1, state: 'confirmed' }],
  source: 'to_buy',
  addedAt: '2026-06-02T00:00:00.000Z',
  price: 2490,
  priceIsEstimate: true,
  score: 49,
  scoreParts: [
    { label: 'Builds on books read', value: 30, kind: 'links' },
    { label: 'Bridges ideas', value: 8, kind: 'bridge' },
    { label: 'Idea not fed lately', value: 6, kind: 'stale' },
    { label: 'On the To buy list', value: 5, kind: 'source' },
  ],
};

const kidCandidate: S['Candidate'] = {
  ...candidate, id: 'p_kid1:b_kite', book: kite, for: kid, move: undefined, ideas: [], theme: 'Courage & resilience',
  buildsOn: [], source: 'share', price: 2500, score: 37.57, scoreParts: [{ label: 'A new theme for this kid', value: 15, kind: 'themeNew' }],
};

export const order: S['Order'] = {
  id: 'o_2026_12',
  month: '2026-12',
  status: 'picked',
  composeUrl: 'mailto:english-orders@orellfuessli.ch?subject=Book%20order&body=Dear%20English%20Bookshop%20Team',
  estimate: 4990,
  lines: [
    { book: valueBeyondPrice, for: alex.id, estimate: 2490, state: 'planned' },
    { book: kite, for: kid.id, estimate: 2500, state: 'planned' },
  ],
};

export const monthPlan = (month: string): S['MonthPlan'] => ({
  month,
  budget: { min: 10000, max: 15000 },
  budgetIsOverride: false,
  total: 4990,
  adults: [{ person: alex, picks: [{ candidate, move: 'connect', why: "Builds on The Long Tide of Markets: the same author's sequel", idea: 'Markets and value' }], unreadPile: 2, unreadLimit: 6 }],
  kids: [{ person: kid, picks: [{ candidate: kidCandidate, move: undefined, why: 'A theme the shelf does not have yet', idea: 'Courage & resilience' }] }],
  focus: [{ move: 'connect', ideas: ['Markets and value', 'Care and the commons'], bookId: valueBeyondPrice.id, sentence: 'Connect markets with care this month.' }],
  nextBroaden: { month: '2027-02', idea: 'Early history', bookId: 'b_cities' },
  order: null,
});

export const settings: S['Settings'] = {
  budget: { min: 10000, max: 15000 },
  adultPicks: 2,
  newAuthorsOnly: true,
  ai: { provider: 'ollama', model: 'llama3.2-vision', ollamaUrl: 'http://ollama:11434', leaves: [], jobs: { read: true, link: true, suggest: true, explain: true, wildcards: true } },
  person: { mix: 'deepen_connect', unreadLimit: 4, counterpoints: true, takeaways: true, takeawaysToAi: false, fiction: false, weights: {} },
  kidsThemes: [{ theme: 'Friendship', enabled: true }],
  cycle: { day: 1, time: '20:17', timezone: 'Europe/Zurich' },
  mail: { host: '', port: 993, user: '', folder: 'INBOX', configured: false },
};
