const REFERENCE_LIMIT = 16;
const SEPARATION_MARGIN = 0.06;

function parseJson(value) {
  if (Buffer.isBuffer(value)) value = value.toString('utf8');
  if (typeof value !== 'string') return value;
  try { return JSON.parse(value); } catch { return null; }
}

function normalize(value) {
  const vector = parseJson(value);
  if (!Array.isArray(vector) || !vector.length || !vector.every(Number.isFinite)) return null;
  const norm = Math.hypot(...vector.map(Number));
  return Number.isFinite(norm) && norm > 0 ? vector.map((v) => Number(v) / norm) : null;
}

function cosine(a, b) {
  if (!a || !b || a.length !== b.length) return -1;
  return a.reduce((sum, value, index) => sum + value * b[index], 0);
}

function pairKey(a, b) {
  return [Number(a), Number(b)].sort((x, y) => x - y).join(':');
}

// Keep explicit corrections first, then choose different appearances instead of recent duplicates.
function selectReferences(rows, limit = REFERENCE_LIMIT) {
  const remaining = (rows || []).map((row) => ({
    ...row, vec: normalize(row.normalized_embedding),
  })).filter((row) => row.vec);
  const selected = [];
  const priority = (row) => row.sample_kind === 'explicit' ? 2 : row.sample_kind === 'group' ? 1 : 0;
  while (remaining.length && selected.length < limit) {
    let bestIndex = 0;
    let bestPriority = -1;
    let bestDistance = -1;
    for (let index = 0; index < remaining.length; index++) {
      const row = remaining[index];
      const rank = priority(row);
      const distance = selected.length ? 1 - Math.max(...selected.map((old) => cosine(old.vec, row.vec))) : 1;
      if (rank > bestPriority || (rank === bestPriority && distance > bestDistance)) {
        bestIndex = index;
        bestPriority = rank;
        bestDistance = distance;
      }
    }
    selected.push(remaining.splice(bestIndex, 1)[0]);
  }
  return selected;
}

function referenceScore(vector, references) {
  const compatible = (references || []).filter((row) => row.vec.length === vector.length);
  if (!compatible.length) return -1;
  const score = (rows) => {
    if (!rows.length) return -1;
    const sum = new Array(vector.length).fill(0);
    let best = -1;
    for (const row of rows) {
      const weight = row.sample_kind === 'explicit' ? 3 : row.sample_kind === 'legacy' ? 0.5 : 1;
      row.vec.forEach((value, index) => { sum[index] += value * weight; });
      best = Math.max(best, cosine(vector, row.vec));
    }
    return 0.7 * cosine(vector, normalize(sum)) + 0.3 * best;
  };
  // Suggestions cannot override either a positive or a negative reviewed reference.
  const explicit = compatible.filter((row) => row.sample_kind === 'explicit');
  return score(explicit.length ? explicit : compatible);
}

function isSeparatedAmbiguity(ranked, separations, threshold, margin = SEPARATION_MARGIN) {
  if (!ranked?.length || !separations?.size || ranked[0].score < threshold) return false;
  const best = ranked[0];
  return ranked.slice(1).some((candidate) => (
    separations.has(pairKey(best.personId, candidate.personId))
    && candidate.score >= threshold - 0.08
    && best.score - candidate.score < margin
  ));
}

async function hasProtectedFaces(conn, photoId, orgId) {
  const [rows] = await conn.query(
    'SELECT id FROM face_identity_feedback WHERE photo_id = ? AND organization_id <=> ? LIMIT 1',
    [photoId, orgId]
  );
  return rows.length > 0;
}

async function recordIdentityFeedback(conn, {
  orgId, userId = null, action, assignments = [], details = {}, operationKey = null,
}) {
  for (const { face } of assignments) {
    if (Number(face.organization_id) !== Number(orgId)) throw new Error('feedback organization mismatch');
  }
  const [event] = await conn.query(
    'INSERT INTO face_feedback_events (organization_id, user_id, action, operation_key, details) VALUES (?, ?, ?, ?, ?)',
    [orgId, userId, action, operationKey, JSON.stringify({
      ...details,
      faces: assignments.map(({ face, personId, kind }) => ({
        faceId: Number(face.id), photoId: Number(face.photo_id),
        fromPersonId: face.person_id == null ? null : Number(face.person_id),
        toPersonId: personId == null ? null : Number(personId), kind,
      })),
    })]
  );
  const values = assignments.map(({ face, personId, kind = 'group' }) => {
    const vector = normalize(face.normalized_embedding) || normalize(face.embedding);
    return [orgId, personId || null, face.id, face.photo_id, kind,
      personId && vector ? JSON.stringify(vector) : null,
      JSON.stringify({ x: face.bbox_x, y: face.bbox_y, w: face.bbox_w, h: face.bbox_h,
        unit: face.bbox_unit, width: face.image_width, height: face.image_height }),
      face.model_name || 'face-detector', face.model_version || null, event.insertId];
  });
  for (let start = 0; start < values.length; start += 100) {
    await conn.query(
      `INSERT INTO face_identity_feedback
         (organization_id, person_id, face_id, photo_id, sample_kind, normalized_embedding,
          bbox, model_name, model_version, event_id)
       VALUES ?
       ON DUPLICATE KEY UPDATE
         sample_kind = IF(person_id <=> VALUES(person_id) AND sample_kind = 'explicit', 'explicit', VALUES(sample_kind)),
         person_id = VALUES(person_id), normalized_embedding = VALUES(normalized_embedding),
         bbox = VALUES(bbox), model_name = VALUES(model_name), model_version = VALUES(model_version),
         event_id = VALUES(event_id), updated_at = CURRENT_TIMESTAMP`,
      [values.slice(start, start + 100)]
    );
  }
  return event.insertId;
}

