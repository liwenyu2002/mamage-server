const express = require('express');
const router = express.Router();
const { pool, buildUploadUrl } = require('../db');
const { requirePermission } = require('../lib/permissions');
const { detectFacesForPhoto } = require('../lib/face_detector');
const {
  getOrgFaceClusterConfig,
  MIN_THRESHOLD,
  MAX_THRESHOLD,
  isMissingConfigTableError,
} = require('../lib/face_cluster_config');

function toNumberOrNull(v) {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function parseJsonMaybe(v) {
  if (v === null || v === undefined) return null;
  if (Array.isArray(v) || (typeof v === 'object' && v !== null)) return v;
  try {
    return JSON.parse(String(v));
  } catch (e) {
    return null;
  }
}

function getOrgIdFromReq(req) {
  const raw = req && req.user ? req.user.organization_id : null;
  if (raw === null || raw === undefined) return null;
  const n = Number(raw);
  return Number.isFinite(n) ? n : null;
}

function appendOrgScope(sqlBase, alias, orgId, params) {
  if (orgId === null) {
    return `${sqlBase} AND ${alias}.organization_id IS NULL`;
  }
  params.push(orgId);
  return `${sqlBase} AND ${alias}.organization_id = ?`;
}

function schemaErrorResponse(res, err, endpointTag) {
  const code = err && err.code;
  if (code === 'ER_NO_SUCH_TABLE' || code === 'ER_BAD_FIELD_ERROR') {
    return res.status(503).json({
      error: 'FACE_SCHEMA_NOT_READY',
      message: 'Face schema is not ready. Please run database migrations first.',
      endpoint: endpointTag,
      detail: err && err.message ? err.message : String(err),
    });
  }
  return null;
}

function detectorErrorResponse(res, err, endpointTag) {
  const code = err && err.code ? String(err.code) : '';
  if (!code.startsWith('FACE_')) return null;
  return res.status(503).json({
    error: code || 'FACE_DETECT_FAILED',
    message: err && err.message ? err.message : 'Face detector is unavailable',
    endpoint: endpointTag,
    detail: err && err.detail ? err.detail : null,
    installHint: err && err.installHint ? err.installHint : null,
  });
}

function parsePersonIdArray(input) {
  if (Array.isArray(input)) {
    return input
      .map((x) => Number(x))
      .filter((x) => Number.isFinite(x) && x > 0)
      .map((x) => Math.floor(x));
  }
  const one = Number(input);
  if (!Number.isFinite(one) || one <= 0) return [];
  return [Math.floor(one)];
}

function mapFaceRow(row) {
  const left = toNumberOrNull(row.bbox_x) || 0;
  const top = toNumberOrNull(row.bbox_y) || 0;
  const width = toNumberOrNull(row.bbox_w) || 0;
  const height = toNumberOrNull(row.bbox_h) || 0;
  const unit = (row.bbox_unit || 'ratio') === 'pixel' ? 'pixel' : 'ratio';
  const faceNo = Number(row.face_no) || 1;
  const personId = row.person_id === null || row.person_id === undefined ? null : String(row.person_id);
  const personName = row.person_name ? String(row.person_name) : null;

  return {
    faceId: String(row.id),
    id: String(row.id),
    faceNo,
    photoId: row.photo_id,
    projectId: row.project_id,
    personId,
    personName,
    label: personName || (personId ? `人物#${personId}` : `人脸#${faceNo}`),
    bbox: {
      left,
      top,
      width,
      height,
      normalized: unit === 'ratio',
      unit,
    },
    left,
    top,
    width,
    height,
    unit,
    imageWidth: row.image_width || null,
    imageHeight: row.image_height || null,
    score: toNumberOrNull(row.detection_score),
    qualityScore: toNumberOrNull(row.quality_score),
    modelName: row.model_name || null,
    modelVersion: row.model_version || null,
    status: row.status || 'detected',
    embedding: parseJsonMaybe(row.embedding),
    normalizedEmbedding: parseJsonMaybe(row.normalized_embedding),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function mapRelatedPhoto(row) {
  return {
    id: String(row.id),
    photoId: String(row.id),
    projectId: row.projectId || null,
    projectName: row.projectName || null,
    url: row.url ? buildUploadUrl(row.url) : null,
    thumbUrl: row.thumbUrl ? buildUploadUrl(row.thumbUrl) : (row.url ? buildUploadUrl(row.url) : null),
    title: row.title || row.description || null,
    description: row.description || null,
  };
}

async function getPhotoBasic(photoId, orgId) {
  const params = [photoId];
  let sql = `
    SELECT
      id,
      project_id AS projectId,
      organization_id AS organizationId,
      url,
      thumb_url AS thumbUrl,
      title,
      description
    FROM photos
    WHERE id = ?
  `;
  sql = appendOrgScope(sql, 'photos', orgId, params);
  sql += ' LIMIT 1';
  const [rows] = await pool.query(sql, params);
  return rows && rows.length ? rows[0] : null;
}

async function listFacesByPhotoId(photoId, orgId) {
  const params = [photoId];
  let sql = `
    SELECT
      pf.*,
      fp.name AS person_name
    FROM photo_faces pf
    LEFT JOIN face_persons fp ON pf.person_id = fp.id
    WHERE pf.photo_id = ?
  `;
  sql = appendOrgScope(sql, 'pf', orgId, params);
  sql += ' ORDER BY pf.face_no ASC, pf.id ASC';
  const [rows] = await pool.query(sql, params);
  return (rows || []).map(mapFaceRow);
}

async function getFaceWithPerson(faceId, orgId) {
  const params = [faceId];
  let sql = `
    SELECT
      pf.*,
      fp.name AS person_name,
      fp.note AS person_note,
      fp.person_no AS person_no,
      p.url AS photo_url,
      p.thumb_url AS photo_thumb_url,
      p.title AS photo_title,
      p.description AS photo_description
    FROM photo_faces pf
    LEFT JOIN face_persons fp ON pf.person_id = fp.id
    LEFT JOIN photos p ON p.id = pf.photo_id
    WHERE pf.id = ?
  `;
  sql = appendOrgScope(sql, 'pf', orgId, params);
  sql += ' LIMIT 1';
  const [rows] = await pool.query(sql, params);
  return rows && rows.length ? rows[0] : null;
}

async function listRelatedPhotosByPersonId(personId, orgId, limit = null) {
  const hasLimit = Number.isFinite(Number(limit)) && Number(limit) > 0;
  const safeLimit = hasLimit ? Math.max(1, Math.min(5000, Number(limit))) : null;
  const params = [personId];
  let sql = `
    SELECT DISTINCT
      p.id,
      p.project_id AS projectId,
      pr.name AS projectName,
      p.url,
      p.thumb_url AS thumbUrl,
      p.title,
      p.description,
      p.created_at AS createdAt
    FROM photo_faces pf
    JOIN photos p ON pf.photo_id = p.id
    LEFT JOIN projects pr ON p.project_id = pr.id
    WHERE pf.person_id = ?
  `;
  sql = appendOrgScope(sql, 'pf', orgId, params);
  sql += ' ORDER BY p.created_at DESC, p.id DESC';
  if (safeLimit) {
    sql += ' LIMIT ?';
    params.push(safeLimit);
  }
  const [rows] = await pool.query(sql, params);
  return (rows || []).map(mapRelatedPhoto);
}

function normalizeIncomingFace(face, idx) {
  const source = face && typeof face === 'object' ? face : {};
  const box = source.bbox || source.box || source.rect || source.region || source.faceBox || source.location || {};

  let left = toNumberOrNull(box.left ?? box.x ?? box.x1 ?? source.left ?? source.x ?? source.x1);
  let top = toNumberOrNull(box.top ?? box.y ?? box.y1 ?? source.top ?? source.y ?? source.y1);
  let width = toNumberOrNull(box.width ?? box.w ?? source.width ?? source.w);
  let height = toNumberOrNull(box.height ?? box.h ?? source.height ?? source.h);
  const right = toNumberOrNull(box.right ?? box.x2 ?? source.right ?? source.x2);
  const bottom = toNumberOrNull(box.bottom ?? box.y2 ?? source.bottom ?? source.y2);

  if ((left === null || top === null || width === null || height === null) && Array.isArray(box) && box.length >= 4) {
    left = left ?? toNumberOrNull(box[0]);
    top = top ?? toNumberOrNull(box[1]);
    width = width ?? toNumberOrNull(box[2]);
    height = height ?? toNumberOrNull(box[3]);
  }

  if (width === null && left !== null && right !== null) width = right - left;
  if (height === null && top !== null && bottom !== null) height = bottom - top;

  if (left === null || top === null || width === null || height === null || width <= 0 || height <= 0) {
    return null;
  }

  const explicitUnit = String(source.unit || source.bboxUnit || box.unit || '').toLowerCase();
  const normalizedHint = Boolean(source.normalized ?? box.normalized);
  const looksRatio = Math.abs(left) <= 1.1 && Math.abs(top) <= 1.1 && Math.abs(width) <= 1.2 && Math.abs(height) <= 1.2;
  const unit = explicitUnit === 'pixel'
    ? 'pixel'
    : ((explicitUnit === 'ratio' || normalizedHint || looksRatio) ? 'ratio' : 'pixel');

  const faceNo = Number(source.faceNo || source.faceNumber || source.no || (idx + 1)) || (idx + 1);
  const personId = source.personId !== undefined && source.personId !== null && String(source.personId).trim() !== ''
    ? Number(source.personId)
    : null;

  return {
    faceNo,
    personId: Number.isFinite(personId) ? personId : null,
    left,
    top,
    width,
    height,
    unit,
    imageWidth: toNumberOrNull(source.imageWidth ?? source.image_width ?? box.imageWidth),
    imageHeight: toNumberOrNull(source.imageHeight ?? source.image_height ?? box.imageHeight),
    detectionScore: toNumberOrNull(source.score ?? source.confidence ?? source.detectionScore),
    qualityScore: toNumberOrNull(source.qualityScore ?? source.quality_score),
    embedding: Array.isArray(source.embedding) ? source.embedding : null,
    normalizedEmbedding: Array.isArray(source.normalizedEmbedding)
      ? source.normalizedEmbedding
      : (Array.isArray(source.normalized_embedding) ? source.normalized_embedding : null),
    modelName: source.modelName || source.model || 'mobilefacenet_arcface',
    modelVersion: source.modelVersion || source.model_version || null,
    status: source.status || 'detected',
    faceHash: source.faceHash || source.face_hash || null,
    extra: source.extra && typeof source.extra === 'object' ? source.extra : null,
  };
}

async function upsertFacesForPhoto({ photoId, orgId, incomingFaces, force }) {
  const photo = await getPhotoBasic(photoId, orgId);
  if (!photo) return { notFound: true };

  const incomingProvided = Array.isArray(incomingFaces);
  const hasIncoming = incomingProvided && incomingFaces.length > 0;
  let facesToSave = incomingProvided ? incomingFaces : null;
  let detectApplied = hasIncoming;
  let detectorMeta = null;

  if (!incomingProvided) {
    const cachedFaces = await listFacesByPhotoId(photoId, orgId);
    if (cachedFaces.length > 0 && !force) {
      return {
        notFound: false,
        photo,
        faces: cachedFaces,
        detectApplied: false,
        detectorMeta: null,
        message: 'faces loaded from cache',
      };
    }

    const detected = await detectFacesForPhoto(photo);
    detectApplied = true;
    detectorMeta = detected && detected.meta ? detected.meta : null;
    facesToSave = Array.isArray(detected && detected.faces) ? detected.faces : [];
  }

  if (incomingProvided || detectApplied || force) {
    const conn = await pool.getConnection();
    try {
      await conn.beginTransaction();

      let delSql = 'DELETE FROM photo_faces WHERE photo_id = ?';
      const delParams = [photoId];
      if (orgId === null) {
        delSql += ' AND organization_id IS NULL';
      } else {
        delSql += ' AND organization_id = ?';
        delParams.push(orgId);
      }
      await conn.query(delSql, delParams);

      if (Array.isArray(facesToSave) && facesToSave.length > 0) {
        const normalizedFaces = facesToSave
          .map((f, i) => normalizeIncomingFace(f, i))
          .filter(Boolean)
          .sort((a, b) => a.faceNo - b.faceNo);

        for (let i = 0; i < normalizedFaces.length; i++) {
          const face = normalizedFaces[i];
          const personId = Number.isFinite(face.personId) ? face.personId : null;
          await conn.query(
            `INSERT INTO photo_faces (
              photo_id, project_id, organization_id, person_id, face_no,
              bbox_x, bbox_y, bbox_w, bbox_h, bbox_unit,
              image_width, image_height, detection_score, quality_score,
              embedding, normalized_embedding,
              model_name, model_version, status, face_hash, extra
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            [
              photoId,
              photo.projectId || null,
              orgId,
              personId,
              face.faceNo || (i + 1),
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
              face.modelName || 'mobilefacenet_arcface',
              face.modelVersion || null,
              face.status || 'detected',
              face.faceHash || null,
              face.extra ? JSON.stringify(face.extra) : null,
            ]
          );
        }
      }

      await conn.commit();
    } catch (err) {
      await conn.rollback();
      throw err;
    } finally {
      conn.release();
    }
  }

  const faces = await listFacesByPhotoId(photoId, orgId);
  return {
    notFound: false,
    photo,
    faces,
    detectApplied,
    detectorMeta,
    message: incomingProvided
      ? (hasIncoming ? 'faces saved' : 'faces cleared')
      : (faces.length > 0
        ? `faces detected${detectorMeta && detectorMeta.backend ? ` by ${detectorMeta.backend}` : ''}`
        : `no faces detected${detectorMeta && detectorMeta.backend ? ` by ${detectorMeta.backend}` : ''}`),
  };
}

async function buildFaceProfile({ faceId, personId, orgId }) {
  let faceRow = null;
  let targetPersonId = Number.isFinite(Number(personId)) && Number(personId) > 0 ? Number(personId) : null;

  if (!targetPersonId && Number.isFinite(Number(faceId)) && Number(faceId) > 0) {
    faceRow = await getFaceWithPerson(Number(faceId), orgId);
    if (!faceRow) return null;
    targetPersonId = faceRow.person_id ? Number(faceRow.person_id) : null;
  }

  let person = null;
  let relatedPhotos = [];

  if (targetPersonId) {
    const pParams = [targetPersonId];
    let pSql = `
      SELECT
        id,
        organization_id AS organizationId,
        person_no AS personNo,
        name,
        note,
        cover_face_id AS coverFaceId,
        created_at AS createdAt,
        updated_at AS updatedAt
      FROM face_persons
      WHERE id = ?
    `;
    pSql = appendOrgScope(pSql, 'face_persons', orgId, pParams);
    pSql += ' LIMIT 1';
    const [pRows] = await pool.query(pSql, pParams);

    if (pRows && pRows.length) {
      const p = pRows[0];
      person = {
        id: String(p.id),
        personId: String(p.id),
        personNo: p.personNo,
        name: p.name || null,
        personName: p.name || null,
        note: p.note || null,
        coverFaceId: p.coverFaceId ? String(p.coverFaceId) : null,
        createdAt: p.createdAt,
        updatedAt: p.updatedAt,
      };
      relatedPhotos = await listRelatedPhotosByPersonId(targetPersonId, orgId, null);
    }
  }

  if (!person) {
    if (!faceRow && Number.isFinite(Number(faceId)) && Number(faceId) > 0) {
      faceRow = await getFaceWithPerson(Number(faceId), orgId);
      if (!faceRow) return null;
    }

    const faceNo = faceRow ? (Number(faceRow.face_no) || 1) : 1;
    person = {
      id: null,
      personId: null,
      personNo: null,
      name: null,
      personName: null,
      note: null,
      displayName: `人脸#${faceNo}`,
    };

    if (faceRow) {
      relatedPhotos = [mapRelatedPhoto({
        id: faceRow.photo_id,
        projectId: faceRow.project_id,
        projectName: null,
        url: faceRow.photo_url,
        thumbUrl: faceRow.photo_thumb_url,
        title: faceRow.photo_title,
        description: faceRow.photo_description,
      })];
    }
  }

  const face = faceRow ? mapFaceRow(faceRow) : null;
  const displayName = person && person.name
    ? person.name
    : (face ? `人脸#${face.faceNo}` : (person && person.displayName ? person.displayName : '未标注人物'));

  return {
    face,
    person: {
      ...(person || {}),
      displayName,
      name: person && person.name ? person.name : null,
      personName: person && person.personName ? person.personName : null,
      personId: person && person.personId ? person.personId : null,
    },
    relatedPhotos,
    photos: relatedPhotos,
  };
}

router.get('/faces', requirePermission('photos.view'), async (req, res) => {
  try {
    const orgId = getOrgIdFromReq(req);
    const photoId = req.query.photoId ? Number(req.query.photoId) : null;
    const personId = req.query.personId ? Number(req.query.personId) : null;

    if (photoId && Number.isFinite(photoId) && photoId > 0) {
      const photo = await getPhotoBasic(photoId, orgId);
      if (!photo) return res.status(404).json({ error: 'photo not found' });
      const faces = await listFacesByPhotoId(photoId, orgId);
      return res.json({ photoId, projectId: photo.projectId || null, faces, list: faces, total: faces.length });
    }

    if (personId && Number.isFinite(personId) && personId > 0) {
      const params = [personId];
      let sql = `
        SELECT pf.*, fp.name AS person_name
        FROM photo_faces pf
        LEFT JOIN face_persons fp ON pf.person_id = fp.id
        WHERE pf.person_id = ?
      `;
      sql = appendOrgScope(sql, 'pf', orgId, params);
      sql += ' ORDER BY pf.created_at DESC, pf.id DESC LIMIT 500';
      const [rows] = await pool.query(sql, params);
      const faces = (rows || []).map(mapFaceRow);
      return res.json({ personId: String(personId), faces, list: faces, total: faces.length });
    }

    return res.status(400).json({ error: 'photoId or personId is required' });
  } catch (err) {
    console.error('GET /api/faces error:', err && err.stack ? err.stack : err);
    if (schemaErrorResponse(res, err, 'GET /api/faces')) return;
    return res.status(500).json({ error: 'Internal server error' });
  }
});

router.post('/faces/detect', requirePermission('photos.view'), async (req, res) => {
  try {
    const orgId = getOrgIdFromReq(req);
    const photoId = Number(req.body && req.body.photoId);
    const incomingFaces = Array.isArray(req.body && req.body.faces) ? req.body.faces : null;
    const force = Boolean(req.body && (req.body.force === 1 || req.body.force === true || req.body.force === '1' || req.body.force === 'true'));

    if (!Number.isFinite(photoId) || photoId <= 0) {
      return res.status(400).json({ error: 'photoId is required' });
    }

    const result = await upsertFacesForPhoto({ photoId, orgId, incomingFaces, force });
    if (result.notFound) return res.status(404).json({ error: 'photo not found' });

    return res.json({
      photoId,
      projectId: result.photo.projectId || null,
      faces: result.faces,
      list: result.faces,
      total: result.faces.length,
      detectApplied: result.detectApplied,
      detector: result.detectorMeta || null,
      message: result.message,
    });
  } catch (err) {
    console.error('POST /api/faces/detect error:', err && err.stack ? err.stack : err);
    if (schemaErrorResponse(res, err, 'POST /api/faces/detect')) return;
    if (detectorErrorResponse(res, err, 'POST /api/faces/detect')) return;
    return res.status(500).json({ error: 'Internal server error' });
  }
});

router.post('/faces/label', requirePermission('photos.view'), async (req, res) => {
  try {
    const orgId = getOrgIdFromReq(req);
    const faceId = Number(req.body && req.body.faceId);
    const personIdRaw = req.body && req.body.personId;
    const personNameRaw = req.body && req.body.personName;
    const personName = personNameRaw === undefined || personNameRaw === null ? '' : String(personNameRaw).trim();

    if (!Number.isFinite(faceId) || faceId <= 0) return res.status(400).json({ error: 'faceId is required' });

    const faceRow = await getFaceWithPerson(faceId, orgId);
    if (!faceRow) return res.status(404).json({ error: 'face not found' });

    const conn = await pool.getConnection();
    try {
      await conn.beginTransaction();

      let targetPersonId = null;
      if (personIdRaw !== undefined && personIdRaw !== null && String(personIdRaw).trim() !== '') {
        const pid = Number(personIdRaw);
        if (!Number.isFinite(pid) || pid <= 0) throw new Error('invalid personId');

        const pParams = [pid];
        let pSql = 'SELECT id FROM face_persons WHERE id = ?';
        pSql = appendOrgScope(pSql, 'face_persons', orgId, pParams);
        pSql += ' LIMIT 1';
        const [pRows] = await conn.query(pSql, pParams);
        if (!pRows || pRows.length === 0) throw new Error('person not found');
        targetPersonId = pid;
      } else if (personName) {
        const fParams = [personName];
        let fSql = 'SELECT id FROM face_persons WHERE name = ?';
        fSql = appendOrgScope(fSql, 'face_persons', orgId, fParams);
        fSql += ' LIMIT 1';
        const [found] = await conn.query(fSql, fParams);

        if (found && found.length) {
          targetPersonId = Number(found[0].id);
        } else {
          const seqParams = [];
          let seqSql = 'SELECT COALESCE(MAX(person_no), 0) AS maxNo FROM face_persons WHERE 1=1';
          seqSql = appendOrgScope(seqSql, 'face_persons', orgId, seqParams);
          const [seqRows] = await conn.query(seqSql, seqParams);
          const nextNo = ((seqRows && seqRows[0] && Number(seqRows[0].maxNo)) || 0) + 1;

          const [ins] = await conn.query(
            'INSERT INTO face_persons (organization_id, person_no, name, created_by) VALUES (?, ?, ?, ?)',
            [orgId, nextNo, personName, req.user && req.user.id ? Number(req.user.id) : null]
          );
          targetPersonId = ins.insertId;
        }
      }

      await conn.query('UPDATE photo_faces SET person_id = ?, status = ? WHERE id = ?', [targetPersonId, targetPersonId ? 'confirmed' : 'detected', faceId]);
      await conn.commit();
    } catch (e) {
      await conn.rollback();
      throw e;
    } finally {
      conn.release();
    }

    const profile = await buildFaceProfile({ faceId, personId: null, orgId });
    return res.json(profile);
  } catch (err) {
    console.error('POST /api/faces/label error:', err && err.stack ? err.stack : err);
    if (schemaErrorResponse(res, err, 'POST /api/faces/label')) return;
    return res.status(500).json({ error: err && err.message ? err.message : 'Internal server error' });
  }
});

router.get('/faces/cluster/config', requirePermission('photos.view'), async (req, res) => {
  try {
    const orgId = getOrgIdFromReq(req);
    if (!Number.isFinite(orgId) || orgId <= 0) {
      return res.status(400).json({ error: 'organization_id is required' });
    }

    const cfg = await getOrgFaceClusterConfig(orgId);
    return res.json({
      organizationId: orgId,
      matchThreshold: cfg && Number.isFinite(Number(cfg.matchThreshold)) ? Number(cfg.matchThreshold) : null,
      source: cfg && cfg.source ? cfg.source : 'env',
      updatedAt: cfg && cfg.updatedAt ? cfg.updatedAt : null,
      minThreshold: MIN_THRESHOLD,
      maxThreshold: MAX_THRESHOLD,
    });
  } catch (err) {
    console.error('GET /api/faces/cluster/config error:', err && err.stack ? err.stack : err);
    if (schemaErrorResponse(res, err, 'GET /api/faces/cluster/config')) return;
    if (isMissingConfigTableError(err)) {
      return res.status(503).json({
        error: 'FACE_CONFIG_SCHEMA_NOT_READY',
        message: 'Face cluster config schema is not ready. Please run database migrations first.',
      });
    }
    return res.status(500).json({ error: 'Internal server error' });
  }
});

router.get('/faces/:faceId/person', requirePermission('photos.view'), async (req, res) => {
  try {
    const orgId = getOrgIdFromReq(req);
    const faceId = Number(req.params.faceId);
    if (!Number.isFinite(faceId) || faceId <= 0) return res.status(400).json({ error: 'invalid faceId' });

    const profile = await buildFaceProfile({ faceId, personId: null, orgId });
    if (!profile) return res.status(404).json({ error: 'face not found' });
    return res.json(profile);
  } catch (err) {
    console.error('GET /api/faces/:faceId/person error:', err && err.stack ? err.stack : err);
    if (schemaErrorResponse(res, err, 'GET /api/faces/:faceId/person')) return;
    return res.status(500).json({ error: 'Internal server error' });
  }
});

router.get('/faces/:faceId', requirePermission('photos.view'), async (req, res, next) => {
  try {
    const rawFaceId = req.params.faceId ? String(req.params.faceId).trim().toLowerCase() : '';
    if (rawFaceId === 'person' || rawFaceId === 'profile') return next();

    const orgId = getOrgIdFromReq(req);
    const faceId = Number(req.params.faceId);
    if (!Number.isFinite(faceId) || faceId <= 0) return res.status(400).json({ error: 'invalid faceId' });

    const profile = await buildFaceProfile({ faceId, personId: null, orgId });
    if (!profile) return res.status(404).json({ error: 'face not found' });
    return res.json(profile);
  } catch (err) {
    console.error('GET /api/faces/:faceId error:', err && err.stack ? err.stack : err);
    if (schemaErrorResponse(res, err, 'GET /api/faces/:faceId')) return;
    return res.status(500).json({ error: 'Internal server error' });
  }
});

router.get('/faces/person', requirePermission('photos.view'), async (req, res) => {
  try {
    const orgId = getOrgIdFromReq(req);
    const faceId = req.query.faceId ? Number(req.query.faceId) : null;
    const personId = req.query.personId ? Number(req.query.personId) : null;

    if ((!faceId || !Number.isFinite(faceId)) && (!personId || !Number.isFinite(personId))) {
      return res.status(400).json({ error: 'faceId or personId is required' });
    }

    const profile = await buildFaceProfile({ faceId, personId, orgId });
    if (!profile) return res.status(404).json({ error: 'person/face not found' });
    return res.json(profile);
  } catch (err) {
    console.error('GET /api/faces/person error:', err && err.stack ? err.stack : err);
    if (schemaErrorResponse(res, err, 'GET /api/faces/person')) return;
    return res.status(500).json({ error: 'Internal server error' });
  }
});

router.get('/faces/profile', requirePermission('photos.view'), async (req, res) => {
  try {
    const orgId = getOrgIdFromReq(req);
    const faceId = req.query.faceId ? Number(req.query.faceId) : null;
    const personId = req.query.personId ? Number(req.query.personId) : null;

    if ((!faceId || !Number.isFinite(faceId)) && (!personId || !Number.isFinite(personId))) {
      return res.status(400).json({ error: 'faceId or personId is required' });
    }

    const profile = await buildFaceProfile({ faceId, personId, orgId });
    if (!profile) return res.status(404).json({ error: 'person/face not found' });
    return res.json(profile);
  } catch (err) {
    console.error('GET /api/faces/profile error:', err && err.stack ? err.stack : err);
    if (schemaErrorResponse(res, err, 'GET /api/faces/profile')) return;
    return res.status(500).json({ error: 'Internal server error' });
  }
});

router.get('/persons', requirePermission('photos.view'), async (req, res) => {
  try {
    const orgId = getOrgIdFromReq(req);
    if (!Number.isFinite(orgId) || orgId <= 0) {
      return res.json({ list: [], total: 0, page: 1, pageSize: 20, hasMore: false });
    }

    let page = Number(req.query.page || 1);
    let pageSize = Number(req.query.pageSize || req.query.limit || 20);
    if (!Number.isFinite(page) || page <= 0) page = 1;
    if (!Number.isFinite(pageSize) || pageSize <= 0) pageSize = 20;
    pageSize = Math.max(1, Math.min(100, Math.floor(pageSize)));
    const offset = (Math.floor(page) - 1) * pageSize;

    const q = req.query.q ? String(req.query.q).trim() : '';
    const where = ['fp.organization_id = ?'];
    const params = [orgId];
    if (q) {
      const like = `%${q}%`;
      where.push('(fp.name LIKE ? OR fp.note LIKE ? OR CAST(fp.id AS CHAR) LIKE ? OR CAST(fp.person_no AS CHAR) LIKE ?)');
      params.push(like, like, like, like);
    }

    const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
    const [countRows] = await pool.query(
      `SELECT COUNT(*) AS total FROM face_persons fp ${whereSql}`,
      params
    );
    const total = countRows && countRows[0] ? Number(countRows[0].total) || 0 : 0;

    const [rows] = await pool.query(
      `SELECT
         fp.id,
         fp.person_no AS personNo,
         fp.name,
         fp.note,
         fp.cover_face_id AS coverFaceId,
         fp.created_at AS createdAt,
         fp.updated_at AS updatedAt,
         COUNT(pf.id) AS faceCount
       FROM face_persons fp
       LEFT JOIN photo_faces pf ON pf.person_id = fp.id
       ${whereSql}
       GROUP BY fp.id, fp.person_no, fp.name, fp.note, fp.cover_face_id, fp.created_at, fp.updated_at
       ORDER BY faceCount DESC, fp.updated_at DESC, fp.id DESC
       LIMIT ? OFFSET ?`,
      [...params, pageSize, offset]
    );

    const list = (rows || []).map((r) => ({
      id: String(r.id),
      personId: String(r.id),
      personNo: r.personNo || null,
      name: r.name || null,
      note: r.note || null,
      coverFaceId: r.coverFaceId ? String(r.coverFaceId) : null,
      faceCount: Number(r.faceCount) || 0,
      createdAt: r.createdAt || null,
      updatedAt: r.updatedAt || null,
    }));

    return res.json({
      list,
      persons: list,
      total,
      page: Math.floor(page),
      pageSize,
      hasMore: offset + list.length < total,
      q,
    });
  } catch (err) {
    console.error('GET /api/persons error:', err && err.stack ? err.stack : err);
    if (schemaErrorResponse(res, err, 'GET /api/persons')) return;
    return res.status(500).json({ error: 'Internal server error' });
  }
});

router.post('/persons/merge', requirePermission('faces.merge'), async (req, res) => {
  try {
    const orgId = getOrgIdFromReq(req);
    if (!Number.isFinite(orgId) || orgId <= 0) return res.status(400).json({ error: 'organization_id is required' });

    const body = req.body || {};
    const targetPersonId = Number(body.targetPersonId || body.toPersonId);
    if (!Number.isFinite(targetPersonId) || targetPersonId <= 0) {
      return res.status(400).json({ error: 'targetPersonId is required' });
    }

    const rawSources = body.sourcePersonIds ?? body.fromPersonIds ?? body.sourcePersonId ?? body.fromPersonId;
    let sourcePersonIds = parsePersonIdArray(rawSources)
      .filter((id) => id !== targetPersonId);
    sourcePersonIds = Array.from(new Set(sourcePersonIds));
    if (!sourcePersonIds.length) {
      return res.status(400).json({ error: 'at least one source person id is required' });
    }

    const conn = await pool.getConnection();
    let movedFaces = 0;
    let deletedPersons = 0;
    try {
      await conn.beginTransaction();

      const [targetRows] = await conn.query(
        'SELECT id, name, note, cover_face_id AS coverFaceId FROM face_persons WHERE organization_id = ? AND id = ? LIMIT 1',
        [orgId, targetPersonId]
      );
      if (!targetRows || targetRows.length === 0) {
        throw new Error('target person not found');
      }
      const target = targetRows[0];

      const [sourceRows] = await conn.query(
        'SELECT id, name, note, cover_face_id AS coverFaceId FROM face_persons WHERE organization_id = ? AND id IN (?)',
        [orgId, sourcePersonIds]
      );
      const foundSources = new Set((sourceRows || []).map((x) => Number(x.id)));
      const missing = sourcePersonIds.filter((id) => !foundSources.has(id));
      if (missing.length) {
        throw new Error(`source person not found: ${missing.join(',')}`);
      }

      const [upd] = await conn.query(
        "UPDATE photo_faces SET person_id = ?, status = 'confirmed' WHERE organization_id = ? AND person_id IN (?)",
        [targetPersonId, orgId, sourcePersonIds]
      );
      movedFaces = upd && Number.isFinite(Number(upd.affectedRows)) ? Number(upd.affectedRows) : 0;

      const mergedName = target.name || ((sourceRows || []).map((r) => (r.name ? String(r.name).trim() : '')).find(Boolean) || null);
      const mergedNoteParts = [];
      if (target.note) mergedNoteParts.push(String(target.note).trim());
      mergedNoteParts.push(`merged from: ${sourcePersonIds.join(',')}`);
      const mergedNote = mergedNoteParts.filter(Boolean).join(' | ').slice(0, 2000) || null;

      let coverFaceId = target.coverFaceId ? Number(target.coverFaceId) : null;
      if (!Number.isFinite(coverFaceId) || coverFaceId <= 0) {
        const sourceCover = (sourceRows || []).map((r) => Number(r.coverFaceId)).find((n) => Number.isFinite(n) && n > 0);
        if (sourceCover) coverFaceId = sourceCover;
      }
      if (!Number.isFinite(coverFaceId) || coverFaceId <= 0) {
        const [coverRows] = await conn.query(
          `SELECT id
           FROM photo_faces
           WHERE organization_id = ? AND person_id = ?
           ORDER BY detection_score DESC, id ASC
           LIMIT 1`,
          [orgId, targetPersonId]
        );
        if (coverRows && coverRows.length) {
          coverFaceId = Number(coverRows[0].id);
        } else {
          coverFaceId = null;
        }
      }

      await conn.query(
        'UPDATE face_persons SET name = ?, note = ?, cover_face_id = ? WHERE organization_id = ? AND id = ?',
        [mergedName, mergedNote, coverFaceId, orgId, targetPersonId]
      );

      const [del] = await conn.query(
        'DELETE FROM face_persons WHERE organization_id = ? AND id IN (?)',
        [orgId, sourcePersonIds]
      );
      deletedPersons = del && Number.isFinite(Number(del.affectedRows)) ? Number(del.affectedRows) : 0;

      await conn.commit();
    } catch (err) {
      await conn.rollback();
      throw err;
    } finally {
      conn.release();
    }

    const profile = await buildFaceProfile({ faceId: null, personId: targetPersonId, orgId });
    return res.json({
      ok: true,
      organizationId: orgId,
      targetPersonId: String(targetPersonId),
      sourcePersonIds: sourcePersonIds.map(String),
      movedFaces,
      deletedPersons,
      profile,
    });
  } catch (err) {
    console.error('POST /api/persons/merge error:', err && err.stack ? err.stack : err);
    if (schemaErrorResponse(res, err, 'POST /api/persons/merge')) return;
    if (err && err.message && (String(err.message).includes('person not found'))) {
      return res.status(404).json({ error: err.message });
    }
    return res.status(500).json({ error: err && err.message ? err.message : 'Internal server error' });
  }
});

router.patch('/persons/:personId', requirePermission('faces.label'), async (req, res) => {
  try {
    const orgId = getOrgIdFromReq(req);
    const personId = Number(req.params.personId);
    if (!Number.isFinite(personId) || personId <= 0) return res.status(400).json({ error: 'invalid personId' });

    const personNameRaw = req.body && req.body.personName;
    const personName = personNameRaw === undefined || personNameRaw === null ? '' : String(personNameRaw).trim();
    if (!personName) {
      return res.status(400).json({ error: 'personName is required' });
    }

    const dupParams = [personName, personId];
    let dupSql = 'SELECT id FROM face_persons WHERE name = ? AND id <> ?';
    dupSql = appendOrgScope(dupSql, 'face_persons', orgId, dupParams);
    dupSql += ' LIMIT 1';
    const [dupRows] = await pool.query(dupSql, dupParams);
    if (dupRows && dupRows.length) {
      return res.status(409).json({ error: 'person name already exists' });
    }

    const updParams = [personName, personId];
    let updSql = 'UPDATE face_persons SET name = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?';
    updSql = appendOrgScope(updSql, 'face_persons', orgId, updParams);
    const [upd] = await pool.query(updSql, updParams);
    if (!upd || !Number(upd.affectedRows)) {
      return res.status(404).json({ error: 'person not found' });
    }

    const profile = await buildFaceProfile({ faceId: null, personId, orgId });
    if (!profile) return res.status(404).json({ error: 'person not found' });
    return res.json(profile);
  } catch (err) {
    console.error('PATCH /api/persons/:personId error:', err && err.stack ? err.stack : err);
    if (schemaErrorResponse(res, err, 'PATCH /api/persons/:personId')) return;
    return res.status(500).json({ error: err && err.message ? err.message : 'Internal server error' });
  }
});

router.get('/persons/:personId', requirePermission('photos.view'), async (req, res) => {
  try {
    const orgId = getOrgIdFromReq(req);
    const personId = Number(req.params.personId);
    if (!Number.isFinite(personId) || personId <= 0) return res.status(400).json({ error: 'invalid personId' });

    const profile = await buildFaceProfile({ faceId: null, personId, orgId });
    if (!profile) return res.status(404).json({ error: 'person not found' });
    return res.json(profile);
  } catch (err) {
    console.error('GET /api/persons/:personId error:', err && err.stack ? err.stack : err);
    if (schemaErrorResponse(res, err, 'GET /api/persons/:personId')) return;
    return res.status(500).json({ error: 'Internal server error' });
  }
});

router.get('/persons/:personId/photos', requirePermission('photos.view'), async (req, res) => {
  try {
    const orgId = getOrgIdFromReq(req);
    const personId = Number(req.params.personId);
    const all = String(req.query.all || '').trim().toLowerCase();
    const useAll = all === '1' || all === 'true' || all === 'yes' || all === 'y';
    const limit = useAll ? null : (req.query.limit ? Number(req.query.limit) : 200);
    if (!Number.isFinite(personId) || personId <= 0) return res.status(400).json({ error: 'invalid personId' });

    const photos = await listRelatedPhotosByPersonId(personId, orgId, limit);
    return res.json({ personId: String(personId), photos, list: photos, total: photos.length });
  } catch (err) {
    console.error('GET /api/persons/:personId/photos error:', err && err.stack ? err.stack : err);
    if (schemaErrorResponse(res, err, 'GET /api/persons/:personId/photos')) return;
    return res.status(500).json({ error: 'Internal server error' });
  }
});

// Aliases for current frontend detection calls.
router.get('/photos/:photoId/faces', requirePermission('photos.view'), async (req, res) => {
  try {
    const orgId = getOrgIdFromReq(req);
    const photoId = Number(req.params.photoId);
    if (!Number.isFinite(photoId) || photoId <= 0) return res.status(400).json({ error: 'invalid photoId' });

    if (String(req.query.detect || '') === '1' || String(req.query.detect || '').toLowerCase() === 'true') {
      const result = await upsertFacesForPhoto({ photoId, orgId, incomingFaces: null, force: false });
      if (result.notFound) return res.status(404).json({ error: 'photo not found' });
      return res.json({
        photoId,
        projectId: result.photo.projectId || null,
        faces: result.faces,
        list: result.faces,
        total: result.faces.length,
        detectApplied: result.detectApplied,
        detector: result.detectorMeta || null,
        message: result.message,
      });
    }

    const photo = await getPhotoBasic(photoId, orgId);
    if (!photo) return res.status(404).json({ error: 'photo not found' });

    const faces = await listFacesByPhotoId(photoId, orgId);
    return res.json({ photoId, projectId: photo.projectId || null, faces, list: faces, total: faces.length });
  } catch (err) {
    console.error('GET /api/photos/:photoId/faces error:', err && err.stack ? err.stack : err);
    if (schemaErrorResponse(res, err, 'GET /api/photos/:photoId/faces')) return;
    if (detectorErrorResponse(res, err, 'GET /api/photos/:photoId/faces')) return;
    return res.status(500).json({ error: 'Internal server error' });
  }
});

router.post('/photos/:photoId/faces/detect', requirePermission('photos.view'), async (req, res) => {
  try {
    const orgId = getOrgIdFromReq(req);
    const photoId = Number(req.params.photoId);
    const incomingFaces = Array.isArray(req.body && req.body.faces) ? req.body.faces : null;
    const force = Boolean(req.body && (req.body.force === 1 || req.body.force === true || req.body.force === '1' || req.body.force === 'true'));

    if (!Number.isFinite(photoId) || photoId <= 0) {
      return res.status(400).json({ error: 'photoId is required' });
    }

    const result = await upsertFacesForPhoto({ photoId, orgId, incomingFaces, force });
    if (result.notFound) return res.status(404).json({ error: 'photo not found' });

    return res.json({
      photoId,
      projectId: result.photo.projectId || null,
      faces: result.faces,
      list: result.faces,
      total: result.faces.length,
      detectApplied: result.detectApplied,
      detector: result.detectorMeta || null,
      message: result.message,
    });
  } catch (err) {
    console.error('POST /api/photos/:photoId/faces/detect error:', err && err.stack ? err.stack : err);
    if (schemaErrorResponse(res, err, 'POST /api/photos/:photoId/faces/detect')) return;
    if (detectorErrorResponse(res, err, 'POST /api/photos/:photoId/faces/detect')) return;
    return res.status(500).json({ error: 'Internal server error' });
  }
});

router.post('/photos/:photoId/faces', requirePermission('photos.view'), async (req, res) => {
  try {
    const orgId = getOrgIdFromReq(req);
    const photoId = Number(req.params.photoId);
    const incomingFaces = Array.isArray(req.body && req.body.faces) ? req.body.faces : null;
    const force = Boolean(req.body && (req.body.force === 1 || req.body.force === true || req.body.force === '1' || req.body.force === 'true'));

    if (!Number.isFinite(photoId) || photoId <= 0) {
      return res.status(400).json({ error: 'photoId is required' });
    }

    const result = await upsertFacesForPhoto({ photoId, orgId, incomingFaces, force });
    if (result.notFound) return res.status(404).json({ error: 'photo not found' });

    return res.json({
      photoId,
      projectId: result.photo.projectId || null,
      faces: result.faces,
      list: result.faces,
      total: result.faces.length,
      detectApplied: result.detectApplied,
      detector: result.detectorMeta || null,
      message: result.message,
    });
  } catch (err) {
    console.error('POST /api/photos/:photoId/faces error:', err && err.stack ? err.stack : err);
    if (schemaErrorResponse(res, err, 'POST /api/photos/:photoId/faces')) return;
    if (detectorErrorResponse(res, err, 'POST /api/photos/:photoId/faces')) return;
    return res.status(500).json({ error: 'Internal server error' });
  }
});

module.exports = router;
