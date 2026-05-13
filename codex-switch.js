#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');

const APP_DIR_NAME = '.codex-switch';
const LEGACY_APP_DIR_NAME = '.codexbar-win';
const CONFIG_VERSION = 1;

async function main() {
  try {
    const parsed = parseArgv(process.argv.slice(2));
    if (parsed.help || !parsed.command) {
      printHelp();
      return;
    }

    const paths = resolvePaths(parsed.global.home);
    const store = new ConfigStore(paths);
    const command = parsed.command;
    const options = parsed.options;

    switch (command) {
      case 'paths':
        printJSON(paths);
        break;
      case 'init':
        store.save(store.load());
        console.log(`Initialized ${paths.barConfig}`);
        break;
      case 'add-provider':
        addProvider(store, options);
        break;
      case 'add-account':
        addAccount(store, options);
        break;
      case 'add-oauth':
        addOAuthAccount(store, options);
        break;
      case 'list':
        listConfig(store.load());
        break;
      case 'use':
        useAccount(store, paths, options);
        break;
      case 'aggregate-on':
        enableAggregateGateway(store, paths);
        break;
      case 'gateway-start':
        await startAggregateGateway(store, options);
        break;
      case 'backup':
        backupCodexFiles(paths);
        break;
      case 'show':
        printJSON(redactConfig(store.load()));
        break;
      default:
        throw new UserError(`Unknown command: ${command}`);
    }
  } catch (error) {
    if (error instanceof UserError) {
      console.error(`Error: ${error.message}`);
      process.exitCode = 2;
      return;
    }
    console.error(error.stack || String(error));
    process.exitCode = 1;
  }
}

class UserError extends Error {}

class ConfigStore {
  constructor(paths) {
    this.paths = paths;
  }

  load() {
    migrateLegacyConfig(this.paths);
    if (!fs.existsSync(this.paths.barConfig)) {
      return defaultConfig();
    }
    const raw = fs.readFileSync(this.paths.barConfig, 'utf8');
    const parsed = JSON.parse(raw);
    if (parsed.version !== CONFIG_VERSION) {
      throw new UserError(`Unsupported config version: ${parsed.version}`);
    }
    return normalizeConfig(parsed);
  }

  save(config) {
    ensureDir(path.dirname(this.paths.barConfig));
    writeSecureJSON(this.paths.barConfig, normalizeConfig(config));
  }
}

function defaultConfig() {
  return {
    version: CONFIG_VERSION,
    active: {
      providerId: null,
      accountId: null,
    },
    global: {
      model: 'gpt-5.4',
      reviewModel: 'gpt-5.4',
      reasoningEffort: 'medium',
    },
    providers: [],
    aggregateGateway: {
      enabled: false,
      host: '127.0.0.1',
      port: 1456,
    },
  };
}

function normalizeConfig(config) {
  const next = {
    version: CONFIG_VERSION,
    active: config.active || { providerId: null, accountId: null },
    global: {
      model: config.global?.model || 'gpt-5.4',
      reviewModel: config.global?.reviewModel || config.global?.model || 'gpt-5.4',
      reasoningEffort: config.global?.reasoningEffort || 'medium',
    },
    providers: Array.isArray(config.providers) ? config.providers : [],
    aggregateGateway: {
      enabled: config.aggregateGateway?.enabled === true,
      host: config.aggregateGateway?.host || '127.0.0.1',
      port: Number(config.aggregateGateway?.port || 1456),
      updatedAt: config.aggregateGateway?.updatedAt || null,
    },
  };

  next.providers = next.providers.map((provider) => ({
    id: String(provider.id || '').trim(),
    kind: provider.kind === 'openai-oauth' ? 'openai-oauth' : 'openai-compatible',
    label: String(provider.label || provider.id || '').trim(),
    baseUrl: provider.baseUrl == null ? null : String(provider.baseUrl).trim(),
    activeAccountId: provider.activeAccountId || null,
    accounts: Array.isArray(provider.accounts) ? provider.accounts.map(normalizeAccount) : [],
  })).filter((provider) => provider.id && provider.label);

  for (const provider of next.providers) {
    if (!provider.activeAccountId && provider.accounts[0]) {
      provider.activeAccountId = provider.accounts[0].id;
    }
  }

  return next;
}

