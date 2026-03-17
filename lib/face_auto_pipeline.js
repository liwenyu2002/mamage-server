const { pool } = require('../db');
const { detectFacesForPhoto } = require('./face_detector');
const { getOrgFaceClusterConfig, clampThreshold, DEFAULT_MATCH_THRESHOLD } = require('./face_cluster_config');

const DEFAULT_CANDIDATE_LIMIT = 5000;
const DEFAULT_AUTO_CREATE_PERSON = true;
const DEFAULT_RECENT_VECS_PER_PERSON = 5;
const DEFAULT_ENFORCE_UNIQUE_PERSON_PER_PHOTO = true;
const DEFAULT_CANDIDATE_TOPK = 5;
const DEFAULT_WEAK_THRESHOLD_GAP = 0.08;

function envBool(name, fallback) {
  const raw = process.env[name];
  if (raw === undefined || raw === null || String(raw).trim() === '') return fallback;
  const s = String(raw).trim().toLowerCase();
  return s === '1' || s === 'true' || s === 'yes' || s === 'y';
}

function envNum(name, fallback) {
  const raw = process.env[name];
  if (raw === undefined || raw === null || String(raw).trim() === '') return fallback;
  const n = Number(raw);
  return Number.isFinite(n) ? n : fallback;
}

function envInt(name, fallback) {
  const raw = process.env[name];
  if (raw === undefined || raw === null || String(raw).trim() === '') return fallback;
  const n = Number(raw);
  return Number.isFinite(n) ? Math.floor(n) : fallback;
}

