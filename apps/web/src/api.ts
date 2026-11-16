// The API client: same origin, cookies only (the session is HttpOnly), JSON in and out. Errors carry the server's
// message, which is written for people to read.
import type { components } from '@shelf/contracts/openapi';

export type Person = components['schemas']['Person'];
export type AuthSession = components['schemas']['AuthSession'];
export type Me = components['schemas']['Me'];
export type Passkey = components['schemas']['Passkey'];
export type PersonInput = components['schemas']['PersonInput'];
export type PersonPatch = components['schemas']['PersonPatch'];
export type Library = components['schemas']['Library'];
export type Reading = components['schemas']['Reading'];
export type Settings = components['schemas']['Settings'];
export type Candidate = components['schemas']['Candidate'];
export type Brain = components['schemas']['Brain'];
export type Proposals = components['schemas']['Proposals'];
export type Layer = components['schemas']['Layer'];
export type InboxItem = components['schemas']['InboxItem'];
export type Share = components['schemas']['Share'];
export type ShareToken = components['schemas']['ShareToken'];

export class ApiError extends Error {
  constructor(readonly status: number, message: string) { super(message); }
}

export async function api<T>(path: string, init: { method?: string; body?: unknown } = {}): Promise<T> {
  const res = await fetch(`/api${path}`, {
    method: init.method ?? 'GET',
    credentials: 'same-origin',
    headers: init.body === undefined ? {} : { 'content-type': 'application/json' },
    body: init.body === undefined ? undefined : JSON.stringify(init.body),
  });
  if (res.status === 204) return undefined as T;
  const data: unknown = await res.json().catch(() => ({}));
  if (!res.ok) {
    const msg = (data as { error?: string }).error;
    throw new ApiError(res.status, msg ?? (res.status === 429 ? 'Too many tries; wait a minute.' : 'Something went wrong.'));
  }
  return data as T;
}

export const message = (e: unknown) => (e instanceof Error ? e.message : 'Something went wrong.');
