const express = require('express');
const router = express.Router();
const { pool } = require('../db');
const { buildMediaUrl } = require('../lib/media_access');
const { requirePermission } = require('../lib/permissions');
const {
  resolveWorkspace, requireProjectAccess, requirePhotoAccess, sendWorkspaceError,
} = require('../lib/workspace_access');
const { detectFacesForPhoto } = require('../lib/face_detector');
const { getFaceAvatarDataUrl } = require('../lib/face_avatar');
const { CURRENT_FACE_REVISION, usableFaceSql } = require('../lib/face_result_policy');
const {
  hasProtectedFaces, recordIdentityFeedback, recordSeparation, remapMergedFeedback,
} = require('../lib/face_feedback');
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

router.use((req, res, next) => {
  if (!/^\/(?:faces(?:\/|$)|persons(?:\/|$)|photos\/\d+\/faces(?:\/|$))/.test(req.path)) return next();
  if (req.path === '/faces/find-me' || req.path === '/faces/find-me/share') return next();
  return requirePermission('photos.view')(req, res, async () => {
    try {
      const workspace = await resolveWorkspace(req);
      if (!workspace.enabled) return next();
      const [grants] = await pool.query(
        `SELECT college_wide FROM face_search_grants
         WHERE organization_id = ? AND user_id = ? LIMIT 1`,
        [workspace.orgId, workspace.userId]
      );
      if (!grants.length || !grants[0].college_wide) {
        return res.status(403).json({ error: 'FACE_SEARCH_GRANT_REQUIRED' });
      }
      const photoId = Number(req.params?.photoId || req.query?.photoId || req.body?.photoId);
      if (Number.isSafeInteger(photoId) && photoId > 0) await requirePhotoAccess(req, photoId, 'read');
      await pool.query(
        `INSERT INTO organization_access_audit
           (organization_id, unit_id, user_id, action, resource_type, resource_id)
         VALUES (?, ?, ?, 'face.search', 'photo', ?)`,
        [workspace.orgId, workspace.unitId, workspace.userId, Number.isSafeInteger(photoId) ? photoId : null]
      );
      next();
    } catch (err) {
      if (!sendWorkspaceError(res, err)) next(err);
    }
  });
});

function appendOrgScope(sqlBase, alias, orgId, params) {
  if (orgId === null) {
    return `${sqlBase} AND ${alias}.organization_id IS NULL`;
  }
  params.push(orgId);
  return `${sqlBase} AND ${alias}.organization_id = ?`;
}