function toNum(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function parseJsonMaybe(v) {
  if (v === null || v === undefined) return null;
  if (Array.isArray(v)) return v;
  if (Buffer.isBuffer(v)) {
    try {
      return JSON.parse(v.toString('utf8'));
    } catch (e) {
      return null;
    }
  }
  if (typeof v === 'string') {
    try {
      return JSON.parse(v);
    } catch (e) {
      return null;
    }
  }
  return null;
}

function normalizeVector(vec) {
  if (!Array.isArray(vec) || vec.length === 0) return null;
  const arr = vec.map((x) => Number(x)).filter((x) => Number.isFinite(x));
  if (arr.length === 0) return null;
  let norm2 = 0;
  for (let i = 0; i < arr.length; i++) norm2 += arr[i] * arr[i];
  const norm = Math.sqrt(norm2);
  if (!Number.isFinite(norm) || norm <= 0) return null;
  return arr.map((x) => x / norm);
}

function cosine(a, b) {
  if (!Array.isArray(a) || !Array.isArray(b) || a.length === 0 || b.length === 0) return -1;
  const len = Math.min(a.length, b.length);
  let dot = 0;
  for (let i = 0; i < len; i++) dot += a[i] * b[i];
  return dot;
}

function addVector(sumVec, vec) {
  if (!Array.isArray(vec) || vec.length === 0) return sumVec || null;
  if (!Array.isArray(sumVec) || sumVec.length === 0) return vec.slice();
  if (sumVec.length !== vec.length) return sumVec;
  const out = sumVec.slice();
  for (let i = 0; i < out.length; i++) out[i] += vec[i];
  return out;
}

async function getPhotoById(photoId) {
  const [rows] = await pool.query(
    `SELECT id, project_id AS projectId, organization_id AS organizationId, url, thumb_url AS thumbUrl
     FROM photos WHERE id = ? LIMIT 1`,
    [photoId]
  );
  return rows && rows.length ? rows[0] : null;
}

function normalizeDetectedFaces(detected) {
  const rawFaces = Array.isArray(detected && detected.faces) ? detected.faces : [];
  const out = [];
  let seq = 0;

  for (const f of rawFaces) {
    const face = f && typeof f === 'object' ? f : {};
    const bbox = face.bbox && typeof face.bbox === 'object' ? face.bbox : {};
    const left = toNum(bbox.left ?? face.left);
    const top = toNum(bbox.top ?? face.top);
    const width = toNum(bbox.width ?? face.width);
    const height = toNum(bbox.height ?? face.height);
    if (left === null || top === null || width === null || height === null) continue;
    if (width <= 0 || height <= 0) continue;

    const unit = String(bbox.unit || face.unit || 'ratio').toLowerCase() === 'pixel' ? 'pixel' : 'ratio';
    const faceNoRaw = toNum(face.faceNo || face.faceNumber || face.no || null);
    seq += 1;
    const embedding = Array.isArray(face.embedding) ? face.embedding : null;
    const normalizedEmbedding = Array.isArray(face.normalizedEmbedding)
      ? face.normalizedEmbedding
      : (Array.isArray(face.normalized_embedding) ? face.normalized_embedding : null);
    const vec = normalizeVector(normalizedEmbedding || embedding || null);

    out.push({
      faceNo: faceNoRaw && faceNoRaw > 0 ? Math.floor(faceNoRaw) : seq,
      left,
      top,
      width,
      height,
      unit,
      imageWidth: toNum(face.imageWidth ?? face.image_width ?? null),
      imageHeight: toNum(face.imageHeight ?? face.image_height ?? null),
      detectionScore: toNum(face.score ?? face.confidence ?? null),
      qualityScore: toNum(face.qualityScore ?? face.quality_score ?? null),
      embedding: embedding || null,
      normalizedEmbedding: normalizedEmbedding || (vec ? vec : null),
      normalizedVector: vec,
      modelName: face.modelName || face.model || ((detected && detected.meta && detected.meta.modelName) || 'face-detector'),
      modelVersion: face.modelVersion || face.model_version || ((detected && detected.meta && detected.meta.modelVersion) || null),
      status: 'detected',
      faceHash: face.faceHash || face.face_hash || null,
      extra: face.extra && typeof face.extra === 'object' ? face.extra : null,
    });
  }

  return out;
}

async function createAutoPerson(conn, organizationId, createdBy) {
  const [seqRows] = await conn.query(
    'SELECT COALESCE(MAX(person_no), 0) AS maxNo FROM face_persons WHERE organization_id = ? FOR UPDATE',
    [organizationId]
  );
  const nextNo = ((seqRows && seqRows[0] && Number(seqRows[0].maxNo)) || 0) + 1;
  const note = 'auto-cluster';
  const [ins] = await conn.query(
    'INSERT INTO face_persons (organization_id, person_no, name, note, created_by) VALUES (?, ?, ?, ?, ?)',
    [organizationId, nextNo, null, note, createdBy || null]
  );
  return {
    id: ins.insertId,
    personNo: nextNo,
  };
}

function buildPersonProfiles(rows, recentKeep = DEFAULT_RECENT_VECS_PER_PERSON) {
  const map = new Map();

  for (const r of rows || []) {
    const personId = Number(r.personId);
    if (!Number.isFinite(personId) || personId <= 0) continue;
    const vec = normalizeVector(parseJsonMaybe(r.normalizedEmbedding) || parseJsonMaybe(r.embedding));
    if (!vec) continue;

    if (!map.has(personId)) {
      map.set(personId, {
        personId,
        count: 0,
        sumVec: null,
        centroidVec: null,
        recentVecs: [],
      });
    }

    const p = map.get(personId);
    if (Array.isArray(p.sumVec) && p.sumVec.length !== vec.length) continue;
    p.sumVec = addVector(p.sumVec, vec);
    p.count += 1;
    if (p.recentVecs.length < recentKeep) p.recentVecs.push(vec);
  }

  const profiles = [];
  for (const p of map.values()) {
    p.centroidVec = normalizeVector(p.sumVec);
    profiles.push(p);
  }
  return profiles;
}

function upsertProfileVector(profileMap, personId, vec) {
  if (!Number.isFinite(Number(personId)) || Number(personId) <= 0) return;
  if (!Array.isArray(vec) || vec.length === 0) return;
  const pid = Number(personId);
  if (!profileMap.has(pid)) {
    profileMap.set(pid, {
      personId: pid,
      count: 0,
      sumVec: null,
      centroidVec: null,
      recentVecs: [],
    });
  }
  const p = profileMap.get(pid);
  if (Array.isArray(p.sumVec) && p.sumVec.length !== vec.length) return;
  p.sumVec = addVector(p.sumVec, vec);
  p.count += 1;
  p.centroidVec = normalizeVector(p.sumVec);
  p.recentVecs.unshift(vec);
  if (p.recentVecs.length > DEFAULT_RECENT_VECS_PER_PERSON) p.recentVecs.length = DEFAULT_RECENT_VECS_PER_PERSON;
}

async function loadPersonProfiles(conn, organizationId, exceptPhotoId, limit) {
  const safeLimit = Math.max(100, Math.min(20000, Number(limit) || DEFAULT_CANDIDATE_LIMIT));
  const [rows] = await conn.query(
    `SELECT pf.person_id AS personId, pf.normalized_embedding AS normalizedEmbedding, pf.embedding AS embedding
     FROM photo_faces pf
     WHERE pf.organization_id = ?
       AND pf.person_id IS NOT NULL
       AND pf.photo_id <> ?
       AND (pf.normalized_embedding IS NOT NULL OR pf.embedding IS NOT NULL)
     ORDER BY pf.updated_at DESC, pf.id DESC
    LIMIT ?`,
    [organizationId, exceptPhotoId, safeLimit]
  );

  const profiles = buildPersonProfiles(rows, DEFAULT_RECENT_VECS_PER_PERSON);
  const profileMap = new Map();
  for (const p of profiles) profileMap.set(p.personId, p);
  return { profiles, profileMap };
}

function scoreProfile(vec, profile) {
  if (!Array.isArray(vec) || !profile) return -1;
  const centroidScore = profile.centroidVec ? cosine(vec, profile.centroidVec) : -1;
  let recentBest = -1;
  const recent = Array.isArray(profile.recentVecs) ? profile.recentVecs : [];
  for (const rv of recent) {
    const s = cosine(vec, rv);
    if (Number.isFinite(s) && s > recentBest) recentBest = s;
  }

  if (centroidScore < -0.5 && recentBest < -0.5) return -1;
  if (recentBest < -0.5) return centroidScore;
  if (centroidScore < -0.5) return recentBest;
  return (0.7 * centroidScore) + (0.3 * recentBest);
}

function findBestMatch(vec, profiles) {
  if (!vec || !Array.isArray(profiles) || profiles.length === 0) return null;
  let best = null;
  for (const p of profiles) {
    const score = scoreProfile(vec, p);
    if (!Number.isFinite(score)) continue;
    if (!best || score > best.score) {
      best = { personId: p.personId, score };
    }
  }
  return best;
}

function findTopMatches(vec, profiles, k = DEFAULT_CANDIDATE_TOPK) {
  if (!vec || !Array.isArray(profiles) || profiles.length === 0) return [];
  const maxK = Math.max(1, Math.min(20, Number(k) || DEFAULT_CANDIDATE_TOPK));
  const out = [];
  for (const p of profiles) {
    const score = scoreProfile(vec, p);
    if (!Number.isFinite(score)) continue;
    out.push({ personId: p.personId, score });
  }
  out.sort((a, b) => b.score - a.score);
  return out.slice(0, maxK);
}

function buildCandidateSummary(candidates) {
  return (Array.isArray(candidates) ? candidates : []).map((c) => ({
    personId: Number(c.personId),
    score: Number(Number(c.score).toFixed(6)),
  }));
}

function buildFaceMatchPlans(faces, profiles, candidateTopK, matchThreshold, weakThreshold) {
  return (Array.isArray(faces) ? faces : []).map((face, index) => {
    const topMatches = findTopMatches(face.normalizedVector, profiles, candidateTopK);
    const strongCandidates = topMatches
      .map((m, rank) => ({ personId: m.personId, score: m.score, rank }))
      .filter((m) => m.score >= matchThreshold);
    const strongPersonSet = new Set(strongCandidates.map((m) => Number(m.personId)));
    const weakCandidate = topMatches.find((m) => m.score >= weakThreshold && !strongPersonSet.has(Number(m.personId))) || null;
    return {
      index,
      topMatches,
      strongCandidates,
      weakCandidate,
    };
  });
}

function assignStrongCandidates(plans, enforceUniquePersonPerPhoto) {
  const assignments = new Map();
  if (!Array.isArray(plans) || plans.length === 0) return assignments;

  if (!enforceUniquePersonPerPhoto) {
    for (const p of plans) {
      if (p && Array.isArray(p.strongCandidates) && p.strongCandidates.length > 0) {
        const c = p.strongCandidates[0];
        assignments.set(Number(p.index), { personId: Number(c.personId), score: Number(c.score), rank: Number(c.rank) });
      }
    }
    return assignments;
  }

  const edges = [];
  for (const p of plans) {
    if (!p || !Array.isArray(p.strongCandidates)) continue;
    for (const c of p.strongCandidates) {
      edges.push({
        faceIndex: Number(p.index),
        personId: Number(c.personId),
        score: Number(c.score),
        rank: Number(c.rank),
      });
    }
  }

  edges.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    if (a.rank !== b.rank) return a.rank - b.rank;
    return a.faceIndex - b.faceIndex;
  });

  const usedFaces = new Set();
  const usedPersons = new Set();
  for (const e of edges) {
    if (usedFaces.has(e.faceIndex)) continue;
    if (usedPersons.has(e.personId)) continue;
    usedFaces.add(e.faceIndex);
    usedPersons.add(e.personId);
    assignments.set(e.faceIndex, { personId: e.personId, score: e.score, rank: e.rank });
  }

  return assignments;
}