function normalizeAccount(account) {
  const kind = account.kind === 'oauth' ? 'oauth' : 'api-key';
  return {
    id: String(account.id || '').trim(),
    kind,
    label: String(account.label || account.email || account.id || '').trim(),
    apiKey: account.apiKey || null,
    accessToken: account.accessToken || null,
    refreshToken: account.refreshToken || null,
    idToken: account.idToken || null,
    openAIAccountId: account.openAIAccountId || null,
    lastRefresh: account.lastRefresh || null,
    addedAt: account.addedAt || new Date().toISOString(),
  };
}

function addProvider(store, options) {
  const id = option(options, 'id') || slug(option(options, 'label'));
  const label = option(options, 'label') || id;
  const kind = option(options, 'kind') || 'openai-compatible';
  const baseUrl = option(options, 'base-url') || option(options, 'baseUrl') || null;

  if (!id) throw new UserError('Missing --id or --label.');
  if (!['openai-compatible', 'openai-oauth'].includes(kind)) {
    throw new UserError('--kind must be openai-compatible or openai-oauth.');
  }
  if (kind === 'openai-compatible' && !baseUrl) {
    throw new UserError('openai-compatible providers require --base-url.');
  }

  const config = store.load();
  if (config.providers.some((provider) => provider.id === id)) {
    throw new UserError(`Provider already exists: ${id}`);
  }
  config.providers.push({
    id,
    kind,
    label,
    baseUrl: kind === 'openai-oauth' ? null : baseUrl,
    activeAccountId: null,
    accounts: [],
  });
  store.save(config);
  console.log(`Added provider ${id} (${label}).`);
}

function addAccount(store, options) {
  const providerId = required(options, 'provider');
  const label = option(options, 'label') || 'Default';
  const apiKey = required(options, 'api-key');
  const id = option(options, 'id') || uniqueId('acct');

  const config = store.load();
  const provider = findProvider(config, providerId);
  if (provider.kind !== 'openai-compatible') {
    throw new UserError('add-account only supports openai-compatible providers. Use add-oauth for OAuth token imports.');
  }
  if (provider.accounts.some((account) => account.id === id)) {
    throw new UserError(`Account already exists: ${id}`);
  }

  provider.accounts.push({
    id,
    kind: 'api-key',
    label,
    apiKey,
    accessToken: null,
    refreshToken: null,
    idToken: null,
    openAIAccountId: null,
    lastRefresh: null,
    addedAt: new Date().toISOString(),
  });
  provider.activeAccountId ||= id;
  config.active.providerId ||= provider.id;
  config.active.accountId ||= id;
  store.save(config);
  console.log(`Added API-key account ${id} to ${provider.id}.`);
}

function addOAuthAccount(store, options) {
  const label = option(options, 'label') || option(options, 'email') || 'OpenAI OAuth';
  const id = option(options, 'id') || uniqueId('openai');
  const accessToken = required(options, 'access-token');
  const refreshToken = required(options, 'refresh-token');
  const idToken = required(options, 'id-token');
  const openAIAccountId = required(options, 'account-id');

  const config = store.load();
  let provider = config.providers.find((item) => item.kind === 'openai-oauth');
  if (!provider) {
    provider = {
      id: 'openai-oauth',
      kind: 'openai-oauth',
      label: 'OpenAI',
      baseUrl: null,
      activeAccountId: null,
      accounts: [],
    };
    config.providers.push(provider);
  }
  if (provider.accounts.some((account) => account.id === id)) {
    throw new UserError(`Account already exists: ${id}`);
  }
  provider.accounts.push({
    id,
    kind: 'oauth',
    label,
    apiKey: null,
    accessToken,
    refreshToken,
    idToken,
    openAIAccountId,
    lastRefresh: option(options, 'last-refresh') || new Date().toISOString(),
    addedAt: new Date().toISOString(),
  });
  provider.activeAccountId ||= id;
  config.active.providerId ||= provider.id;
  config.active.accountId ||= id;
  store.save(config);
  console.log(`Imported OAuth account ${id}.`);
}

