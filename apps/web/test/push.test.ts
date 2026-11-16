// Turning notifications on (src/push.ts): a subscription the browser still holds is removed before the new one.
import { describe, expect, it } from 'vitest';
import { freshSubscription } from '../src/push';

describe('freshSubscription', () => {
  it('an old subscription (an earlier key) is removed first; then the new key is used', async () => {
    const log: string[] = [];
    const sub = (name: string) => ({ name, unsubscribe: async () => { log.push(`unsubscribe ${name}`); return true; } });
    let held: ReturnType<typeof sub> | null = sub('old');
    const pm = {
      getSubscription: async () => held,
      subscribe: async (o: { userVisibleOnly: boolean; applicationServerKey: Uint8Array }) => {
        if (log.at(-1) !== 'unsubscribe old' && held) throw new Error('InvalidStateError');
        log.push(`subscribe ${Array.from(o.applicationServerKey).join(',')} ${o.userVisibleOnly}`);
        held = sub('new');
        return held;
      },
    };
    const pushManager = pm as unknown as PushManager;
    expect(((await freshSubscription(pushManager, new Uint8Array([4, 1]))) as unknown as { name: string }).name).toBe('new');
    expect(log).toEqual(['unsubscribe old', 'subscribe 4,1 true']);
    held = null; log.length = 0;
    await freshSubscription(pushManager, new Uint8Array([4, 2]));
    expect(log).toEqual(['subscribe 4,2 true']);
  });
});
