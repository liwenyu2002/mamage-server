const CURRENT_FACE_REVISION = 'face-policy-20261009-v2';
const LEGACY_BLOCKED_STATUS = 'legacy_blocked';
const INACTIVE_STATUSES = new Set(['rejected', 'deleted', LEGACY_BLOCKED_STATUS]);

function isUsableFaceResult(row) {
  return Boolean(row && !INACTIVE_STATUSES.has(row.status));
}

function usableFaceSql(alias = '') {
  if (alias && !/^[A-Za-z_][A-Za-z0-9_]*$/.test(alias)) throw new Error('invalid face SQL alias');
  const column = alias ? `${alias}.status` : 'status';
  return `${column} NOT IN ('rejected', 'deleted', '${LEGACY_BLOCKED_STATUS}')`;
}

function isReviewedFeedback(row) {
  return row?.sample_kind === 'explicit' || row?.sample_kind === 'group';
}

module.exports = { CURRENT_FACE_REVISION, LEGACY_BLOCKED_STATUS,
  isUsableFaceResult, usableFaceSql, isReviewedFeedback };
