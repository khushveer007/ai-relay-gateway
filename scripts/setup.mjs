#!/usr/bin/env node
import { spawnSync, execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { createInterface } from 'node:readline/promises';
import { stdin, stdout } from 'node:process';

const WRANGLER_PATH = new URL('../wrangler.jsonc', import.meta.url);
const DEV_VARS_PATH = new URL('../.dev.vars', import.meta.url);
const DB_NAME = 'ai-gateway';
const PREVIEW_DB_NAME = 'ai-gateway-preview';

function run(cmd, args, opts = {}) {
  const res = spawnSync(cmd, args, { stdio: 'inherit', shell: process.platform === 'win32', ...opts });
  if (res.status !== 0) {
    throw new Error(`Command failed: ${cmd} ${args.join(' ')}`);
  }
}

function capture(cmd, args) {
  return execFileSync(cmd, args, {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    shell: process.platform === 'win32',
  });
}

function createDatabase(name) {
  const out = capture('npx', ['wrangler', 'd1', 'create', name]);
  const match = out.match(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i);
  if (!match) throw new Error(`Could not parse database_id from wrangler output:\n${out}`);
  return match[0];
}

function setDatabaseId(config, name, id) {
  const existing = new RegExp(`("database_name": "${name}",\\s*"database_id": ")[^"]*"`);
  return existing.test(config)
    ? config.replace(existing, (_match, prefix) => `${prefix}${id}"`)
    : config.replace(`"database_name": "${name}",`, `"database_name": "${name}",\n      "database_id": "${id}",`);
}

function putSecret(name, value) {
  const res = spawnSync('npx', ['wrangler', 'secret', 'put', name], {
    input: value,
    encoding: 'utf8',
    stdio: ['pipe', 'inherit', 'inherit'],
    shell: process.platform === 'win32',
  });
  if (res.status !== 0) {
    throw new Error(`Failed to upload secret ${name}`);
  }
}

async function main() {
  console.log('\n=== AI Relay Gateway — Interactive Cloudflare Setup ===\n');

  // 1. Check Wrangler authentication
  try {
    capture('npx', ['wrangler', 'whoami']);
    console.log('✓ Logged into Cloudflare');
  } catch {
    console.log('→ Opening Cloudflare login in your browser...');
    run('npx', ['wrangler', 'login']);
  }

  // 2. Ensure D1 database exists and update wrangler.jsonc
  let wranglerText = readFileSync(WRANGLER_PATH, 'utf8');
  let databases = [];

  try {
    const listJson = capture('npx', ['wrangler', 'd1', 'list', '--json']);
    const list = JSON.parse(listJson);
    databases = Array.isArray(list) ? list : [];
  } catch {
    /* fallback to create */
  }

  let dbId = databases.find((d) => d.name === DB_NAME)?.uuid ?? null;
  if (!dbId) {
    console.log(`→ Creating D1 database "${DB_NAME}"...`);
    dbId = createDatabase(DB_NAME);
    console.log(`✓ Created D1 database "${DB_NAME}" (${dbId})`);
  } else {
    console.log(`✓ Found existing D1 database "${DB_NAME}" (${dbId})`);
  }

  let previewDbId = databases.find((d) => d.name === PREVIEW_DB_NAME)?.uuid ?? null;
  if (!previewDbId) {
    console.log(`→ Creating D1 database "${PREVIEW_DB_NAME}"...`);
    previewDbId = createDatabase(PREVIEW_DB_NAME);
    console.log(`✓ Created D1 database "${PREVIEW_DB_NAME}" (${previewDbId})`);
  } else {
    console.log(`✓ Found existing D1 database "${PREVIEW_DB_NAME}" (${previewDbId})`);
  }

  wranglerText = setDatabaseId(wranglerText, DB_NAME, dbId);
  wranglerText = setDatabaseId(wranglerText, PREVIEW_DB_NAME, previewDbId);
  const migrationConfigPath = new URL('../wrangler.preview-migrations.jsonc', import.meta.url);
  const migrationConfig = readFileSync(migrationConfigPath, 'utf8').replace(
    /("database_id": ")[^"]*"/,
    (_match, prefix) => `${prefix}${previewDbId}"`,
  );
  if (
    !wranglerText.includes(`"database_id": "${dbId}"`) ||
    !wranglerText.includes(`"database_id": "${previewDbId}"`) ||
    !migrationConfig.includes(`"database_id": "${previewDbId}"`)
  ) {
    throw new Error('Could not update Wrangler D1 database IDs');
  }
  writeFileSync(WRANGLER_PATH, wranglerText, 'utf8');
  writeFileSync(migrationConfigPath, migrationConfig, 'utf8');
  console.log('✓ Updated Wrangler configs with database IDs');

  // 3. Apply D1 migrations remotely (and locally for dev convenience)
  console.log('→ Applying D1 migrations...');
  run('npx', ['wrangler', 'd1', 'migrations', 'apply', 'DB', '--remote']);
  run('npx', ['wrangler', 'd1', 'migrations', 'apply', 'PREVIEW_DB', '--remote', '--config', 'wrangler.preview-migrations.jsonc']);

  // 4. Configure secrets
  const rl = createInterface({ input: stdin, output: stdout });
  const rawPw = (await rl.question('\nChoose an ADMIN_PASSWORD for the dashboard (leave blank to auto-generate): ')).trim();
  rl.close();

  const adminPassword = rawPw || randomBytes(18).toString('base64url');
  const encryptionKey = randomBytes(32).toString('base64');
  const sessionSecret = randomBytes(32).toString('base64');

  if (!existsSync(DEV_VARS_PATH)) {
    writeFileSync(
      DEV_VARS_PATH,
      `ADMIN_PASSWORD=${adminPassword}\nENCRYPTION_KEY=${encryptionKey}\nSESSION_SECRET=${sessionSecret}\n`,
      'utf8',
    );
    console.log('✓ Wrote .dev.vars for local development');
  }

  console.log('→ Uploading Worker secrets...');
  putSecret('ADMIN_PASSWORD', adminPassword);
  putSecret('ENCRYPTION_KEY', encryptionKey);
  putSecret('SESSION_SECRET', sessionSecret);

  // 5. Build dashboard UI
  console.log('→ Building dashboard...');
  run('npm', ['run', 'build:ui']);

  // 6. Deploy Worker
  console.log('→ Deploying Worker to Cloudflare...');
  run('npx', ['wrangler', 'deploy']);

  console.log('\n=== Setup Complete! ===');
  if (!rawPw) {
    console.log(`Generated ADMIN_PASSWORD: ${adminPassword}`);
  }
  console.log('Open your Worker URL above to sign into the dashboard, add providers, and mint a gateway key.\n');
}

main().catch((err) => {
  console.error('\nSetup failed:', err.message);
  process.exit(1);
});