function appendVisiblePhotoScope(sql, workspace, params) {
  if (!workspace?.enabled) return sql;
  if (!workspace.unitId) return `${sql} AND COALESCE(pr.unit_id, p.unit_id) IS NULL`;
  if (!workspace.collegeAdmin) {
    sql += ' AND (pr.restricted_to_user_id IS NULL OR pr.restricted_to_user_id = ?)';
    params.push(workspace.userId);
  }
  params.push(workspace.unitId, workspace.orgId, workspace.unitId, workspace.userId);
  return `${sql} AND (
    COALESCE(pr.unit_id, p.unit_id) IS NULL
    OR COALESCE(pr.unit_id, p.unit_id) = ?
    OR EXISTS (
      SELECT 1 FROM internal_shares s
      WHERE s.organization_id = ? AND s.target_unit_id = ?
        AND (s.target_user_id IS NULL OR s.target_user_id = ?)
        AND s.mode IN ('read', 'collaborate') AND s.revoked_at IS NULL
        AND (s.expires_at IS NULL OR s.expires_at > NOW())
        AND ((s.share_type = 'album' AND s.project_id = p.project_id)
          OR (s.share_type = 'collection' AND EXISTS (
            SELECT 1 FROM internal_share_items si
            WHERE si.share_id = s.id AND si.photo_id = p.id)))
    )
  )`;
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

function mapRelatedPhoto(row, userId = null) {
  return {
    id: String(row.id),
    photoId: String(row.id),
    projectId: row.projectId || null,
    projectName: row.projectName || null,
    url: row.url ? buildMediaUrl(row.url, { userId, photoId: row.id }) : null,
    thumbUrl: row.thumbUrl ? buildMediaUrl(row.thumbUrl, { userId, photoId: row.id })
      : (row.url ? buildMediaUrl(row.url, { userId, photoId: row.id }) : null),
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
      public_download_url AS publicDownloadUrl,
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
    WHERE pf.photo_id = ? AND ${usableFaceSql('pf')}
  `;
  sql = appendOrgScope(sql, 'pf', orgId, params);
  sql += ' ORDER BY pf.face_no ASC, pf.id ASC';
  const [rows] = await pool.query(sql, params);
  return (rows || []).map(mapFaceRow);
}

async function getFaceWithPerson(faceId, orgId, workspace = null) {
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
    JOIN photos p ON p.id = pf.photo_id
    LEFT JOIN projects pr ON pr.id = p.project_id
    WHERE pf.id = ? AND ${usableFaceSql('pf')}
  `;
  sql = appendOrgScope(sql, 'pf', orgId, params);
  sql = appendVisiblePhotoScope(sql, workspace, params);
  sql += ' LIMIT 1';
  const [rows] = await pool.query(sql, params);
  return rows && rows.length ? rows[0] : null;
}

function relatedPhotoScope(personId, orgId, workspace) {
  const params = [personId];
  let sql = `FROM photo_faces pf
    JOIN photos p ON pf.photo_id = p.id
    LEFT JOIN projects pr ON p.project_id = pr.id
    WHERE pf.person_id = ? AND ${usableFaceSql('pf')}`;
  sql = appendOrgScope(sql, 'pf', orgId, params);
  sql = appendVisiblePhotoScope(sql, workspace, params);
  return { sql, params };
}

async function listRelatedPhotosByPersonId(personId, orgId, limit = null, userId = null, workspace = null, offset = null) {
  const hasLimit = Number.isFinite(Number(limit)) && Number(limit) > 0;
  const safeLimit = hasLimit ? Math.max(1, Math.min(5000, Number(limit))) : null;
  const scope = relatedPhotoScope(personId, orgId, workspace);
  const params = [...scope.params];
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
    ${scope.sql}
  `;
  sql += ' ORDER BY p.created_at DESC, p.id DESC';
  if (safeLimit) {
    sql += ' LIMIT ?';
    params.push(safeLimit);
    if (offset !== null) { sql += ' OFFSET ?'; params.push(offset); }
  }
  const [rows] = await pool.query(sql, params);
  return (rows || []).map((row) => mapRelatedPhoto(row, userId));
}

function profileReadOptions(req) {
  const compact = String(req.query.compact || '') === '1';
  const page = Math.max(1, Math.min(1000000, Math.floor(Number(req.query.page) || 1)));
  const pageSize = Math.max(1, Math.min(72, Math.floor(Number(req.query.pageSize) || 24)));
  return { compact, page, pageSize, includeAvatar: compact ? String(req.query.includeAvatar || '') === '1' : String(req.query.includeAvatar || '') !== '0' };
}

async function relatedPhotosPage(personId, orgId, userId, workspace, page, pageSize) {
  const scope = relatedPhotoScope(personId, orgId, workspace);
  const [photos, [counts]] = await Promise.all([
    listRelatedPhotosByPersonId(personId, orgId, pageSize, userId, workspace, (page - 1) * pageSize),
    pool.query(`SELECT COUNT(DISTINCT p.id) AS total ${scope.sql}`, scope.params),
  ]);
  const total = Number(counts[0]?.total) || 0;
  return { photos, total, page, pageSize, hasMore: page * pageSize < total };
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
  if (await hasProtectedFaces(pool, photoId, orgId)) {
    return { notFound: false, photo, faces: await listFacesByPhotoId(photoId, orgId),
      detectApplied: false, detectorMeta: null, message: '已保留人工纠正的人脸，请通过标注或拆分修改归属' };
  }

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
      if (await hasProtectedFaces(conn, photoId, orgId)) {
        throw Object.assign(new Error('已保留人工纠正的人脸，请刷新后重试'), { status: 409 });
      }

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
              JSON.stringify({ ...face.extra, recognitionRevision: CURRENT_FACE_REVISION }),
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

async function buildFaceProfile({ faceId, personId, orgId, userId = null, workspace = null, compact = false, includeAvatar = true, page = 1, pageSize = 24 }) {
  let faceRow = null;
  let targetPersonId = Number.isFinite(Number(personId)) && Number(personId) > 0 ? Number(personId) : null;

  if (!targetPersonId && Number.isFinite(Number(faceId)) && Number(faceId) > 0) {
    faceRow = await getFaceWithPerson(Number(faceId), orgId, workspace);
    if (!faceRow) return null;
    targetPersonId = faceRow.person_id ? Number(faceRow.person_id) : null;
  }

  let person = null;
  let relatedPhotos = [];
  let photoPage = null;

  if (targetPersonId) {
    const pParams = [targetPersonId];
    let pSql = `
      SELECT
        id,
        organization_id AS organizationId,
        person_no AS personNo,
        name,
        note,
        CASE WHEN EXISTS (SELECT 1 FROM photo_faces cover
          WHERE cover.id = face_persons.cover_face_id AND cover.person_id = face_persons.id
            AND ${usableFaceSql('cover')}) THEN cover_face_id ELSE NULL END AS coverFaceId,
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
      if (compact) {
        photoPage = await relatedPhotosPage(targetPersonId, orgId, userId, workspace, page, pageSize);
        relatedPhotos = photoPage.photos;
      } else {
        relatedPhotos = await listRelatedPhotosByPersonId(targetPersonId, orgId, null, userId, workspace);
      }
    }
  }

  if (!person) {
    if (!faceRow && Number.isFinite(Number(faceId)) && Number(faceId) > 0) {
      faceRow = await getFaceWithPerson(Number(faceId), orgId, workspace);
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
      }, userId)];
    }
  }

  const face = faceRow ? mapFaceRow(faceRow) : null;
  if (compact && face) { delete face.embedding; delete face.normalizedEmbedding; }
  if (compact && !photoPage) {
    const total = relatedPhotos.length;
    if (page > 1) relatedPhotos = [];
    photoPage = { total, page, pageSize, hasMore: false };
  }
  const displayName = person && person.name
    ? person.name
    : (face ? `人脸#${face.faceNo}` : (person && person.displayName ? person.displayName : '未标注人物'));

  // 人物主图：服务端按 bbox 裁好内联返回，前端直接当头像用（不再下原图 + CSS 缩放）。
  // 优先用人物封面脸；没有则用当前这张脸。失败返回 null，前端回退旧渲染路径。
  let avatarFaceRow = faceRow;
  const coverId = person && person.coverFaceId ? Number(person.coverFaceId) : null;
  if (coverId && (!faceRow || Number(faceRow.id) !== coverId)) {
    const coverRow = await getFaceWithPerson(coverId, orgId, workspace);
    if (coverRow) avatarFaceRow = coverRow;
  }
  const avatarDataUrl = includeAvatar && avatarFaceRow ? await getFaceAvatarDataUrl(avatarFaceRow) : null;

  return {
    face,
    person: {
      ...(person || {}),
      displayName,
      name: person && person.name ? person.name : null,
      personName: person && person.personName ? person.personName : null,
      personId: person && person.personId ? person.personId : null,
    },
    avatarDataUrl,
    avatarFaceId: avatarFaceRow ? String(avatarFaceRow.id) : null,
    relatedPhotos,
    ...(compact ? { total: photoPage.total, page, pageSize, hasMore: photoPage.hasMore } : { photos: relatedPhotos }),
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
        JOIN photos p ON p.id = pf.photo_id
        LEFT JOIN projects pr ON pr.id = p.project_id
        WHERE pf.person_id = ? AND ${usableFaceSql('pf')}
      `;
      sql = appendOrgScope(sql, 'pf', orgId, params);
      sql = appendVisiblePhotoScope(sql, req.workspace, params);
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
    if (err.status === 409) return res.status(409).json({ error: err.message });
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

    const faceRow = await getFaceWithPerson(faceId, orgId, req.workspace);
    if (!faceRow) return res.status(404).json({ error: 'face not found' });

    const conn = await pool.getConnection();
    try {
      await conn.beginTransaction();

      const [lockedFaces] = await conn.query(
        `SELECT * FROM photo_faces WHERE id = ? AND organization_id <=> ? AND ${usableFaceSql()} FOR UPDATE`, [faceId, orgId]
      );
      if (!lockedFaces.length) throw new Error('face not found');
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
        fSql += ` ORDER BY EXISTS (SELECT 1 FROM photo_faces named
          WHERE named.person_id = face_persons.id AND ${usableFaceSql('named')}) DESC,
          updated_at DESC, id DESC LIMIT 1`;
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
      await recordIdentityFeedback(conn, { orgId, userId: req.user.id, action: 'label',
        assignments: [{ face: lockedFaces[0], personId: targetPersonId, kind: 'explicit' }] });
      await conn.commit();
    } catch (e) {
      await conn.rollback();
      throw e;
    } finally {
      conn.release();
    }

    const profile = await buildFaceProfile({ faceId, personId: null, orgId, userId: req.user.id, workspace: req.workspace });
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

router.get('/faces/:faceId/avatar', requirePermission('photos.view'), async (req, res) => {
  try {
    const faceId = Number(req.params.faceId);
    if (!Number.isSafeInteger(faceId) || faceId <= 0) return res.status(400).json({ error: 'invalid faceId' });
    const row = await getFaceWithPerson(faceId, getOrgIdFromReq(req), req.workspace);
    if (!row) return res.status(404).json({ error: 'face not found' });
    res.set('Cache-Control', 'private, no-store');
    return res.json({ faceId: String(faceId), avatarDataUrl: await getFaceAvatarDataUrl(row) });
  } catch (err) {
    if (schemaErrorResponse(res, err, 'GET /api/faces/:faceId/avatar')) return;
    return res.status(500).json({ error: 'Internal server error' });
  }
});

router.get('/faces/:faceId/person', requirePermission('photos.view'), async (req, res) => {
  try {
    const orgId = getOrgIdFromReq(req);
    const faceId = Number(req.params.faceId);
    if (!Number.isFinite(faceId) || faceId <= 0) return res.status(400).json({ error: 'invalid faceId' });

    const profile = await buildFaceProfile({ faceId, personId: null, orgId, userId: req.user.id, workspace: req.workspace, ...profileReadOptions(req) });
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

    const profile = await buildFaceProfile({ faceId, personId: null, orgId, userId: req.user.id, workspace: req.workspace, ...profileReadOptions(req) });
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

    const profile = await buildFaceProfile({ faceId, personId, orgId, userId: req.user.id, workspace: req.workspace, ...profileReadOptions(req) });
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

    const profile = await buildFaceProfile({ faceId, personId, orgId, userId: req.user.id, workspace: req.workspace, ...profileReadOptions(req) });
    if (!profile) return res.status(404).json({ error: 'person/face not found' });
    return res.json(profile);
  } catch (err) {
    console.error('GET /api/faces/profile error:', err && err.stack ? err.stack : err);
    if (schemaErrorResponse(res, err, 'GET /api/faces/profile')) return;
    return res.status(500).json({ error: 'Internal server error' });
  }
});

router.get('/persons', requirePermission('faces.merge'), async (req, res) => {
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
    const where = ['fp.organization_id = ?', `EXISTS (SELECT 1 FROM photo_faces active
      WHERE active.person_id = fp.id AND ${usableFaceSql('active')})`];
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
         CASE WHEN EXISTS (SELECT 1 FROM photo_faces cover
           WHERE cover.id = fp.cover_face_id AND cover.person_id = fp.id AND ${usableFaceSql('cover')})
           THEN fp.cover_face_id ELSE NULL END AS coverFaceId,
         fp.created_at AS createdAt,
         fp.updated_at AS updatedAt,
         COUNT(pf.id) AS faceCount
       FROM face_persons fp
       LEFT JOIN photo_faces pf ON pf.person_id = fp.id AND ${usableFaceSql('pf')}
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
        'SELECT id, name, note, cover_face_id AS coverFaceId FROM face_persons WHERE organization_id = ? AND id = ? LIMIT 1 FOR UPDATE',
        [orgId, targetPersonId]
      );
      if (!targetRows || targetRows.length === 0) {
        throw new Error('target person not found');
      }
      const target = targetRows[0];

      const [sourceRows] = await conn.query(
        'SELECT id, name, note, cover_face_id AS coverFaceId FROM face_persons WHERE organization_id = ? AND id IN (?) FOR UPDATE',
        [orgId, sourcePersonIds]
      );
      const foundSources = new Set((sourceRows || []).map((x) => Number(x.id)));
      const missing = sourcePersonIds.filter((id) => !foundSources.has(id));
      if (missing.length) {
        throw new Error(`source person not found: ${missing.join(',')}`);
      }

      const [feedbackFaces] = await conn.query(
        `SELECT * FROM photo_faces WHERE organization_id = ? AND person_id IN (?) AND ${usableFaceSql()} ORDER BY id FOR UPDATE`,
        [orgId, [targetPersonId, ...sourcePersonIds]]
      );
      const referenceIds = new Set(parseFaceIdArray(body.referenceFaceIds || []));
      const ownedIds = new Set(feedbackFaces.map((face) => Number(face.id)));
      if ([...referenceIds].some((id) => !ownedIds.has(id))) {
        throw Object.assign(new Error('reference face does not belong to merged persons'), { status: 400 });
      }

      const [upd] = await conn.query(
        `UPDATE photo_faces SET person_id = ?, status = 'confirmed' WHERE organization_id = ? AND person_id IN (?) AND ${usableFaceSql()}`,
        [targetPersonId, orgId, sourcePersonIds]
      );
      movedFaces = upd && Number.isFinite(Number(upd.affectedRows)) ? Number(upd.affectedRows) : 0;
      await remapMergedFeedback(conn, orgId, targetPersonId, sourcePersonIds);
      await recordIdentityFeedback(conn, { orgId, userId: req.user.id, action: 'merge',
        details: { targetPersonId, sourcePersonIds },
        assignments: feedbackFaces.map((face) => ({ face, personId: targetPersonId,
          kind: referenceIds.has(Number(face.id)) ? 'explicit' : 'group' })),
      });

      const mergedName = target.name || ((sourceRows || []).map((r) => (r.name ? String(r.name).trim() : '')).find(Boolean) || null);
      const mergedNoteParts = [];
      if (target.note) mergedNoteParts.push(String(target.note).trim());
      mergedNoteParts.push(`merged from: ${sourcePersonIds.join(',')}`);
      const mergedNote = mergedNoteParts.filter(Boolean).join(' | ').slice(0, 2000) || null;

      let coverFaceId = ownedIds.has(Number(target.coverFaceId)) ? Number(target.coverFaceId) : null;
      if (!Number.isFinite(coverFaceId) || coverFaceId <= 0) {
        const sourceCover = (sourceRows || []).map((r) => Number(r.coverFaceId)).find((n) => ownedIds.has(n));
        if (sourceCover) coverFaceId = sourceCover;
      }
      if (!Number.isFinite(coverFaceId) || coverFaceId <= 0) {
        const [coverRows] = await conn.query(
          `SELECT id
           FROM photo_faces
           WHERE organization_id = ? AND person_id = ? AND ${usableFaceSql()}
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

    const profile = await buildFaceProfile({ faceId: null, personId: targetPersonId, orgId, userId: req.user.id, workspace: req.workspace });
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
    if (err.status === 400) return res.status(400).json({ error: err.message });
    if (schemaErrorResponse(res, err, 'POST /api/persons/merge')) return;
    if (err && err.message && (String(err.message).includes('person not found'))) {
      return res.status(404).json({ error: err.message });
    }
    return res.status(500).json({ error: err && err.message ? err.message : 'Internal server error' });
  }
});