function listConfig(config) {
  if (config.providers.length === 0) {
    console.log('No providers configured. Use add-provider first.');
    return;
  }
  for (const provider of config.providers) {
    const providerActive = config.active.providerId === provider.id;
    console.log(`${providerActive ? '*' : ' '} ${provider.id} (${provider.kind}) ${provider.label}`);
    for (const account of provider.accounts) {
      const active = providerActive && config.active.accountId === account.id;
      const marker = active ? '*' : ' ';
      const secret = account.kind === 'oauth' ? 'oauth' : maskSecret(account.apiKey);
      console.log(`  ${marker} ${account.id} ${account.label} [${secret}]`);
    }
  }
}

function useAccount(store, paths, options) {
  const providerId = required(options, 'provider');
  const accountId = required(options, 'account');
  const config = store.load();
  const provider = findProvider(config, providerId);
  const account = provider.accounts.find((item) => item.id === accountId);
  if (!account) throw new UserError(`Account not found: ${accountId}`);

  provider.activeAccountId = account.id;
  config.active.providerId = provider.id;
  config.active.accountId = account.id;

  backupCodexFiles(paths);
  writeCodexAuth(paths.authJson, provider, account);
  writeCodexConfigToml(paths.configToml, config, provider);
  store.save(config);
  console.log(`Activated ${provider.label} / ${account.label}.`);
  console.log('Existing sessions remain in the shared .codex history pool.');
}

function enableAggregateGateway(store, paths) {
  const config = store.load();
  const oauthProvider = config.providers.find((provider) => provider.kind === 'openai-oauth');
  const accounts = oauthProvider?.accounts?.filter((account) => account.accessToken && account.refreshToken && account.idToken) || [];
  if (accounts.length === 0) {
    throw new UserError('Aggregate gateway requires at least one imported OpenAI OAuth account.');
  }
  config.aggregateGateway = {
    enabled: true,
    host: '127.0.0.1',
    port: 1456,
    updatedAt: new Date().toISOString(),
  };
  backupCodexFiles(paths);
  writeSecureJSON(paths.authJson, {
    OPENAI_API_KEY: 'codex-switch-local-gateway',
  });
  writeAggregateConfigToml(paths.configToml, config);
  store.save(config);
  console.log('Enabled aggregate gateway config for Codex.');
  console.log('Keep codex-switch running, or run: node codex-switch.js gateway-start');
}

async function startAggregateGateway(store, options) {
  const { startGateway } = require('./gateway');
  const host = option(options, 'host') || '127.0.0.1';
  const port = Number(option(options, 'port') || 1456);
  const upstreamBase = option(options, 'upstream-base') || process.env.CODEXBAR_WIN_UPSTREAM_BASE;
  const gateway = await startGateway({
    host,
    port,
    upstreamBase,
    loadConfig: () => store.load(),
  });
  console.log(`Aggregate gateway listening on http://${gateway.host}:${gateway.port}/v1`);
  process.on('SIGINT', async () => {
    await gateway.close();
    process.exit(0);
  });
}

function writeCodexAuth(authJsonPath, provider, account) {
  if (provider.kind === 'openai-oauth') {
    if (!account.accessToken || !account.refreshToken || !account.idToken || !account.openAIAccountId) {
      throw new UserError('OAuth account is missing access/refresh/id token or account id.');
    }
    writeSecureJSON(authJsonPath, {
      auth_mode: 'chatgpt',
      OPENAI_API_KEY: null,
      last_refresh: account.lastRefresh || new Date().toISOString(),
      tokens: {
        access_token: account.accessToken,
        refresh_token: account.refreshToken,
        id_token: account.idToken,
        account_id: account.openAIAccountId,
      },
    });
    return;
  }

  if (!account.apiKey) {
    throw new UserError('API-key account is missing apiKey.');
  }
  writeSecureJSON(authJsonPath, {
    OPENAI_API_KEY: account.apiKey,
  });
}

