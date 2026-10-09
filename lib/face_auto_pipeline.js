const { pool } = require('../db');
const { detectFacesForPhoto } = require('./face_detector');
const { getOrgFaceClusterConfig, clampThreshold, DEFAULT_MATCH_THRESHOLD } = require('./face_cluster_config');
const {
  hasProtectedFaces, loadFeedbackMemory, attachFeedbackReferences, normalize: normalizeVector, cosine,
} = require('./face_feedback');
const { buildIdentityProfiles, scoreIdentityProfile: profileMatchEvidence, classifyIdentityMatch,
  matchMargin: configuredMatchMargin, sameEmbeddingSpace } = require('./face_matching');

const DEFAULT_PROFILE_VECS_PER_PERSON = 8;
const DEFAULT_AUTO_CREATE_PERSON = true;
const DEFAULT_RECENT_VECS_PER_PERSON = 5;
const DEFAULT_ENFORCE_UNIQUE_PERSON_PER_PHOTO = true;
const DEFAULT_CANDIDATE_TOPK = 5;
const DEFAULT_WEAK_THRESHOLD_GAP = 0.08;

// Scene/seat similarity is not identity evidence. Keep this opt-in, without lowering the face threshold.
const BURST_PRIOR_ENABLED = String(process.env.FACE_BURST_PRIOR || '0') === '1';
const BURST_IMG_COS = Number(process.env.FACE_BURST_IMG_COS || 0.6);
const BURST_CENTER_DIST = Number(process.env.FACE_BURST_CENTER_DIST || 0.2);
const BURST_FACE_SIM = Number(process.env.FACE_BURST_FACE_SIM || 0.30);

// bbox → 归一化中心点（像素单位按图宽高折算；缺宽高返回 null 即放弃该脸的先验）
function bboxCenterRatio(x, y, w, h, imgW, imgH) {
  let bx = Number(x), by = Number(y), bw = Number(w), bh = Number(h);
  if (![bx, by, bw, bh].every(Number.isFinite) || bw <= 0 || bh <= 0) return null;
  if (bw > 1.5 || bh > 1.5) {
    const iw = Number(imgW), ih = Number(imgH);
    if (!iw || !ih) return null;
    bx /= iw; by /= ih; bw /= iw; bh /= ih;
  }
  return { cx: bx + bw / 2, cy: by + bh / 2 };
}

// 加载本照片的"连拍邻居"里已归属的脸：[{personId, vec, cx, cy, imgCos}]。任何一步缺数据都安静降级为 []。
async function loadBurstSiblingFaces(conn, photoId, projectId, space) {
  if (!BURST_PRIOR_ENABLED || !space?.modelName) return [];
  const proj = Number(projectId);
  if (!Number.isFinite(proj) || proj <= 0) return [];
  try {
    const [embRows] = await conn.query(
      `SELECT e.photo_id AS photoId, e.embedding
       FROM ai_image_embeddings e JOIN photos p ON p.id = e.photo_id
       WHERE e.model_name = 'resnet50' AND p.project_id = ?`,
      [proj]
    );
    const self = (embRows || []).find((r) => Number(r.photoId) === Number(photoId));
    const selfVec = self ? normalizeVector(parseJsonMaybe(self.embedding)) : null;
    if (!selfVec) return [];
    const sibCos = new Map();
    for (const r of embRows) {
      if (Number(r.photoId) === Number(photoId)) continue;
      const v = normalizeVector(parseJsonMaybe(r.embedding));
      if (!v || v.length !== selfVec.length) continue;
      const c = cosine(selfVec, v);
      if (Number.isFinite(c) && c >= BURST_IMG_COS) sibCos.set(Number(r.photoId), c);
    }
    if (!sibCos.size) return [];
    const [faceRows] = await conn.query(
      `SELECT photo_id AS photoId, person_id AS personId,
              bbox_x, bbox_y, bbox_w, bbox_h, image_width, image_height,
              normalized_embedding AS ne, embedding AS e, model_name AS modelName, model_version AS modelVersion
       FROM photo_faces WHERE photo_id IN (?) AND person_id IS NOT NULL
         AND model_name = ? AND model_version <=> ? AND status NOT IN ('rejected', 'deleted')`,
      [Array.from(sibCos.keys()), space.modelName, space.modelVersion ?? null]
    );
    const out = [];
    for (const r of faceRows || []) {
      if (!sameEmbeddingSpace(r, space)) continue;
      const vec = normalizeVector(parseJsonMaybe(r.ne) || parseJsonMaybe(r.e));
      const c = bboxCenterRatio(r.bbox_x, r.bbox_y, r.bbox_w, r.bbox_h, r.image_width, r.image_height);
      if (!vec || !c) continue;
      out.push({ personId: Number(r.personId), vec, cx: c.cx, cy: c.cy, imgCos: sibCos.get(Number(r.photoId)) || 0 });
    }
    return out;
  } catch (e) {
    console.warn('[face_pipeline] burst prior context load failed:', e && e.message);
    return [];
  }
}