// ---------------------------------------------------------------------------
// 系统认错人了？——人物拆分。两个人被聚簇误判成同一个 face_persons 时，
// 用户标出"不是这个人"的种子脸，后端用 embedding 把该人物名下所有脸
// 重新二分：贴近种子的搬去新人物，其余留下。preview 只算不写，split 落库。
// ---------------------------------------------------------------------------
const { splitFacesBySeeds } = require('../lib/face_person_split');

const SPLIT_GRID_AVATAR_SIZE = 112;      // 选择器/预览网格用小头像，省流量
const SPLIT_MAX_PREVIEW_AVATARS = 240;   // 预览最多现场裁多少张头像，超出的回退照片缩略图
const SPLIT_AVATAR_CONCURRENCY = 6;

function parseFaceIdArray(input) {
  const arr = Array.isArray(input) ? input : [input];
  return Array.from(new Set(
    arr.map((x) => Number(x)).filter((x) => Number.isFinite(x) && x > 0).map((x) => Math.floor(x))
  ));
}

async function mapWithConcurrency(items, limit, fn) {
  const out = new Array(items.length);
  let idx = 0;
  const workers = new Array(Math.max(1, Math.min(limit, items.length))).fill(0).map(async () => {
    while (idx < items.length) {
      const i = idx++;
      try {
        out[i] = await fn(items[i], i);
      } catch (e) {
        out[i] = null;
      }
    }
  });
  await Promise.all(workers);
  return out;
}

