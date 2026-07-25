import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import readline from 'node:readline/promises';
import { stdin as input, stdout as output } from 'node:process';
import 'dotenv/config';
import { google } from 'googleapis';

const scope = 'https://www.googleapis.com/auth/gmail.readonly';
const accountId = process.argv[2];
const accountName = process.argv[3] || accountId;
const accountsPath = process.env.GMAIL_ACCOUNTS_JSON || 'config/gmail-accounts.json';

function required(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

const clientId = required('GOOGLE_CLIENT_ID');
const clientSecret = required('GOOGLE_CLIENT_SECRET');
const redirectUri = process.env.GOOGLE_REDIRECT_URI || 'http://localhost';

const oauth2Client = new google.auth.OAuth2(clientId, clientSecret, redirectUri);
const authUrl = oauth2Client.generateAuthUrl({
  access_type: 'offline',
  prompt: 'consent',
  scope: [scope]
});

console.log('\nOpen this URL in your browser:\n');
console.log(authUrl);
console.log('\nAfter approving access, paste the full redirected URL or just the "code" value.\n');

const rl = readline.createInterface({ input, output });
const rawCode = await rl.question('Authorization code or redirected URL: ');
rl.close();

const { tokens } = await oauth2Client.getToken(extractAuthorizationCode(rawCode));

if (!tokens.refresh_token) {
  console.error('\nNo refresh_token returned.');
  console.error('Make sure the OAuth consent screen includes your Gmail as a test user, then rerun this script.');
  process.exit(1);
}

if (!accountId) {
  console.log('\nAdd this to .env:\n');
  console.log(`GOOGLE_REFRESH_TOKEN=${tokens.refresh_token}`);
  console.log('\nFor JSON account config, rerun with: npm run google:auth -- <account_id> "<Display Name>"');
} else {
  writeAccountToken(accountId, accountName || accountId, tokens.refresh_token);
}

function writeAccountToken(id: string, displayName: string, refreshToken: string): void {
  if (!/^[a-zA-Z0-9_-]+$/.test(id)) {
    throw new Error(`Account id must contain only letters, numbers, "_" or "-": ${id}`);
  }

  const tokenPath = `config/google-tokens/${id}.json`;
  mkdirSync(dirname(tokenPath), { recursive: true, mode: 0o700 });
  writeFileSync(
    tokenPath,
    `${JSON.stringify({ refresh_token: refreshToken }, null, 2)}\n`,
    { mode: 0o600 }
  );

  const config = readAccountsConfig(accountsPath);
  const account = {
    id,
    displayName,
    refreshTokenFile: tokenPath
  };
  const index = config.accounts.findIndex((item) => item.id === id);
  if (index >= 0) {
    config.accounts[index] = account;
  } else {
    config.accounts.push(account);
  }

  mkdirSync(dirname(accountsPath), { recursive: true });
  writeFileSync(accountsPath, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });

  console.log(`\nWrote token: ${tokenPath}`);
  console.log(`Updated accounts config: ${accountsPath}`);
}

function readAccountsConfig(path: string): { accounts: Array<{ id: string; displayName: string; refreshTokenFile: string }> } {
  if (!existsSync(path)) {
    return { accounts: [] };
  }
  const parsed = JSON.parse(readFileSync(path, 'utf8')) as {
    accounts?: Array<{ id?: string; displayName?: string; refreshTokenFile?: string }>;
  };
  return {
    accounts: (parsed.accounts || []).map((account) => {
      if (!account.id || !account.displayName || !account.refreshTokenFile) {
        throw new Error(`${path} contains an invalid account entry`);
      }
      return {
        id: account.id,
        displayName: account.displayName,
        refreshTokenFile: account.refreshTokenFile
      };
    })
  };
}

function extractAuthorizationCode(inputValue: string): string {
  const trimmed = inputValue.trim();
  if (!trimmed) {
    throw new Error('Authorization code is required');
  }

  try {
    const url = new URL(trimmed);
    const code = url.searchParams.get('code');
    if (!code) {
      throw new Error('Redirected URL does not include a code query parameter');
    }
    return code;
  } catch (error) {
    if (trimmed.includes('://')) {
      throw error;
    }
    return trimmed;
  }
}
