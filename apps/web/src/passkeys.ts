// The browser's half of a passkey (WebAuthn) with @simplewebauthn/browser.
import { startAuthentication, startRegistration, WebAuthnError } from '@simplewebauthn/browser';
import { api, type AuthSession } from './api';

interface Start { challengeId: string; options: object; person?: { name: string } }

const friendly = (e: unknown): Error => {
  if (e instanceof WebAuthnError || (e instanceof Error && e.name === 'NotAllowedError')) {
    return new Error('The passkey was not used. Try again when you are ready.');
  }
  return e instanceof Error ? e : new Error('Something went wrong.');
};

export async function enrolOptions(token: string, name?: string): Promise<Start> {
  return api<Start>('/auth/enrol/options', { method: 'POST', body: { token, ...(name ? { name } : {}) } });
}

export async function finishEnrol(start: Start, label: string): Promise<AuthSession> {
  let response;
  try {
    response = await startRegistration({ optionsJSON: start.options as Parameters<typeof startRegistration>[0]['optionsJSON'] });
  } catch (e) { throw friendly(e); }
  return api<AuthSession>('/auth/enrol/verify', { method: 'POST', body: { challengeId: start.challengeId, response, label } });
}

export async function signIn(): Promise<AuthSession> {
  const start = await api<Start>('/auth/sign-in/options', { method: 'POST' });
  let response;
  try {
    response = await startAuthentication({ optionsJSON: start.options as Parameters<typeof startAuthentication>[0]['optionsJSON'] });
  } catch (e) { throw friendly(e); }
  return api<AuthSession>('/auth/sign-in/verify', { method: 'POST', body: { challengeId: start.challengeId, response } });
}