// 网格头像优先用缩略图裁（省下载），缩略图缺失才回退原图
async function splitGridAvatar(row) {
  if (!row) return null;
  const preferThumb = { ...row, photo_url: row.photo_thumb_url || row.photo_url };
  return getFaceAvatarDataUrl(preferThumb, SPLIT_GRID_AVATAR_SIZE);
}

async function loadPersonFacesWithPhoto(personId, orgId, workspace = null) {
  const params = [personId];
  let sql = `
    SELECT
      pf.*,
      p.title AS photo_title,
      p.description AS photo_description,
      p.project_id AS photo_project_id,
      pr.name AS project_name,
      p.url AS photo_url,
      p.thumb_url AS photo_thumb_url
    FROM photo_faces pf
    JOIN photos p ON p.id = pf.photo_id
    LEFT JOIN projects pr ON pr.id = p.project_id
    WHERE pf.person_id = ? AND ${usableFaceSql('pf')}
  `;
  sql = appendOrgScope(sql, 'pf', orgId, params);
  sql = appendVisiblePhotoScope(sql, workspace, params);
  sql += ' ORDER BY pf.created_at DESC, pf.id DESC LIMIT 5000';
  const [rows] = await pool.query(sql, params);
  return rows || [];
}

function toSplitFaceItem(row, score, userId = null) {
  const item = {
    faceId: String(row.id),
    photoId: row.photo_id,
    photoTitle: row.photo_title || row.photo_description || null,
    projectId: row.photo_project_id || row.project_id || null,
    projectName: row.project_name || null,
    thumbUrl: row.photo_thumb_url ? buildMediaUrl(row.photo_thumb_url, { userId, photoId: row.photo_id })
      : (row.photo_url ? buildMediaUrl(row.photo_url, { userId, photoId: row.photo_id }) : null),
    status: row.status || 'detected',
    createdAt: row.created_at || null,
    avatarDataUrl: null,
  };
  if (score) {
    item.scoreSeed = Number(Number(score.scoreSeed).toFixed(4));
    item.scoreKeep = Number(Number(score.scoreKeep).toFixed(4));
    item.isSeed = Boolean(score.isSeed);
    item.hasEmbedding = Boolean(score.hasEmbedding);
  }
  return item;
}

