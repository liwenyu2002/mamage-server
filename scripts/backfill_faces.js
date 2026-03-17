// scripts/backfill_faces.js
// Batch detect faces for existing photos and write results into photo_faces.
//
// Examples:
//   node scripts/backfill_faces.js --limit=50
//   node scripts/backfill_faces.js --projectId=12 --limit=200
//   node scripts/backfill_faces.js --photoId=123 --force
//   node scripts/backfill_faces.js --orgId=1 --defaultOrgId=1 --dryRun

try {
  const path = require('path');
  require('dotenv').config({ path: path.resolve(__dirname, '..', '.env') });
} catch (e) {}

const { pool } = require('../db');
const { detectFacesForPhoto } = require('../lib/face_detector');
const { detectAndClusterPhoto } = require('../lib/face_auto_pipeline');

function parseArgs(argv) {
  const out = {};
  for (const raw of argv) {
    if (!raw || !raw.startsWith('--')) continue;
    const body = raw.slice(2);
    if (!body) continue;
    const eq = body.indexOf('=');
    if (eq === -1) {
      out[body] = true;
      continue;
    }
    const k = body.slice(0, eq).trim();
    const v = body.slice(eq + 1).trim();
    if (k) out[k] = v;
  }
  return out;
}

function toPositiveInt(v, fallback = null) {
  if (v === undefined || v === null || v === '') return fallback;
  const n = Number(v);
  if (!Number.isFinite(n)) return fallback;
  const i = Math.floor(n);
  return i > 0 ? i : fallback;
}

function toNonNegativeInt(v, fallback = 0) {
  if (v === undefined || v === null || v === '') return fallback;
  const n = Number(v);
  if (!Number.isFinite(n)) return fallback;
  const i = Math.floor(n);
  return i >= 0 ? i : fallback;
}

function boolFlag(v, fallback = false) {
  if (v === undefined || v === null) return fallback;
  if (v === true) return true;
  const s = String(v).trim().toLowerCase();
  if (!s) return fallback;
  return s === '1' || s === 'true' || s === 'yes' || s === 'y';
}

function printUsage() {
  console.log(`
Usage:
  node scripts/backfill_faces.js [options]

Options:
  --photoId=<id>         backfill one photo
  --projectId=<id>       backfill photos in one project
  --orgId=<id>           filter photos by organization_id
  --defaultOrgId=<id>    fallback org id when photo.organization_id is null
  --limit=<n>            max photos to process (default 100)
  --offset=<n>           query offset (default 0)
  --force                re-detect and overwrite existing face rows
  --withCluster=0|1      run clustering/person matching when writing (default 1)
  --threshold=<n>        override cluster threshold for this run (0.2~0.95)
  --resetOrg=0|1         clear existing face rows/persons for target org before running
  --dryRun               run detection without writing DB
  --help                 show this help
`);
}

function normalizeDetectedFaces(rawFaces) {
  const arr = Array.isArray(rawFaces) ? rawFaces : [];
  let seq = 0;
  return arr.map((f, idx) => {
    const face = f && typeof f === 'object' ? f : {};
    const bbox = face.bbox && typeof face.bbox === 'object' ? face.bbox : {};

    const left = Number(bbox.left ?? face.left);
    const top = Number(bbox.top ?? face.top);
    const width = Number(bbox.width ?? face.width);
    const height = Number(bbox.height ?? face.height);

    if (!Number.isFinite(left) || !Number.isFinite(top) || !Number.isFinite(width) || !Number.isFinite(height)) {
      return null;
    }
    if (width <= 0 || height <= 0) return null;

    const faceNoRaw = Number(face.faceNo || face.faceNumber || face.no || 0);
    const faceNo = Number.isFinite(faceNoRaw) && faceNoRaw > 0 ? Math.floor(faceNoRaw) : 0;
    seq += 1;

    return {
      faceNo: faceNo || seq || (idx + 1),
      left,
      top,
      width,
      height,
      unit: String(bbox.unit || face.unit || 'ratio').toLowerCase() === 'pixel' ? 'pixel' : 'ratio',
      imageWidth: Number(face.imageWidth) || Number(face.image_width) || null,
      imageHeight: Number(face.imageHeight) || Number(face.image_height) || null,
      detectionScore: Number.isFinite(Number(face.score)) ? Number(face.score) : null,
      qualityScore: Number.isFinite(Number(face.qualityScore)) ? Number(face.qualityScore) : null,
      embedding: Array.isArray(face.embedding) ? face.embedding : null,
      normalizedEmbedding: Array.isArray(face.normalizedEmbedding)
        ? face.normalizedEmbedding
        : (Array.isArray(face.normalized_embedding) ? face.normalized_embedding : null),
      modelName: face.modelName || face.model || 'face-detector',
      modelVersion: face.modelVersion || face.model_version || null,
      status: face.status || 'detected',
      faceHash: face.faceHash || face.face_hash || null,
      extra: face.extra && typeof face.extra === 'object' ? face.extra : null,
    };
  }).filter(Boolean);
}

