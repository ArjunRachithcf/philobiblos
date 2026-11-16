// Web Push in the page: this browser's subscription, always for the server's key of now. A subscription the browser
// still holds (for an earlier key, after an admin made a new one) is removed first: the Push API refuses to subscribe
// with another applicationServerKey while one exists (InvalidStateError).
export async function freshSubscription(pm: Pick<PushManager, 'getSubscription' | 'subscribe'>, applicationServerKey: BufferSource): Promise<PushSubscription> {
  const old = await pm.getSubscription();
  if (old) await old.unsubscribe();
  return pm.subscribe({ userVisibleOnly: true, applicationServerKey });
}
