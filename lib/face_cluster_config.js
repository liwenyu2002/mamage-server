const { pool } = require('../db');

const DEFAULT_MATCH_THRESHOLD = 0.36;
const MIN_THRESHOLD = 0.2;
const MAX_THRESHOLD = 0.95;

function envNum(name, fallback) {
  const raw = process.env[name];
  if (raw === undefined || raw === null || String(raw).trim() === '') return fallback;
  const n = Number(raw);
  return Number.isFinite(n) ? n : fallback;
}

function clampThreshold(v) {
  if (v === null || v === undefined || String(v).trim() === '') return null;
  const n = Number(v);
  if (!Number.isFinite(n)) return null;
  if (n < MIN_THRESHOLD) return MIN_THRESHOLD;
  if (n > MAX_THRESHOLD) return MAX_THRESHOLD;
  return Number(n.toFixed(4));
}

function defaultThreshold() {
  const envVal = envNum('FACE_CLUSTER_MATCH_THRESHOLD', DEFAULT_MATCH_THRESHOLD);
  return clampThreshold(envVal) || DEFAULT_MATCH_THRESHOLD;
}

function isMissingConfigTableError(err) {
  const code = err && err.code ? String(err.code) : '';
  return code === 'ER_NO_SUCH_TABLE' || code === 'ER_BAD_FIELD_ERROR';
}

async function getOrgFaceClusterConfig(organizationId) {
  const fallback = {
    organizationId: Number.isFinite(Number(organizationId)) ? Number(organizationId) : null,
    matchThreshold: defaultThreshold(),
    source: 'env',
  };
  const orgId = Number(organizationId);
  if (!Number.isFinite(orgId) || orgId <= 0) return fallback;

  try {
    const [rows] = await pool.query(
      `SELECT organization_id AS organizationId, match_threshold AS matchThreshold, updated_at AS updatedAt
       FROM face_cluster_configs
       WHERE organization_id = ?
       LIMIT 1`,
      [orgId]
    );
    if (!rows || rows.length === 0) return fallback;
    const row = rows[0];
    const t = clampThreshold(row.matchThreshold);
    if (t === null) return fallback;
    return {
      organizationId: orgId,
      matchThreshold: t,
      updatedAt: row.updatedAt || null,
      source: 'db',
    };
  } catch (err) {
    if (isMissingConfigTableError(err)) return fallback;
    throw err;
  }
}

async function setOrgFaceClusterThreshold({ organizationId, matchThreshold, updatedBy = null }) {
  const orgId = Number(organizationId);
  if (!Number.isFinite(orgId) || orgId <= 0) throw new Error('invalid organizationId');
  const threshold = clampThreshold(matchThreshold);
  if (threshold === null) throw new Error('invalid matchThreshold');

  await pool.query(
    `INSERT INTO face_cluster_configs (organization_id, match_threshold, updated_by)
     VALUES (?, ?, ?)
     ON DUPLICATE KEY UPDATE
       match_threshold = VALUES(match_threshold),
       updated_by = VALUES(updated_by),
       updated_at = CURRENT_TIMESTAMP`,
    [orgId, threshold, updatedBy || null]
  );

  return getOrgFaceClusterConfig(orgId);
}

module.exports = {
  DEFAULT_MATCH_THRESHOLD,
  MIN_THRESHOLD,
  MAX_THRESHOLD,
  clampThreshold,
  getOrgFaceClusterConfig,
  setOrgFaceClusterThreshold,
  isMissingConfigTableError,
};