// 对单张脸找连拍先验匹配：三条件齐过，取 imgCos 最高者。excluded=本照片已占用的人物（每照一人约束）。
function findBurstPriorMatch(faceVec, faceCenter, siblings, excluded) {
  if (!faceVec || !faceCenter || !Array.isArray(siblings) || !siblings.length) return null;
  let best = null;
  for (const s of siblings) {
    if (excluded && excluded.has(Number(s.personId))) continue;
    const d = Math.hypot(faceCenter.cx - s.cx, faceCenter.cy - s.cy);
    if (d > BURST_CENTER_DIST) continue;
    if (s.vec.length !== faceVec.length) continue;
    const sim = cosine(faceVec, s.vec);
    if (!Number.isFinite(sim) || sim < BURST_FACE_SIM) continue;
    if (!best || s.imgCos > best.imgCos) best = { personId: Number(s.personId), imgCos: s.imgCos, dist: d, faceSim: sim };
  }
  return best;
}

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
  if (v == null || v === '') return null;
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

async function getPhotoById(photoId) {
  const [rows] = await pool.query(
    `SELECT id, project_id AS projectId, organization_id AS organizationId,
            url, thumb_url AS thumbUrl, public_download_url AS publicDownloadUrl
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
    const vec = normalizeVector(normalizedEmbedding) || normalizeVector(embedding);

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
      embedding: normalizeVector(embedding) ? embedding : null,
      normalizedEmbedding: vec,
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

async function loadPersonProfiles(conn, organizationId, exceptPhotoId, perPersonLimit, space) {
  const safePerPersonLimit = Math.max(1, Math.min(20, Number(perPersonLimit) || DEFAULT_PROFILE_VECS_PER_PERSON));
  const [rows] = await conn.query(
    `SELECT pf.person_id AS personId, pf.normalized_embedding AS normalizedEmbedding, pf.embedding AS embedding,
            pf.model_name AS modelName, pf.model_version AS modelVersion, pf.status
     FROM photo_faces pf
     JOIN (
       SELECT id, person_id,
              ROW_NUMBER() OVER (PARTITION BY person_id ORDER BY updated_at DESC, id DESC) AS rn
       FROM photo_faces
       WHERE organization_id = ?
         AND person_id IS NOT NULL
         AND photo_id <> ?
         AND model_name = ? AND model_version <=> ?
         AND status NOT IN ('rejected', 'deleted')
         AND (normalized_embedding IS NOT NULL OR embedding IS NOT NULL)
     ) ranked ON ranked.id = pf.id
     WHERE ranked.rn <= ?
     ORDER BY ranked.person_id, ranked.rn`,
    [organizationId, exceptPhotoId, space.modelName, space.modelVersion ?? null, safePerPersonLimit]
  );

  return buildIdentityProfiles(rows, { space, sampleLimit: safePerPersonLimit,
    recentLimit: DEFAULT_RECENT_VECS_PER_PERSON });
}

function findTopMatches(vec, profiles, k = DEFAULT_CANDIDATE_TOPK) {
  if (!vec || !Array.isArray(profiles) || profiles.length === 0) return [];
  const maxK = Math.max(1, Math.min(profiles.length, Number(k) || DEFAULT_CANDIDATE_TOPK));
  const out = [];
  for (const p of profiles) {
    const evidence = profileMatchEvidence(vec, p);
    if (!Number.isFinite(evidence.score)) continue;
    out.push({ personId: p.personId, ...evidence });
  }
  out.sort((a, b) => b.score - a.score);
  return out.slice(0, maxK);
}

function buildCandidateSummary(candidates) {
  return (Array.isArray(candidates) ? candidates : []).map((c) => ({
    personId: Number(c.personId),
    score: Number(Number(c.score).toFixed(6)),
    ...(c.referenceScore !== null && c.referenceScore !== undefined ? {
      referenceScore: Number(c.referenceScore.toFixed(6)),
      automaticScore: Number(c.automaticScore.toFixed(6)),
    } : {}),
  }));
}

function faceSpaceKey(face) {
  return JSON.stringify([face.modelName, face.modelVersion ?? null]);
}

function buildFaceMatchPlans(faces, contexts, candidateTopK, matchThreshold, weakThreshold, matchMargin) {
  return (Array.isArray(faces) ? faces : []).map((face, index) => {
    const { profiles = [], separations = new Set() } = contexts.get(faceSpaceKey(face)) || {};
    const ranked = findTopMatches(face.normalizedVector, profiles, profiles.length);
    const topMatches = ranked.slice(0, candidateTopK);
    const { best, feedbackConflict, ambiguous, referenceConflict } = classifyIdentityMatch(ranked,
      { threshold: matchThreshold, margin: matchMargin, separations });
    // A face cannot inherit its second-best identity just because the best one is occupied.
    const strongCandidates = best ? [{ personId: best.personId, score: best.score, rank: 0 }] : [];
    const strongPersonSet = new Set(strongCandidates.map((m) => Number(m.personId)));
    const weakCandidate = topMatches.find((m) => m.score >= weakThreshold && !strongPersonSet.has(Number(m.personId))) || null;
    return {
      index,
      topMatches,
      strongCandidates,
      weakCandidate,
      feedbackConflict,
      ambiguous,
      referenceConflict,
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

  if (await hasProtectedFaces(pool, pid, organizationId)) {
    return { ok: true, skipped: true, reason: 'manual_faces_protected', photoId: pid };
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
  const profileVecsPerPerson = envInt('FACE_CLUSTER_PROFILE_VECS_PER_PERSON', DEFAULT_PROFILE_VECS_PER_PERSON);
  const candidateTopK = Math.max(1, Math.min(20, envInt('FACE_CLUSTER_TOPK', DEFAULT_CANDIDATE_TOPK)));
  const enforceUniquePersonPerPhoto = envBool(
    'FACE_CLUSTER_UNIQUE_PERSON_PER_PHOTO',
    DEFAULT_ENFORCE_UNIQUE_PERSON_PER_PHOTO
  );
  const weakThresholdRaw = envNum('FACE_CLUSTER_WEAK_THRESHOLD', matchThreshold - DEFAULT_WEAK_THRESHOLD_GAP);
  const weakThreshold = Math.max(0.2, Math.min(matchThreshold, Number.isFinite(weakThresholdRaw) ? weakThresholdRaw : (matchThreshold - DEFAULT_WEAK_THRESHOLD_GAP)));
  const matchMargin = configuredMatchMargin();

  const conn = await pool.getConnection();
  const createdPersonIds = [];
  let matchedCount = 0;
  let insertedRows = 0;
  let duplicateMatchSuppressed = 0;
  let suspectCount = 0;

  try {
    await conn.beginTransaction();

    await conn.query('DELETE FROM photo_faces WHERE photo_id = ?', [pid]);
    // Recheck after DELETE obtains row locks: a correction may have committed during detection.
    if (await hasProtectedFaces(conn, pid, organizationId)) {
      await conn.rollback();
      return { ok: true, skipped: true, reason: 'manual_faces_protected', photoId: pid };
    }

    const contexts = new Map();
    for (const face of faces) {
      const key = faceSpaceKey(face);
      if (!face.normalizedVector || contexts.has(key)) continue;
      const profiles = await loadPersonProfiles(conn, organizationId, pid, profileVecsPerPerson, face);
      const memory = await loadFeedbackMemory(conn, organizationId, {
        exceptPhotoId: pid, modelName: face.modelName, modelVersion: face.modelVersion ?? null,
      });
      const profileMap = attachFeedbackReferences(profiles, memory.references);
      const burstSiblings = await loadBurstSiblingFaces(conn, pid, photo.projectId, face);
      contexts.set(key, { profiles, profileMap, separations: memory.separations, burstSiblings });
    }
    const faceNoSet = new Set();
    let fallbackNo = 0;
    const pendingCoverUpdates = [];
    const createdPersonIdSet = new Set();

    const matchPlans = buildFaceMatchPlans(faces, contexts, candidateTopK, matchThreshold, weakThreshold, matchMargin);
    const strongAssignments = assignStrongCandidates(matchPlans, enforceUniquePersonPerPhoto);
    const matchedPersonInPhoto = new Set(
      Array.from(strongAssignments.values()).map((x) => Number(x.personId)).filter((x) => Number.isFinite(x) && x > 0)
    );

    for (let faceIndex = 0; faceIndex < faces.length; faceIndex++) {
      const face = faces[faceIndex];
      const { profileMap = new Map(), burstSiblings = [] } = contexts.get(faceSpaceKey(face)) || {};
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
      let referenceConflict = Boolean(plan.referenceConflict);
      // Optional scene context must not bypass face confidence or reviewed evidence.
      let burstMatch = null;
      if (!strongAssigned && !plan.feedbackConflict && !plan.ambiguous && !referenceConflict
        && burstSiblings.length && face.normalizedVector) {
        const fc = bboxCenterRatio(face.left, face.top, face.width, face.height, face.imageWidth, face.imageHeight);
        burstMatch = findBurstPriorMatch(
          face.normalizedVector, fc, burstSiblings,
          enforceUniquePersonPerPhoto ? matchedPersonInPhoto : null
        );
        if (burstMatch && burstMatch.faceSim < matchThreshold) burstMatch = null;
        if (burstMatch) {
          const evidence = profileMatchEvidence(face.normalizedVector, profileMap.get(burstMatch.personId));
          if (evidence.referenceScore !== null && evidence.referenceScore < matchThreshold) {
            referenceConflict = true;
            burstMatch = null;
          }
        }
      }
      if (plan.feedbackConflict) {
        faceStatus = 'suspect';
        suspectCount += 1;
        clusterDecision = 'manual_separation_conflict';
      } else if (plan.ambiguous) {
        faceStatus = 'suspect';
        suspectCount += 1;
        clusterDecision = 'ambiguous_match';
      } else if (strongAssigned) {
        personId = Number(strongAssigned.personId);
        matchedCount += 1;
        faceStatus = 'confirmed';
        clusterDecision = strongAssigned.rank > 0 ? 'strong_match_fallback' : 'strong_match';
      } else if (burstMatch) {
        personId = burstMatch.personId;
        matchedCount += 1;
        faceStatus = 'confirmed';
        clusterDecision = 'burst_prior';
        if (enforceUniquePersonPerPhoto) matchedPersonInPhoto.add(personId);
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
      } else if (referenceConflict) {
        faceStatus = 'suspect';
        suspectCount += 1;
        clusterDecision = 'manual_reference_conflict';
      } else if (weak) {
        faceStatus = 'suspect';
        suspectCount += 1;
        clusterDecision = 'weak_match';
      } else if (!face.normalizedVector) {
        clusterDecision = 'no_embedding';
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
          clusterMatchMargin: matchMargin,
          clusterCandidates: buildCandidateSummary(topMatches),
          ...(clusterDecision === 'burst_prior' ? {
            burstPrior: {
              imgCos: Number(burstMatch.imgCos.toFixed(4)),
              centerDist: Number(burstMatch.dist.toFixed(4)),
              faceSim: Number(burstMatch.faceSim.toFixed(4)),
            },
          } : {}),
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
    matchMargin,
    candidateTopK,
    thresholdSource,
    detector: detected && detected.meta ? detected.meta : null,
  };
}

module.exports = {
  detectAndClusterPhoto,
  // 连拍位置先验的原语（导出供脚本验证/回头认领复用）
  loadBurstSiblingFaces,
  findBurstPriorMatch,
  bboxCenterRatio,
};
