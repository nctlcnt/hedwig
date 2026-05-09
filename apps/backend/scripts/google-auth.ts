import readline from 'node:readline/promises';
import { stdin as input, stdout as output } from 'node:process';
import 'dotenv/config';
import { google } from 'googleapis';

const scope = 'https://www.googleapis.com/auth/gmail.modify';

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
console.log('\nAfter approving access, copy the "code" value from the redirected URL.\n');

const rl = readline.createInterface({ input, output });
const code = await rl.question('Authorization code: ');
rl.close();

const { tokens } = await oauth2Client.getToken(code.trim());

if (!tokens.refresh_token) {
  console.error('\nNo refresh_token returned.');
  console.error('Make sure the OAuth consent screen includes your Gmail as a test user, then rerun this script.');
  process.exit(1);
}

console.log('\nAdd this to .env:\n');
console.log(`GOOGLE_REFRESH_TOKEN=${tokens.refresh_token}`);