async function attachAvatars(items, rowsById, budget) {
  let remaining = Math.max(0, Number(budget) || 0);
  const need = items.filter((it) => rowsById.has(Number(it.faceId)) && remaining-- > 0);
  const avatars = await mapWithConcurrency(need, SPLIT_AVATAR_CONCURRENCY, async (it) => {
    const av = await splitGridAvatar(rowsById.get(Number(it.faceId)));
    it.avatarDataUrl = av;
    return av;
  });
  return avatars.filter(Boolean).length;
}

async function getPersonRow(connOrPool, personId, orgId, lock = false) {
  const params = [personId];
  let sql = 'SELECT id, person_no, name, note, cover_face_id FROM face_persons WHERE id = ?';
  sql = appendOrgScope(sql, 'face_persons', orgId, params);
  sql += ' LIMIT 1';
  if (lock) sql += ' FOR UPDATE';
  const [rows] = await connOrPool.query(sql, params);
  return rows && rows.length ? rows[0] : null;
}

// 拆分选择器：该人物名下所有脸（分页 + 服务端裁好的头像），用于人工勾种子
router.get('/persons/:personId/faces', requirePermission('faces.merge'), async (req, res) => {
  try {
    const orgId = getOrgIdFromReq(req);
    const personId = Number(req.params.personId);
    if (!Number.isFinite(personId) || personId <= 0) return res.status(400).json({ error: 'invalid personId' });

    let page = Number(req.query.page || 1);
    let pageSize = Number(req.query.pageSize || 48);
    if (!Number.isFinite(page) || page <= 0) page = 1;
    if (!Number.isFinite(pageSize) || pageSize <= 0) pageSize = 48;
    pageSize = Math.max(12, Math.min(120, Math.floor(pageSize)));
    const offset = (Math.floor(page) - 1) * pageSize;

    const rows = await loadPersonFacesWithPhoto(personId, orgId, req.workspace);
    const total = rows.length;
    const pageRows = rows.slice(offset, offset + pageSize);
    const items = pageRows.map((row) => toSplitFaceItem(row, null, req.user.id));
    await attachAvatars(items, new Map(pageRows.map((r) => [Number(r.id), r])), pageSize);

    return res.json({
      personId: String(personId),
      page: Math.floor(page),
      pageSize,
      total,
      hasMore: offset + items.length < total,
      faces: items,
      list: items,
    });
  } catch (err) {
    console.error('GET /api/persons/:personId/faces error:', err && err.stack ? err.stack : err);
    if (schemaErrorResponse(res, err, 'GET /api/persons/:personId/faces')) return;
    return res.status(500).json({ error: 'Internal server error' });
  }
});

