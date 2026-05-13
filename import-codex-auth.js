'use strict';

const childProcess = require('node:child_process');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const CLI = path.join(__dirname, 'codex-switch.js');

main();

function main() {
  const authPath = path.join(os.homedir(), '.codex', 'auth.json');
  if (!fs.existsSync(authPath)) {
    throw new Error(`Codex auth file not found: ${authPath}`);
  }
  const auth = JSON.parse(fs.readFileSync(authPath, 'utf8'));
  if (!auth.tokens) {
    throw new Error(`${authPath} does not contain ChatGPT OAuth tokens.`);
  }
  const tokens = auth.tokens;
  if (!tokens.access_token || !tokens.refresh_token || !tokens.id_token) {
    throw new Error(`${authPath} is missing access_token, refresh_token, or id_token.`);
  }
  const claims = decodeJWT(tokens.access_token);
  const idClaims = decodeJWT(tokens.id_token);
  const authClaims = claims['https://api.openai.com/auth'] || {};
  const accountId = tokens.account_id
    || authClaims.chatgpt_account_id
    || authClaims.chatgpt_account_user_id
    || claims.sub
    || crypto.randomUUID();
  const label = process.argv.slice(2).join(' ').trim()
    || idClaims.email
    || claims['https://api.openai.com/profile']?.email
    || `OpenAI ${String(accountId).slice(0, 8)}`;

  runCLI([
    'add-oauth',
    '--label', label,
    '--access-token', tokens.access_token,
    '--refresh-token', tokens.refresh_token,
    '--id-token', tokens.id_token,
    '--account-id', accountId,
  ]);
  console.log(`Imported current Codex OAuth account: ${label}`);
}

function runCLI(args) {
  const result = childProcess.spawnSync(process.execPath, [CLI, ...args], {
    cwd: __dirname,
    encoding: 'utf8',
    windowsHide: true,
  });
  if (result.status !== 0) {
    throw new Error((result.stderr || result.stdout || 'CLI failed').trim());
  }
}

function decodeJWT(token) {
  const part = String(token || '').split('.')[1];
  if (!part) return {};
  try {
    const padded = part.replace(/-/g, '+').replace(/_/g, '/').padEnd(Math.ceil(part.length / 4) * 4, '=');
    return JSON.parse(Buffer.from(padded, 'base64').toString('utf8'));
  } catch (_) {
    return {};
  }
}