async function detectAndClusterPhoto({
  photoId,
  uploaderId = null,
  force = true,
  organizationIdOverride = null,
  matchThresholdOverride = null,
} = {}) {
  const pid = Number(photoId);
  if (!Number.isFinite(pid) || pid <= 0) {
    throw new Error('detectAndClusterPhoto: invalid photoId');
  }

  const photo = await getPhotoById(pid);
  if (!photo) {
    return { ok: false, skipped: true, reason: 'photo_not_found', photoId: pid };
  }

  const orgOverride = Number(organizationIdOverride);
  const organizationId = Number.isFinite(orgOverride) && orgOverride > 0
    ? orgOverride
    : Number(photo.organizationId);
  if (!Number.isFinite(organizationId) || organizationId <= 0) {
    return { ok: false, skipped: true, reason: 'organization_id_missing', photoId: pid };
  }

  if (!force) {
    const [existRows] = await pool.query('SELECT COUNT(*) AS c FROM photo_faces WHERE photo_id = ? LIMIT 1', [pid]);
    const c = existRows && existRows[0] ? Number(existRows[0].c) || 0 : 0;
    if (c > 0) {
      return { ok: true, skipped: true, reason: 'already_has_faces', photoId: pid, existingFaces: c };
    }
  }

  const detected = await detectFacesForPhoto(photo);
  const faces = normalizeDetectedFaces(detected);

  let matchThreshold = clampThreshold(matchThresholdOverride);
  let thresholdSource = 'override';
  if (matchThreshold === null) {
    const cfg = await getOrgFaceClusterConfig(organizationId);
    matchThreshold = clampThreshold(cfg && cfg.matchThreshold);
    thresholdSource = cfg && cfg.source ? cfg.source : 'env';
  }
  if (matchThreshold === null) {
    matchThreshold = DEFAULT_MATCH_THRESHOLD;
    thresholdSource = 'default';
  }
  const autoCreatePerson = envBool('FACE_CLUSTER_AUTO_CREATE_PERSON', DEFAULT_AUTO_CREATE_PERSON);
  const candidateLimit = envNum('FACE_CLUSTER_CANDIDATE_LIMIT', DEFAULT_CANDIDATE_LIMIT);
  const candidateTopK = Math.max(1, Math.min(20, envInt('FACE_CLUSTER_TOPK', DEFAULT_CANDIDATE_TOPK)));
  const enforceUniquePersonPerPhoto = envBool(
    'FACE_CLUSTER_UNIQUE_PERSON_PER_PHOTO',
    DEFAULT_ENFORCE_UNIQUE_PERSON_PER_PHOTO
  );
  const weakThresholdRaw = envNum('FACE_CLUSTER_WEAK_THRESHOLD', matchThreshold - DEFAULT_WEAK_THRESHOLD_GAP);
  const weakThreshold = Math.max(0.2, Math.min(matchThreshold, Number.isFinite(weakThresholdRaw) ? weakThresholdRaw : (matchThreshold - DEFAULT_WEAK_THRESHOLD_GAP)));

  const conn = await pool.getConnection();
  const createdPersonIds = [];
  let matchedCount = 0;
  let insertedRows = 0;
  let duplicateMatchSuppressed = 0;
  let suspectCount = 0;

  try {
    await conn.beginTransaction();

    await conn.query('DELETE FROM photo_faces WHERE photo_id = ?', [pid]);

    const { profiles, profileMap } = await loadPersonProfiles(conn, organizationId, pid, candidateLimit);
    const faceNoSet = new Set();
    let fallbackNo = 0;
    const pendingCoverUpdates = [];
    const createdPersonIdSet = new Set();

    const matchPlans = buildFaceMatchPlans(faces, profiles, candidateTopK, matchThreshold, weakThreshold);
    const strongAssignments = assignStrongCandidates(matchPlans, enforceUniquePersonPerPhoto);
    const matchedPersonInPhoto = new Set(
      Array.from(strongAssignments.values()).map((x) => Number(x.personId)).filter((x) => Number.isFinite(x) && x > 0)
    );

    for (let faceIndex = 0; faceIndex < faces.length; faceIndex++) {
      const face = faces[faceIndex];
      const plan = matchPlans[faceIndex] || { topMatches: [], strongCandidates: [], weakCandidate: null };
      let faceNo = Number(face.faceNo) || 0;
      if (!faceNo || faceNoSet.has(faceNo)) {
        do {
          fallbackNo += 1;
          faceNo = fallbackNo;
        } while (faceNoSet.has(faceNo));
      }
      faceNoSet.add(faceNo);

      let personId = null;
      let faceStatus = face.status || 'detected';
      const topMatches = plan.topMatches || [];
      const strongCandidates = Array.isArray(plan.strongCandidates) ? plan.strongCandidates : [];
      const weak = plan.weakCandidate || null;
      let clusterDecision = 'unmatched';

      const strongAssigned = strongAssignments.get(faceIndex) || null;
      if (strongAssigned) {
        personId = Number(strongAssigned.personId);
        matchedCount += 1;
        faceStatus = 'confirmed';
        clusterDecision = strongAssigned.rank > 0 ? 'strong_match_fallback' : 'strong_match';
      } else if (strongCandidates.length > 0) {
        duplicateMatchSuppressed += 1;
        if (weak) {
          faceStatus = 'suspect';
          suspectCount += 1;
          clusterDecision = 'weak_match_conflict';
        } else {
          faceStatus = 'suspect';
          suspectCount += 1;
          clusterDecision = 'strong_conflict';
        }
      } else if (weak) {
        faceStatus = 'suspect';
        suspectCount += 1;
        clusterDecision = 'weak_match';
      } else if (autoCreatePerson) {
        const p = await createAutoPerson(conn, organizationId, uploaderId);
        personId = p.id;
        if (enforceUniquePersonPerPhoto) matchedPersonInPhoto.add(p.id);
        createdPersonIds.push(p.id);
        createdPersonIdSet.add(p.id);
        faceStatus = 'confirmed';
        clusterDecision = 'auto_create';
      }

      const mergedExtra = Object.assign(
        {},
        face.extra && typeof face.extra === 'object' ? face.extra : {},
        {
          clusterDecision,
          clusterStrongThreshold: matchThreshold,
          clusterWeakThreshold: weakThreshold,
          clusterCandidates: buildCandidateSummary(topMatches),
        }
      );

      const [ins] = await conn.query(
        `INSERT INTO photo_faces (
          photo_id, project_id, organization_id, person_id, face_no,
          bbox_x, bbox_y, bbox_w, bbox_h, bbox_unit,
          image_width, image_height, detection_score, quality_score,
          embedding, normalized_embedding,
          model_name, model_version, status, face_hash, extra
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          pid,
          photo.projectId || null,
          organizationId,
          personId,
          faceNo,
          face.left,
          face.top,
          face.width,
          face.height,
          face.unit || 'ratio',
          face.imageWidth,
          face.imageHeight,
          face.detectionScore,
          face.qualityScore,
          face.embedding ? JSON.stringify(face.embedding) : null,
          face.normalizedEmbedding ? JSON.stringify(face.normalizedEmbedding) : null,
          face.modelName || 'face-detector',
          face.modelVersion || null,
          faceStatus,
          face.faceHash || null,
          mergedExtra ? JSON.stringify(mergedExtra) : null,
        ]
      );

      insertedRows += 1;

      if (personId && createdPersonIdSet.has(personId)) {
        pendingCoverUpdates.push({ personId, faceId: ins.insertId });
      }

      if (face.normalizedVector && personId) {
        upsertProfileVector(profileMap, personId, face.normalizedVector);
        const p = profileMap.get(Number(personId));
        if (p && !profiles.find((x) => x.personId === p.personId)) {
          profiles.push(p);
        }
      }
    }

    for (const c of pendingCoverUpdates) {
      await conn.query('UPDATE face_persons SET cover_face_id = COALESCE(cover_face_id, ?) WHERE id = ?', [c.faceId, c.personId]);
    }

    await conn.commit();
  } catch (err) {
    await conn.rollback();
    throw err;
  } finally {
    conn.release();
  }

  return {
    ok: true,
    skipped: false,
    photoId: pid,
    organizationId,
    totalFaces: faces.length,
    insertedRows,
    matchedCount,
    duplicateMatchSuppressed,
    suspectCount,
    createdPersons: createdPersonIds.length,
    matchThreshold,
    weakThreshold,
    candidateTopK,
    thresholdSource,
    detector: detected && detected.meta ? detected.meta : null,
  };
}

module.exports = {
  detectAndClusterPhoto,
};