// 拆分预览（不落库）：种子脸 vs 其余脸各建 profile，逐脸判"跟谁走"
router.post('/persons/:personId/split-preview', requirePermission('faces.merge'), async (req, res) => {
  try {
    const orgId = getOrgIdFromReq(req);
    const personId = Number(req.params.personId);
    if (!Number.isFinite(personId) || personId <= 0) return res.status(400).json({ error: 'invalid personId' });

    const person = await getPersonRow(pool, personId, orgId);
    if (!person) return res.status(404).json({ error: 'person not found' });

    const seedFaceIds = parseFaceIdArray(req.body && req.body.seedFaceIds);
    if (!seedFaceIds.length) return res.status(400).json({ error: 'seedFaceIds is required' });

    const rows = await loadPersonFacesWithPhoto(personId, orgId, req.workspace);
    if (rows.length < 2) return res.status(400).json({ error: '该人物脸太少，无法拆分' });

    const ownedIds = new Set(rows.map((r) => Number(r.id)));
    const foreign = seedFaceIds.filter((id) => !ownedIds.has(id));
    if (foreign.length) {
      return res.status(400).json({ error: `these faces do not belong to person ${personId}: ${foreign.join(',')}` });
    }
    if (seedFaceIds.length >= rows.length) {
      return res.status(400).json({ error: '不能把该人物所有脸都标为认错，至少留一张' });
    }

    const result = splitFacesBySeeds(rows, seedFaceIds);
    const moveItems = result.move.map((r) => toSplitFaceItem(r, result.scoreOf.get(Number(r.id)), req.user.id));
    const keepItems = result.keep.map((r) => toSplitFaceItem(r, result.scoreOf.get(Number(r.id)), req.user.id));
    const undecidedItems = result.undecided.map((r) => toSplitFaceItem(r, result.scoreOf.get(Number(r.id)), req.user.id));

    // 头像预算：优先种子+搬走组（用户重点核对），其次判不了的，最后保留组
    await attachAvatars(
      [...moveItems, ...undecidedItems, ...keepItems],
      result.rowsById,
      SPLIT_MAX_PREVIEW_AVATARS
    );

    return res.json({
      ok: true,
      personId: String(personId),
      margin: result.margin,
      stats: {
        totalFaces: rows.length,
        seedCount: result.seeds.length,
        moveCount: moveItems.length,
        keepCount: keepItems.length,
        undecidedCount: undecidedItems.length,
      },
      moveFaces: moveItems,
      keepFaces: keepItems,
      undecidedFaces: undecidedItems,
    });
  } catch (err) {
    console.error('POST /api/persons/:personId/split-preview error:', err && err.stack ? err.stack : err);
    if (schemaErrorResponse(res, err, 'POST /api/persons/:personId/split-preview')) return;
    return res.status(500).json({ error: err && err.message ? err.message : 'Internal server error' });
  }
});

