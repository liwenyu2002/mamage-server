require('dotenv').config();

const storage = require('../lib/cos_storage');

const defaultOrigins = [
  'http://10.100.83.67:3000',
  'http://10.100.65.147:3000',
];

function getOrigins() {
  const configured = String(process.env.DIRECT_STORAGE_CORS_ORIGINS || '')
    .split(',')
    .map((value) => value.trim())
    .filter(Boolean);
  return configured.length ? configured : defaultOrigins;
}

async function main() {
  if (!storage.isConfigured()) throw new Error('S3 storage is not configured');
  const origins = getOrigins();
  await storage.putBucketCors(origins);
  console.log(`[storage.cors] configured ${storage.getBucket()} for: ${origins.join(', ')}`);
}

main().catch((err) => {
  console.error('[storage.cors] failed:', err && err.stack ? err.stack : err);
  process.exitCode = 1;
});