function writeCodexConfigToml(configTomlPath, config, provider) {
  ensureDir(path.dirname(configTomlPath));
  const existing = fs.existsSync(configTomlPath) ? fs.readFileSync(configTomlPath, 'utf8') : '';
  let text = existing;
  text = upsertTomlSetting(text, 'model_provider', quoteToml('openai'));
  text = upsertTomlSetting(text, 'model', quoteToml(config.global.model));
  text = upsertTomlSetting(text, 'review_model', quoteToml(config.global.reviewModel));
  text = upsertTomlSetting(text, 'model_reasoning_effort', quoteToml(config.global.reasoningEffort));
  text = removeTomlSetting(text, 'oss_provider');
  text = removeTomlSetting(text, 'model_catalog_json');
  text = removeTomlSetting(text, 'preferred_auth_method');
  text = removeTomlBlock(text, 'model_providers.openai');
  text = removeTomlBlock(text, 'model_providers.OpenAI');

  if (provider.kind === 'openai-compatible') {
    text = upsertTomlSetting(text, 'openai_base_url', quoteToml(provider.baseUrl));
    text = removeTomlSetting(text, 'service_tier');
  } else {
    text = removeTomlSetting(text, 'openai_base_url');
  }

  writeSecureFile(configTomlPath, `${text.trim()}\n`);
}

function writeAggregateConfigToml(configTomlPath, config) {
  ensureDir(path.dirname(configTomlPath));
  const existing = fs.existsSync(configTomlPath) ? fs.readFileSync(configTomlPath, 'utf8') : '';
  let text = existing;
  text = upsertTomlSetting(text, 'model_provider', quoteToml('openai'));
  text = upsertTomlSetting(text, 'model', quoteToml(config.global.model));
  text = upsertTomlSetting(text, 'review_model', quoteToml(config.global.reviewModel));
  text = upsertTomlSetting(text, 'model_reasoning_effort', quoteToml(config.global.reasoningEffort));
  text = upsertTomlSetting(text, 'openai_base_url', quoteToml('http://127.0.0.1:1456/v1'));
  text = removeTomlSetting(text, 'oss_provider');
  text = removeTomlSetting(text, 'model_catalog_json');
  text = removeTomlSetting(text, 'preferred_auth_method');
  text = removeTomlSetting(text, 'service_tier');
  text = removeTomlBlock(text, 'model_providers.openai');
  text = removeTomlBlock(text, 'model_providers.OpenAI');
  writeSecureFile(configTomlPath, `${text.trim()}\n`);
}

function backupCodexFiles(paths) {
  ensureDir(paths.codexRoot);
  backupIfPresent(paths.authJson, `${paths.authJson}.bak-codex-switch-last`);
  backupIfPresent(paths.configToml, `${paths.configToml}.bak-codex-switch-last`);
  console.log('Backed up existing Codex config files when present.');
}

function backupIfPresent(source, destination) {
  if (!fs.existsSync(source)) return;
  writeSecureFile(destination, fs.readFileSync(source));
}

function resolvePaths(homeOverride) {
  const home = path.resolve(homeOverride || process.env.CODEX_SWITCH_HOME || process.env.CODEXBAR_WIN_HOME || os.homedir());
  const codexRoot = path.join(home, '.codex');
  const barRoot = path.join(home, APP_DIR_NAME);
  return {
    home,
    codexRoot,
    barRoot,
    barConfig: path.join(barRoot, 'config.json'),
    authJson: path.join(codexRoot, 'auth.json'),
    configToml: path.join(codexRoot, 'config.toml'),
    sessions: path.join(codexRoot, 'sessions'),
    archivedSessions: path.join(codexRoot, 'archived_sessions'),
    legacyBarConfig: path.join(home, LEGACY_APP_DIR_NAME, 'config.json'),
  };
}

function migrateLegacyConfig(paths) {
  if (fs.existsSync(paths.barConfig) || !paths.legacyBarConfig || !fs.existsSync(paths.legacyBarConfig)) return;
  ensureDir(path.dirname(paths.barConfig));
  fs.copyFileSync(paths.legacyBarConfig, paths.barConfig);
}

