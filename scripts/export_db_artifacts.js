// scripts/export_db_artifacts.js
// Exports DB artifacts to the repo:
// - schema-only dump -> db/mamage_schema_only.sql
// - role_permissions data-only dump -> db/role_permissions_seed.sql

const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

require('dotenv').config({ path: path.resolve(__dirname, '..', '.env') });

const projectRoot = path.resolve(__dirname, '..');
const schemaOutPath = path.join(projectRoot, 'db', 'mamage_schema_only.sql');
const rolePermissionsOutPath = path.join(projectRoot, 'db', 'role_permissions_seed.sql');

function requireEnv(name) {
  const val = process.env[name];
  if (val === undefined || String(val).trim() === '') {
    throw new Error(`Missing required env var: ${name}`);
  }
  return String(val);
}

function fileExists(p) {
  try {
    return fs.existsSync(p);
  } catch {
    return false;
  }
}

function candidateMysqldumpPaths() {
  const candidates = [];

  if (process.env.MYSQLDUMP_PATH) {
    candidates.push(process.env.MYSQLDUMP_PATH);
  }

  // PATH lookup
  candidates.push('mysqldump');

  // Common Windows install locations
  const pf = process.env['ProgramFiles'] || 'C:\\Program Files';
  const pf86 = process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)';
  const versions = ['8.4', '8.3', '8.2', '8.1', '8.0', '5.7'];
  for (const base of [pf, pf86]) {
    for (const v of versions) {
      candidates.push(path.join(base, 'MySQL', `MySQL Server ${v}`, 'bin', 'mysqldump.exe'));
    }
  }

  return candidates;
}

async function resolveMysqldump() {
  const candidates = candidateMysqldumpPaths();

  for (const candidate of candidates) {
    // For PATH lookup we just try to run it.
    if (candidate === 'mysqldump') return candidate;
    if (fileExists(candidate)) return candidate;
  }

  throw new Error(
    'mysqldump not found. Install MySQL client tools and ensure mysqldump is on PATH, or set MYSQLDUMP_PATH to the full path of mysqldump.exe.'
  );
}

function runMysqldump({ exe, args, env, outFile }) {
  return new Promise((resolve, reject) => {
    fs.mkdirSync(path.dirname(outFile), { recursive: true });

    const outStream = fs.createWriteStream(outFile, { encoding: 'utf8' });
    const child = spawn(exe, args, {
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });

    let stderr = '';
    child.stdout.pipe(outStream);
    child.stderr.on('data', (d) => {
      stderr += d.toString('utf8');
    });

    child.on('error', (err) => {
      try { outStream.close(); } catch {}
      reject(err);
    });

    child.on('close', (code) => {
      try { outStream.close(); } catch {}
      if (code === 0) {
        resolve();
        return;
      }
      const msg = stderr.trim() || `mysqldump exited with code ${code}`;
      reject(new Error(msg));
    });
  });
}

async function main() {
  const DB_HOST = requireEnv('DB_HOST');
  const DB_PORT = requireEnv('DB_PORT');
  const DB_USER = requireEnv('DB_USER');
  const DB_PASSWORD = process.env.DB_PASSWORD !== undefined ? String(process.env.DB_PASSWORD) : '';
  const DB_NAME = requireEnv('DB_NAME');

  const exe = await resolveMysqldump();

  const baseArgs = [
    `--host=${DB_HOST}`,
    `--port=${DB_PORT}`,
    `--user=${DB_USER}`,
    '--protocol=tcp',
    '--default-character-set=utf8mb4',
    '--set-gtid-purged=OFF',
    '--column-statistics=0',
    '--skip-dump-date',
    '--no-tablespaces',
  ];

  const childEnv = {
    ...process.env,
  };
  if (DB_PASSWORD) {
    // Avoid leaking password in process args.
    childEnv.MYSQL_PWD = DB_PASSWORD;
  }

  console.log('[db-export] exporting schema ->', path.relative(projectRoot, schemaOutPath));
  await runMysqldump({
    exe,
    env: childEnv,
    outFile: schemaOutPath,
    args: [
      ...baseArgs,
      '--no-data',
      '--routines',
      '--events',
      '--triggers',
      DB_NAME,
    ],
  });

  console.log('[db-export] exporting role_permissions data ->', path.relative(projectRoot, rolePermissionsOutPath));
  await runMysqldump({
    exe,
    env: childEnv,
    outFile: rolePermissionsOutPath,
    args: [
      ...baseArgs,
      '--no-create-info',
      '--skip-triggers',
      '--skip-extended-insert',
      '--order-by-primary',
      DB_NAME,
      'role_permissions',
    ],
  });

  console.log('[db-export] done');
}

main().catch((e) => {
  console.error('[db-export] failed:', e && e.stack ? e.stack : e);
  process.exit(1);
});