// 执行拆分：moveFaceIds 搬去新建人物，原人物保留身份/姓名
router.post('/persons/:personId/split', requirePermission('faces.merge'), async (req, res) => {
  try {
    const orgId = getOrgIdFromReq(req);
    if (!Number.isFinite(orgId) || orgId <= 0) return res.status(400).json({ error: 'organization_id is required' });
    const personId = Number(req.params.personId);
    if (!Number.isFinite(personId) || personId <= 0) return res.status(400).json({ error: 'invalid personId' });

    const body = req.body || {};
    const moveFaceIds = parseFaceIdArray(body.moveFaceIds);
    if (!moveFaceIds.length) return res.status(400).json({ error: 'moveFaceIds is required' });
    const seedFaceIds = parseFaceIdArray(body.seedFaceIds || []);
    if (seedFaceIds.some((id) => !moveFaceIds.includes(id))) {
      return res.status(400).json({ error: 'seed faces must be included in moved faces' });
    }
    const newPersonName = body.newPersonName !== undefined && body.newPersonName !== null
      ? String(body.newPersonName).trim().slice(0, 80)
      : '';
    if (newPersonName) {
      const dupParams = [newPersonName, personId];
      let dupSql = `SELECT id FROM face_persons WHERE name = ? AND id <> ?
        AND EXISTS (SELECT 1 FROM photo_faces active
          WHERE active.person_id = face_persons.id AND ${usableFaceSql('active')})`;
      dupSql = appendOrgScope(dupSql, 'face_persons', orgId, dupParams);
      dupSql += ' LIMIT 1';
      const [dupRows] = await pool.query(dupSql, dupParams);
      if (dupRows && dupRows.length) return res.status(409).json({
        error: 'person name already exists',
        message: '该姓名已被其他有效人物使用，请先搜索并确认是否需要合并人物。',
        existingPersonId: String(dupRows[0].id),
      });
    }

    const conn = await pool.getConnection();
    let newPersonId = null;
    let movedFaces = 0;
    try {
      await conn.beginTransaction();

      const person = await getPersonRow(conn, personId, orgId, true);
      if (!person) throw Object.assign(new Error('person not found'), { status: 404 });

      const [rows] = await conn.query(
        `SELECT * FROM photo_faces WHERE person_id = ? AND organization_id = ? AND ${usableFaceSql()} FOR UPDATE`,
        [personId, orgId]
      );
      const ownedIds = new Set((rows || []).map((r) => Number(r.id)));
      const foreign = moveFaceIds.filter((id) => !ownedIds.has(id));
      if (foreign.length) {
        throw Object.assign(new Error(`these faces do not belong to person ${personId}: ${foreign.join(',')}`), { status: 400 });
      }
      if (moveFaceIds.length >= ownedIds.size) {
        throw Object.assign(new Error('至少保留一张脸给原人物；如果想整体改名请用重命名'), { status: 400 });
      }

      const [seqRows] = await conn.query(
        'SELECT COALESCE(MAX(person_no), 0) AS maxNo FROM face_persons WHERE organization_id = ? FOR UPDATE',
        [orgId]
      );
      const nextNo = ((seqRows && seqRows[0] && Number(seqRows[0].maxNo)) || 0) + 1;

      const [ins] = await conn.query(
        'INSERT INTO face_persons (organization_id, person_no, name, note, created_by) VALUES (?, ?, ?, ?, ?)',
        [orgId, nextNo, newPersonName || null, `split from #${personId}`, req.user && req.user.id ? Number(req.user.id) : null]
      );
      newPersonId = ins.insertId;

      // 逐脸合并 extra（记录拆分来源，方便审计/回滚定位）
      const [moveRows] = await conn.query('SELECT id, extra FROM photo_faces WHERE id IN (?)', [moveFaceIds]);
      const movedIdSet = new Set(moveFaceIds);
      for (const mr of (moveRows || [])) {
        if (!movedIdSet.has(Number(mr.id))) continue;
        const extra = parseJsonMaybe(mr.extra);
        const mergedExtra = JSON.stringify({
          ...(extra && typeof extra === 'object' ? extra : {}),
          splitFromPersonId: personId,
          splitToPersonId: newPersonId,
          splitAt: new Date().toISOString(),
        });
        const upd = await conn.query(
          `UPDATE photo_faces SET person_id = ?, status = 'confirmed', extra = ? WHERE id = ? AND person_id = ? AND organization_id = ? AND ${usableFaceSql()}`,
          [newPersonId, mergedExtra, mr.id, personId, orgId]
        );
        movedFaces += upd && upd[0] && Number(upd[0].affectedRows) ? Number(upd[0].affectedRows) : 0;
      }
      const seedSet = new Set(seedFaceIds);
      const feedbackEventId = await recordIdentityFeedback(conn, { orgId, userId: req.user.id, action: 'split',
        details: { originalPersonId: personId, newPersonId, seedFaceIds },
        assignments: rows.map((face) => ({ face,
          personId: movedIdSet.has(Number(face.id)) ? newPersonId : personId,
          kind: seedSet.has(Number(face.id)) ? 'explicit' : 'group' })),
      });
      await recordSeparation(conn, orgId, personId, newPersonId, feedbackEventId);

      // 封面：新人物取搬走组里检测分最高的一张；原人物封面若被搬走则用剩余最好的一张补上
      const [newCoverRows] = await conn.query(
        `SELECT id FROM photo_faces WHERE person_id = ? AND organization_id = ? AND ${usableFaceSql()} ORDER BY detection_score DESC, id ASC LIMIT 1`,
        [newPersonId, orgId]
      );
      if (newCoverRows && newCoverRows.length) {
        await conn.query('UPDATE face_persons SET cover_face_id = ? WHERE id = ?', [newCoverRows[0].id, newPersonId]);
      }

      const oldCoverId = person.cover_face_id ? Number(person.cover_face_id) : null;
      if (oldCoverId && movedIdSet.has(oldCoverId)) {
        const [oldCoverRows] = await conn.query(
          `SELECT id FROM photo_faces WHERE person_id = ? AND organization_id = ? AND ${usableFaceSql()} ORDER BY detection_score DESC, id ASC LIMIT 1`,
          [personId, orgId]
        );
        await conn.query(
          'UPDATE face_persons SET cover_face_id = ? WHERE id = ?',
          [oldCoverRows && oldCoverRows.length ? oldCoverRows[0].id : null, personId]
        );
      }

      await conn.commit();
    } catch (err) {
      await conn.rollback();
      throw err;
    } finally {
      conn.release();
    }

    const [originalProfile, newPersonProfile] = await Promise.all([
      buildFaceProfile({ faceId: null, personId, orgId, userId: req.user.id, workspace: req.workspace }),
      buildFaceProfile({ faceId: null, personId: newPersonId, orgId, userId: req.user.id, workspace: req.workspace }),
    ]);

    return res.json({
      ok: true,
      organizationId: orgId,
      originalPersonId: String(personId),
      newPersonId: String(newPersonId),
      movedFaces,
      original: originalProfile,
      newPerson: newPersonProfile,
    });
  } catch (err) {
    console.error('POST /api/persons/:personId/split error:', err && err.stack ? err.stack : err);
    if (schemaErrorResponse(res, err, 'POST /api/persons/:personId/split')) return;
    if (err && err.status) return res.status(err.status).json({ error: err.message });
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
    // Retain retired profiles for audit history without reserving a visible person's name.
    let dupSql = `SELECT id FROM face_persons WHERE name = ? AND id <> ?
      AND EXISTS (SELECT 1 FROM photo_faces active
        WHERE active.person_id = face_persons.id AND ${usableFaceSql('active')})`;
    dupSql = appendOrgScope(dupSql, 'face_persons', orgId, dupParams);
    dupSql += ' LIMIT 1';
    const [dupRows] = await pool.query(dupSql, dupParams);
    if (dupRows && dupRows.length) {
      return res.status(409).json({
        error: 'person name already exists',
        message: '该姓名已被其他有效人物使用，请在合并人物中搜索该姓名并核对人脸。',
        existingPersonId: String(dupRows[0].id),
      });
    }

    const updParams = [personName, personId];
    let updSql = 'UPDATE face_persons SET name = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?';
    updSql = appendOrgScope(updSql, 'face_persons', orgId, updParams);
    const [upd] = await pool.query(updSql, updParams);
    if (!upd || !Number(upd.affectedRows)) {
      return res.status(404).json({ error: 'person not found' });
    }

    const profile = await buildFaceProfile({ faceId: null, personId, orgId, userId: req.user.id, workspace: req.workspace });
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

    const profile = await buildFaceProfile({ faceId: null, personId, orgId, userId: req.user.id, workspace: req.workspace, ...profileReadOptions(req) });
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

    if (req.query.page !== undefined || req.query.pageSize !== undefined) {
      const { page, pageSize } = profileReadOptions(req);
      const result = await relatedPhotosPage(personId, orgId, req.user.id, req.workspace, page, pageSize);
      return res.json({ personId: String(personId), ...result });
    }

    const photos = await listRelatedPhotosByPersonId(personId, orgId, limit, req.user.id, req.workspace);
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

// ---------------------------------------------------------------------------
// 拍照找我：上传单人照 → 检测 → 在相册/分享范围内按人脸相似度找本人照片。
// 自拍不入库不进对象存储（lib/find_me 临时文件用完即删）。
// ---------------------------------------------------------------------------
const multer = require('multer');
const { findMe, FindMeError, checkRateLimit } = require('../lib/find_me');
const findMeUpload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 20 * 1024 * 1024 } }).single('photo');

