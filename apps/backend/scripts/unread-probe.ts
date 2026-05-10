import 'dotenv/config';
import { loadConfig } from '../src/config.js';
import { createGmailClient } from '../src/gmail.js';

async function countQuery(client: ReturnType<typeof createGmailClient>, q: string): Promise<{ count: number; sample: Array<{ id: string; from: string; subject: string; date: string }> }> {
  const list = await client.users.messages.list({ userId: 'me', q, maxResults: 5 });
  const messages = list.data.messages || [];
  const total = list.data.resultSizeEstimate ?? messages.length;
  const sample = await Promise.all(messages.slice(0, 3).map(async (ref) => {
    if (!ref.id) return { id: '?', from: '?', subject: '?', date: '?' };
    const msg = await client.users.messages.get({ userId: 'me', id: ref.id, format: 'metadata', metadataHeaders: ['From', 'Subject', 'Date'] });
    const headers = msg.data.payload?.headers || [];
    const get = (n: string) => headers.find((h) => h.name?.toLowerCase() === n.toLowerCase())?.value || '';
    return {
      id: ref.id,
      from: get('From').slice(0, 50),
      subject: get('Subject').slice(0, 60),
      date: get('Date')
    };
  }));
  return { count: total, sample };
}

async function main() {
  const config = loadConfig();
  const lookbackHours = config.digest.lookbackHours;
  const afterSeconds = Math.floor((Date.now() - lookbackHours * 60 * 60 * 1000) / 1000);
  console.log(`Config: lookbackHours=${lookbackHours}, maxMessages=${config.digest.maxMessages}, unreadOnly=${config.digest.unreadOnly}`);
  console.log(`Effective query window: after:${afterSeconds} (${new Date(afterSeconds * 1000).toISOString()})\n`);

  for (const account of config.google.accounts) {
    const client = createGmailClient(config, account);
    const profile = await client.users.getProfile({ userId: 'me' });
    const email = profile.data.emailAddress || account.id;

    const all = await countQuery(client, 'in:inbox is:unread');
    const windowed = await countQuery(client, `in:inbox is:unread -in:spam -in:trash after:${afterSeconds}`);

    console.log(`[${account.id}] ${email}`);
    console.log(`  unread in inbox (no time filter): ${all.count}`);
    console.log(`  unread in inbox within ${lookbackHours}h: ${windowed.count}`);
    if (all.count > windowed.count) {
      console.log(`  -> ${all.count - windowed.count} unread message(s) outside the lookback window will NOT be processed.`);
    }
    if (all.sample.length > 0) {
      console.log('  recent unread samples:');
      for (const item of all.sample) {
        console.log(`    - ${item.date} | ${item.from} | ${item.subject}`);
      }
    }
    console.log('');
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
