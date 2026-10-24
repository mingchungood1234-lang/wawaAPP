// Web Push: VAPID keys and subscriptions live in the data dir.
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import webpush from 'web-push';

export function createPush({ dataDir, contact }) {
  const keyFile = join(dataDir, 'vapid.json');
  const subsFile = join(dataDir, 'push-subscriptions.json');

  if (!existsSync(keyFile)) writeFileSync(keyFile, JSON.stringify(webpush.generateVAPIDKeys()), { mode: 0o600 });
  const keys = JSON.parse(readFileSync(keyFile, 'utf8'));
  webpush.setVapidDetails(contact, keys.publicKey, keys.privateKey);

  let subs = existsSync(subsFile) ? JSON.parse(readFileSync(subsFile, 'utf8')) : [];
  const save = () => writeFileSync(subsFile, JSON.stringify(subs));

  return {
    publicKey: keys.publicKey,

    subscribe(sub) {
      if (!sub?.endpoint) return;
      subs = subs.filter((s) => s.endpoint !== sub.endpoint).concat(sub);
      save();
    },

    unsubscribe(endpoint) {
      subs = subs.filter((s) => s.endpoint !== endpoint);
      save();
    },

    async send(payload) {
      const body = JSON.stringify(payload);
      const results = await Promise.allSettled(subs.map((s) => webpush.sendNotification(s, body, { TTL: 3600 })));
      // Drop subscriptions the push service says are gone.
      const dead = results
        .map((r, i) => (r.status === 'rejected' && [404, 410].includes(r.reason?.statusCode) ? subs[i].endpoint : null))
        .filter(Boolean);
      if (dead.length) {
        subs = subs.filter((s) => !dead.includes(s.endpoint));
        save();
      }
    },
  };
}