function findMeErrorResponse(res, err) {
  if (sendWorkspaceError(res, err)) return res;
  if (err instanceof FindMeError) {
    return res.status(err.status).json({ error: err.code, ...(err.extra || {}) });
  }
  console.error('[find-me] error:', err && err.stack ? err.stack : err);
  return res.status(500).json({ error: 'Internal server error' });
}

// 登录态：在指定相册里找我
router.post('/faces/find-me', requirePermission('photos.view'), (req, res) => {
  findMeUpload(req, res, async (mErr) => {
    if (mErr) return res.status(400).json({ error: mErr.code === 'LIMIT_FILE_SIZE' ? 'FILE_TOO_LARGE' : 'UPLOAD_FAILED' });
    try {
      if (!checkRateLimit(req.ip)) return res.status(429).json({ error: 'RATE_LIMITED' });
      const projectId = Number(req.body && req.body.projectId);
      if (!Number.isFinite(projectId) || projectId <= 0) return res.status(400).json({ error: 'projectId is required' });
      const project = await requireProjectAccess(req, projectId, 'read');
      const orgId = getOrgIdFromReq(req);
      const result = await findMe(req.file && req.file.buffer,
        { projectId, orgId, unitId: project.unit_id || null,
          mediaContext: { userId: req.user.id } });
      if ((await resolveWorkspace(req)).enabled && result?.person) {
        result.person = { matched: true, bestSim: result.person.bestSim };
      }
      return res.json(result);
    } catch (err) {
      return findMeErrorResponse(res, err);
    }
  });
});

// 公开分享页：用分享码鉴权，范围钉死在该分享的照片内（无登录态）
router.post('/faces/find-me/share', (req, res) => {
  findMeUpload(req, res, async (mErr) => {
    if (mErr) return res.status(400).json({ error: mErr.code === 'LIMIT_FILE_SIZE' ? 'FILE_TOO_LARGE' : 'UPLOAD_FAILED' });
    try {
      if (!checkRateLimit(req.ip)) return res.status(429).json({ error: 'RATE_LIMITED' });
      const code = String((req.body && req.body.shareCode) || '').trim();
      if (!code) return res.status(400).json({ error: 'shareCode is required' });

      const [rows] = await pool.query(
        'SELECT id, share_type, project_id, organization_id, unit_id, sync_mode, expires_at, revoked_at FROM share_links WHERE code = ? LIMIT 1', [code]
      );
      if (!rows || !rows.length) return res.status(404).json({ error: 'NOT_FOUND' });
      const s = rows[0];
      if (s.revoked_at) return res.status(410).json({ error: 'REVOKED' });
      if (s.expires_at && new Date(s.expires_at).getTime() <= Date.now()) return res.status(410).json({ error: 'EXPIRED' });

      let scope;
      if (s.share_type === 'collection') {
        const [items] = await pool.query(
          `SELECT si.photo_id FROM share_link_items si JOIN photos ph ON ph.id = si.photo_id
           WHERE si.share_id = ? AND ph.organization_id = ?
             ${s.unit_id ? 'AND ph.unit_id = ?' : ''}`,
          [s.id, s.organization_id, ...(s.unit_id ? [s.unit_id] : [])]
        );
        scope = { photoIds: (items || []).map((r) => Number(r.photo_id)).filter(Boolean) };
      } else if (s.share_type === 'project') {
        if (s.unit_id && s.sync_mode === 'approval') {
          const [items] = await pool.query(
            `SELECT si.photo_id FROM share_link_items si JOIN photos ph ON ph.id = si.photo_id
             WHERE si.share_id = ? AND ph.organization_id = ? AND ph.unit_id = ?`,
            [s.id, s.organization_id, s.unit_id]
          );
          scope = { photoIds: (items || []).map((r) => Number(r.photo_id)).filter(Boolean) };
        } else {
          scope = { projectId: Number(s.project_id),
            orgId: s.organization_id === null ? null : Number(s.organization_id),
            unitId: s.unit_id || null };
        }
      } else {
        return res.status(400).json({ error: 'UNSUPPORTED_SHARE_TYPE' });
      }

      scope.orgId = s.organization_id == null ? null : Number(s.organization_id);
      scope.mediaContext = { shareId: s.id };
      const result = await findMe(req.file && req.file.buffer, scope);
      // Anonymous links never reveal the shared college person library.
      if (result && result.person) {
        result.person = {
          matched: true,
          bestSim: result.person.bestSim,
        };
      }
      return res.json(result);
    } catch (err) {
      return findMeErrorResponse(res, err);
    }
  });
});

module.exports = router;