async function recordSeparation(conn, orgId, personA, personB, eventId) {
  const [low, high] = [Number(personA), Number(personB)].sort((a, b) => a - b);
  if (!low || low === high) return;
  await conn.query(
    `INSERT INTO face_person_separations (organization_id, person_low_id, person_high_id, event_id)
     VALUES (?, ?, ?, ?) ON DUPLICATE KEY UPDATE event_id = VALUES(event_id)`,
    [orgId, low, high, eventId]
  );
}

async function remapMergedFeedback(conn, orgId, targetId, sourceIds) {
  await conn.query('UPDATE face_identity_feedback SET person_id = ? WHERE organization_id = ? AND person_id IN (?)',
    [targetId, orgId, sourceIds]);
  const [separations] = await conn.query(
    `SELECT person_low_id, person_high_id, event_id FROM face_person_separations
     WHERE organization_id = ? AND (person_low_id IN (?) OR person_high_id IN (?)) FOR UPDATE`,
    [orgId, sourceIds, sourceIds]
  );
  await conn.query(
    `DELETE FROM face_person_separations
     WHERE organization_id = ? AND (person_low_id IN (?) OR person_high_id IN (?))`,
    [orgId, sourceIds, sourceIds]
  );
  const sourceSet = new Set(sourceIds.map(Number));
  for (const row of separations) {
    const a = sourceSet.has(Number(row.person_low_id)) ? targetId : row.person_low_id;
    const b = sourceSet.has(Number(row.person_high_id)) ? targetId : row.person_high_id;
    await recordSeparation(conn, orgId, a, b, row.event_id);
  }
}

async function loadFeedbackMemory(conn, orgId, { exceptPhotoId = 0, modelName, modelVersion, photoIds } = {}) {
  if (!orgId || (photoIds && !photoIds.length)) return { references: new Map(), separations: new Set() };
  const params = [orgId, exceptPhotoId];
  let sql = `SELECT person_id, face_id, photo_id, sample_kind, normalized_embedding
             FROM face_identity_feedback WHERE organization_id = ? AND photo_id <> ?
             AND person_id IS NOT NULL AND normalized_embedding IS NOT NULL`;
  if (modelName) { sql += ' AND model_name = ?'; params.push(modelName); }
  if (modelVersion !== undefined) { sql += ' AND model_version <=> ?'; params.push(modelVersion); }
  if (photoIds) { sql += ' AND photo_id IN (?)'; params.push(photoIds); }
  sql += ' ORDER BY id';
  const [rows] = await conn.query(sql, params);
  const grouped = new Map();
  for (const row of rows) {
    const id = Number(row.person_id);
    if (!grouped.has(id)) grouped.set(id, []);
    grouped.get(id).push(row);
  }
  const references = new Map([...grouped].map(([id, samples]) => [id, selectReferences(samples)]));
  const [pairs] = await conn.query(
    'SELECT person_low_id, person_high_id FROM face_person_separations WHERE organization_id = ?', [orgId]
  );
  return { references, separations: new Set(pairs.map((row) => pairKey(row.person_low_id, row.person_high_id))) };
}

function attachFeedbackReferences(profiles, references) {
  const byId = new Map(profiles.map((profile) => [Number(profile.personId), profile]));
  for (const [personId, samples] of references) {
    if (!samples.length) continue;
    if (!byId.has(personId)) {
      const profile = { personId, count: 0, sumVec: null, centroidVec: null, recentVecs: [] };
      profiles.push(profile);
      byId.set(personId, profile);
    }
    byId.get(personId).feedbackReferences = samples;
  }
  return byId;
}

module.exports = {
  normalize, cosine, pairKey, selectReferences, referenceScore, isSeparatedAmbiguity,
  hasProtectedFaces, recordIdentityFeedback, recordSeparation, remapMergedFeedback,
  loadFeedbackMemory, attachFeedbackReferences,
};