function parseArgv(argv) {
  const global = {};
  const remaining = [];
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--help' || arg === '-h') return { help: true, global, options: {} };
    if (arg === '--home') {
      global.home = argv[++index];
      continue;
    }
    remaining.push(arg);
  }

  const command = remaining.shift();
  const options = {};
  for (let index = 0; index < remaining.length; index += 1) {
    const arg = remaining[index];
    if (!arg.startsWith('--')) {
      throw new UserError(`Unexpected argument: ${arg}`);
    }
    const key = arg.slice(2);
    const next = remaining[index + 1];
    if (!next || next.startsWith('--')) {
      options[key] = true;
    } else {
      options[key] = next;
      index += 1;
    }
  }
  return { command, options, global };
}

function required(options, key) {
  const value = option(options, key);
  if (!value) throw new UserError(`Missing --${key}.`);
  return value;
}

function option(options, key) {
  const value = options[key];
  return typeof value === 'string' ? value.trim() : value;
}

function findProvider(config, providerId) {
  const provider = config.providers.find((item) => item.id === providerId);
  if (!provider) throw new UserError(`Provider not found: ${providerId}`);
  return provider;
}

function upsertTomlSetting(text, key, value) {
  const line = `${key} = ${value}`;
  const re = new RegExp(`^${escapeRegExp(key)}\\s*=.*$`, 'm');
  if (re.test(text)) return text.replace(re, line);
  return `${line}\n${text}`;
}

function removeTomlSetting(text, key) {
  const re = new RegExp(`^${escapeRegExp(key)}\\s*=.*\\r?\\n?`, 'gm');
  return text.replace(re, '');
}

function removeTomlBlock(text, key) {
  const re = new RegExp(`^\\[${escapeRegExp(key)}\\]\\r?\\n[\\s\\S]*?(?=^\\[|\\s*$)`, 'gm');
  return text.replace(re, '');
}

function quoteToml(value) {
  return `"${String(value).replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

function slug(value) {
  return String(value || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

function uniqueId(prefix) {
  return `${prefix}-${crypto.randomBytes(4).toString('hex')}`;
}

function maskSecret(value) {
  if (!value) return 'missing';
  if (value.length <= 8) return '***';
  return `${value.slice(0, 4)}...${value.slice(-4)}`;
}

function redactConfig(config) {
  const clone = JSON.parse(JSON.stringify(config));
  for (const provider of clone.providers) {
    for (const account of provider.accounts) {
      account.apiKey = account.apiKey ? maskSecret(account.apiKey) : null;
      account.accessToken = account.accessToken ? maskSecret(account.accessToken) : null;
      account.refreshToken = account.refreshToken ? maskSecret(account.refreshToken) : null;
      account.idToken = account.idToken ? maskSecret(account.idToken) : null;
    }
  }
  return clone;
}

function writeSecureJSON(filePath, value) {
  writeSecureFile(filePath, `${JSON.stringify(value, null, 2)}\n`);
}

function writeSecureFile(filePath, content) {
  ensureDir(path.dirname(filePath));
  const temp = path.join(path.dirname(filePath), `.${path.basename(filePath)}.${process.pid}.${Date.now()}.tmp`);
  fs.writeFileSync(temp, content, { mode: 0o600 });
  fs.renameSync(temp, filePath);
  try {
    fs.chmodSync(filePath, 0o600);
  } catch (_) {
    // Windows ACLs do not map perfectly to POSIX modes; keep going.
  }
}

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function printJSON(value) {
  console.log(JSON.stringify(value, null, 2));
}

function printHelp() {
  console.log(`codex-switch

Usage:
  node codex-switch.js [--home <dir>] <command> [options]

Commands:
  paths
  init
  add-provider --id <id> --label <name> --kind openai-compatible --base-url <url>
  add-account --provider <id> --label <name> --api-key <key>
  add-oauth --label <name> --access-token <token> --refresh-token <token> --id-token <token> --account-id <id>
  list
  use --provider <id> --account <id>
  aggregate-on
  gateway-start [--host 127.0.0.1] [--port 1456]
  backup
  show

Notes:
  --home is for testing or portable use. By default this uses your Windows home directory.
  The tool keeps sessions in the shared .codex history pool and only writes auth.json/config.toml.
`);
}

main().catch((error) => {
  if (error instanceof UserError) {
    console.error(`Error: ${error.message}`);
    process.exitCode = 2;
    return;
  }
  console.error(error.stack || String(error));
  process.exitCode = 1;
});