async function loadPhotos({ photoId, projectId, orgId, limit, offset }) {
  const where = [];
  const params = [];

  if (photoId) {
    where.push('p.id = ?');
    params.push(photoId);
  }
  if (projectId) {
    where.push('p.project_id = ?');
    params.push(projectId);
  }
  if (orgId !== null && orgId !== undefined) {
    where.push('p.organization_id = ?');
    params.push(orgId);
  }

  let sql = `
    SELECT
      p.id,
      p.project_id AS projectId,
      p.organization_id AS organizationId,
      p.url,
      p.thumb_url AS thumbUrl
    FROM photos p
  `;
  if (where.length) sql += ` WHERE ${where.join(' AND ')}`;
  sql += ' ORDER BY p.id ASC LIMIT ? OFFSET ?';
  params.push(limit, offset);

  const [rows] = await pool.query(sql, params);
  return rows || [];
}

async function getExistingFaceCount(photoId) {
  const [rows] = await pool.query('SELECT COUNT(*) AS c FROM photo_faces WHERE photo_id = ?', [photoId]);
  return rows && rows[0] ? Number(rows[0].c) || 0 : 0;
}

async function writeFaces({ photo, orgIdForInsert, normalizedFaces }) {
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    await conn.query('DELETE FROM photo_faces WHERE photo_id = ?', [photo.id]);

    if (normalizedFaces.length > 0) {
      const seenFaceNo = new Set();
      let fallbackFaceNo = 0;

      for (const face of normalizedFaces) {
        let faceNo = Number(face.faceNo) || 0;
        if (!faceNo || seenFaceNo.has(faceNo)) {
          do {
            fallbackFaceNo += 1;
            faceNo = fallbackFaceNo;
          } while (seenFaceNo.has(faceNo));
        }
        seenFaceNo.add(faceNo);

        await conn.query(
          `INSERT INTO photo_faces (
            photo_id, project_id, organization_id, person_id, face_no,
            bbox_x, bbox_y, bbox_w, bbox_h, bbox_unit,
            image_width, image_height, detection_score, quality_score,
            embedding, normalized_embedding,
            model_name, model_version, status, face_hash, extra
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [
            photo.id,
            photo.projectId || null,
            orgIdForInsert,
            null,
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

async function main() {
  const argv = parseArgs(process.argv.slice(2));
  if (argv.help) {
    printUsage();
    return;
  }

  const photoId = toPositiveInt(argv.photoId, null);
  const projectId = toPositiveInt(argv.projectId, null);
  const orgId = toPositiveInt(argv.orgId, null);
  const defaultOrgId = toPositiveInt(argv.defaultOrgId, null);
  const limit = toPositiveInt(argv.limit, 100);
  const offset = toNonNegativeInt(argv.offset, 0);
  const force = boolFlag(argv.force, false);
  const dryRun = boolFlag(argv.dryRun, false);
  const withCluster = boolFlag(argv.withCluster, true);
  const threshold = argv.threshold !== undefined ? Number(argv.threshold) : null;
  const resetOrg = boolFlag(argv.resetOrg, false);

  const startedAt = Date.now();
  const photos = await loadPhotos({ photoId, projectId, orgId, limit, offset });
  console.log('[backfill_faces] loaded photos:', photos.length);
  console.log('[backfill_faces] options:', {
    photoId,
    projectId,
    orgId,
    defaultOrgId,
    limit,
    offset,
    force,
    withCluster,
    threshold: Number.isFinite(threshold) ? threshold : null,
    resetOrg,
    dryRun,
  });

  if (resetOrg) {
    if (dryRun) {
      console.log('[backfill_faces] resetOrg requested but dryRun=true, skip reset');
    } else if (!orgId) {
      throw new Error('--resetOrg requires --orgId=<id>');
    } else {
      console.log('[backfill_faces] resetting existing faces/persons for orgId=', orgId);
      await pool.query('DELETE FROM photo_faces WHERE organization_id = ?', [orgId]);
      await pool.query('DELETE FROM face_persons WHERE organization_id = ?', [orgId]);
      console.log('[backfill_faces] reset done');
    }
  }

  const stats = {
    total: photos.length,
    processed: 0,
    skippedHasFaces: 0,
    skippedNoOrg: 0,
    detectedFaces: 0,
    wrotePhotos: 0,
    wroteRows: 0,
    clusterMatched: 0,
    createdPersons: 0,
    failed: 0,
  };

  for (let i = 0; i < photos.length; i++) {
    const p = photos[i];
    const label = `[${i + 1}/${photos.length}] photoId=${p.id}`;

    try {
      const existingCount = await getExistingFaceCount(p.id);
      if (!force && existingCount > 0) {
        stats.skippedHasFaces += 1;
        console.log(`${label} skip (already has ${existingCount} faces)`);
        continue;
      }

      const orgIdForInsert = toPositiveInt(p.organizationId, null) || defaultOrgId;
      if (!orgIdForInsert) {
        stats.skippedNoOrg += 1;
        console.log(`${label} skip (organization_id is null, provide --defaultOrgId)`);
        continue;
      }

      if (!dryRun && withCluster) {
        const r = await detectAndClusterPhoto({
          photoId: p.id,
          uploaderId: null,
          force: true,
          organizationIdOverride: orgIdForInsert,
          matchThresholdOverride: Number.isFinite(threshold) ? threshold : null,
        });
        if (r && r.skipped) {
          stats.skippedNoOrg += 1;
          console.log(`${label} skip (${r.reason || 'skipped'})`);
          continue;
        }
        stats.processed += 1;
        stats.wrotePhotos += 1;
        stats.wroteRows += Number(r && r.insertedRows) || 0;
        stats.detectedFaces += Number(r && r.totalFaces) || 0;
        stats.clusterMatched += Number(r && r.matchedCount) || 0;
        stats.createdPersons += Number(r && r.createdPersons) || 0;
        console.log(
          `${label} ok (${Number(r && r.totalFaces) || 0} faces, matched=${Number(r && r.matchedCount) || 0}, createdPersons=${Number(r && r.createdPersons) || 0})`
        );
        continue;
      }

      const detected = await detectFacesForPhoto(p);
      const normalizedFaces = normalizeDetectedFaces(detected && detected.faces);
      stats.detectedFaces += normalizedFaces.length;

      if (!dryRun) {
        await writeFaces({ photo: p, orgIdForInsert, normalizedFaces });
        stats.wrotePhotos += 1;
        stats.wroteRows += normalizedFaces.length;
      }

      stats.processed += 1;
      console.log(
        `${label} ok (${normalizedFaces.length} faces, backend=${detected && detected.meta ? detected.meta.backend : 'unknown'})`
      );
    } catch (err) {
      stats.failed += 1;
      console.error(`${label} failed:`, err && err.code ? err.code : err && err.message ? err.message : err);
      if (err && err.detail) console.error('  detail:', err.detail);
    }
  }

  const costMs = Date.now() - startedAt;
  console.log('[backfill_faces] done:', {
    ...stats,
    dryRun,
    elapsedMs: costMs,
    elapsedSec: Number((costMs / 1000).toFixed(2)),
  });
}

main()
  .catch((err) => {
    console.error('[backfill_faces] fatal:', err && err.stack ? err.stack : err);
    process.exitCode = 1;
  })
  .finally(async () => {
    try {
      await pool.end();
    } catch (e) {}
  });
