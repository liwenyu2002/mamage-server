const CANDIDATE_LIMIT = 160;
const CACHE_TTL_MS = 30000;
const CACHE_LIMIT = 128;
const PREVIEW_LIMIT = 21; // One cover plus up to 20 hover previews.

function normalizedVector(value) {
  try {
    const vector = typeof value === 'string' ? JSON.parse(value) : value;
    if (!Array.isArray(vector) || !vector.length || !vector.every(Number.isFinite)) return null;
    const length = Math.hypot(...vector);
    return length > 0 ? vector.map(n => n / length) : null;
  } catch (_) { return null; }
}

// Compare only with selected representatives, not an album-wide N x N matrix.
function selectPreviewRepresentatives(rows, embeddings, limit = PREVIEW_LIMIT, threshold = 0.6) {
  const size = Math.max(1, Math.min(PREVIEW_LIMIT, Number(limit) || PREVIEW_LIMIT));
  const vectors = new Map();
  for (const row of embeddings) {
    if (!vectors.has(Number(row.photo_id))) {
      const vector = normalizedVector(row.embedding);
      if (vector) vectors.set(Number(row.photo_id), vector);
    }
  }
  const selected = [], selectedVectors = [], seen = new Set(), pending = [];
  const spread = new Set();
  const slots = Math.min(size, rows.length);
  for (let i = 0; i < slots; i++) spread.add(slots === 1 ? 0 : Math.round(i * (rows.length - 1) / (slots - 1)));
  const order = [...spread, ...rows.map((_, i) => i).filter(i => !spread.has(i))];
  for (const index of order) {
    const row = rows[index];
    const key = row.thumbUrl || row.url;
    if (!key || seen.has(key)) continue;
    seen.add(key);
    const vector = vectors.get(Number(row.id));
    if (!vector) { pending.push(row); continue; }
    const similar = selectedVectors.some(other => other.length === vector.length
      && vector.reduce((sum, n, i) => sum + n * other[i], 0) >= threshold);
    if (similar) continue;
    selected.push(row); selectedVectors.push(vector);
    if (selected.length === size) break;
  }
  const analyzedCount = selected.length;
  // Unanalyzed photos are a best-effort fallback, never repeated just to fill slots.
  selected.push(...pending.slice(0, size - selected.length));
  return { photos: selected, analyzedCount, diversity: analyzedCount === selected.length && selected.length
    ? 'similarity' : analyzedCount ? 'mixed' : 'chronological' };
}

function createProjectPreviewReader(db, now = Date.now) {
  const cache = new Map(), inFlight = new Map();
  return async function readProjectPreviews(projectId, organizationId) {
    const key = `${organizationId}:${projectId}`;
    const cached = cache.get(key);
    if (cached && cached.expires > now()) return cached.value;
    if (inFlight.has(key)) return inFlight.get(key);
    const promise = (async () => {
      // Sample across the whole album, with extra recent frames. Only sampled
      // photos have their vectors loaded, even for albums with thousands of photos.
      const [rows] = await db.query(`
        SELECT id, url, thumbUrl FROM (
          SELECT id, url, thumb_url AS thumbUrl,
            ROW_NUMBER() OVER (ORDER BY created_at DESC, id DESC) AS position,
            COUNT(*) OVER () AS total
          FROM photos WHERE project_id = ? AND organization_id <=> ?
            AND (type IS NULL OR type <> 'video')
        ) sampled
        WHERE position <= 24 OR MOD(position - 1, GREATEST(1, CEIL(total / 120))) = 0
        ORDER BY position LIMIT ?`, [projectId, organizationId, CANDIDATE_LIMIT]);
      let embeddings = [];
      if (rows.length) {
        [embeddings] = await db.query(`SELECT photo_id, embedding FROM ai_image_embeddings
          WHERE photo_id IN (?) AND model_name = ? ORDER BY id DESC`, [rows.map(row => row.id), 'resnet50']);
      }
      const result = selectPreviewRepresentatives(rows, embeddings);
      const value = { ...result, candidateCount: rows.length };
      cache.delete(key);
      cache.set(key, { value, expires: now() + CACHE_TTL_MS });
      while (cache.size > CACHE_LIMIT) cache.delete(cache.keys().next().value);
      return value;
    })().finally(() => inFlight.delete(key));
    inFlight.set(key, promise);
    return promise;
  };
}

module.exports = { createProjectPreviewReader, selectPreviewRepresentatives };
