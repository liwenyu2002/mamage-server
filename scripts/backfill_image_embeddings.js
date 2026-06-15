const { pool, buildUploadUrl } = require('../db');
const { encodeImageFromBuffer, saveEmbedding } = require('../lib/image_similarity');

const DEFAULT_LIMIT = 50;
const DEFAULT_MAX_BYTES = 5 * 1024 * 1024;
const DEFAULT_TIMEOUT_MS = 15000;

function argValue(name, fallback = null) {
  const prefix = `--${name}=`;
  const found = process.argv.find((arg) => arg.startsWith(prefix));
  if (!found) return fallback;
  return found.slice(prefix.length);
}

function hasFlag(name) {
  return process.argv.includes(`--${name}`);
}

function toPositiveInt(raw, fallback) {
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return fallback;
  return Math.floor(n);
}

async function fetchBuffer(url, maxBytes, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, { signal: controller.signal });
    if (!response.ok) throw new Error(`FETCH_FAILED_${response.status}`);
    const contentLength = Number(response.headers.get('content-length') || 0);
    if (contentLength > maxBytes) throw new Error(`IMAGE_TOO_LARGE_${contentLength}`);
    const chunks = [];
    let total = 0;
    for await (const chunk of response.body) {
      const buf = Buffer.from(chunk);
      total += buf.length;
      if (total > maxBytes) throw new Error(`IMAGE_TOO_LARGE_${total}`);
      chunks.push(buf);
    }
    return Buffer.concat(chunks);
  } finally {
    clearTimeout(timer);
  }
}

async function main() {
  const modelName = argValue('modelName', 'resnet50');
  const limit = toPositiveInt(argValue('limit', DEFAULT_LIMIT), DEFAULT_LIMIT);
  const projectId = argValue('projectId', null);
  const photoId = argValue('photoId', null);
  const force = hasFlag('force');
  const maxBytes = toPositiveInt(process.env.IMAGE_SIMILARITY_FETCH_MAX_BYTES, DEFAULT_MAX_BYTES);
  const timeoutMs = toPositiveInt(process.env.IMAGE_SIMILARITY_FETCH_TIMEOUT_MS, DEFAULT_TIMEOUT_MS);

  const where = ['p.thumb_url IS NOT NULL', "p.thumb_url <> ''"];
  const params = [];

  if (photoId) {
    where.push('p.id = ?');
    params.push(Number(photoId));
  }
  if (projectId) {
    where.push('p.project_id = ?');
    params.push(Number(projectId));
  }
  if (!force) {
    where.push(`NOT EXISTS (
      SELECT 1 FROM ai_image_embeddings e
      WHERE e.photo_id = p.id AND e.model_name = ?
    )`);
    params.push(modelName);
  }

  params.push(limit);
  const [rows] = await pool.query(
    `SELECT p.id, p.thumb_url AS thumbUrl, p.url
     FROM photos p
     WHERE ${where.join(' AND ')}
     ORDER BY p.id DESC
     LIMIT ?`,
    params
  );

  console.log(`[backfill_image_embeddings] found ${rows.length} photo(s)`);

  let ok = 0;
  let failed = 0;
  for (const row of rows) {
    const imageUrl = buildUploadUrl(row.thumbUrl || row.url);
    try {
      console.log(`[backfill_image_embeddings] encoding photo ${row.id}`);
      const buffer = await fetchBuffer(imageUrl, maxBytes, timeoutMs);
      const embedding = await encodeImageFromBuffer(buffer);
      await saveEmbedding(row.id, embedding, modelName);
      ok += 1;
    } catch (err) {
      failed += 1;
      console.error(`[backfill_image_embeddings] failed photo ${row.id}:`, err && err.message ? err.message : err);
    }
  }

  console.log(`[backfill_image_embeddings] done ok=${ok} failed=${failed}`);
}

main()
  .catch((err) => {
    console.error('[backfill_image_embeddings] fatal:', err && err.stack ? err.stack : err);
    process.exitCode = 1;
  })
  .finally(async () => {
    try { await pool.end(); } catch (e) {}
  });
