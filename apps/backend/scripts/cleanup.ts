import 'dotenv/config';
import { loadConfig } from '../src/config.js';
import { deleteExpiredEmailBodyCache, openDatabase } from '../src/db.js';

async function main() {
  const config = loadConfig();
  const db = openDatabase(config);
  const deleted = deleteExpiredEmailBodyCache(db);
  db.close();
  console.log(`Deleted ${deleted} expired SQLite email body cache row(s). Gmail was not accessed.`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
