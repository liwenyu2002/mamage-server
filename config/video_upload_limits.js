const HARD_MAX_VIDEO_UPLOAD_MB = 100 * 1024;
const DEFAULT_VIDEO_UPLOAD_MB = HARD_MAX_VIDEO_UPLOAD_MB;
const DEFAULT_VIDEO_API_FALLBACK_MB = 5 * 1024;

function readMegabytes(...names) {
  for (const name of names) {
    const raw = process.env[name];
    if (raw === undefined || raw === null || String(raw).trim() === '') continue;
    const value = Number(raw);
    if (Number.isFinite(value) && value > 0) return value;
  }
  return null;
}

function clampMegabytes(value, fallback, minimum = 10) {
  const candidate = Number.isFinite(value) && value > 0 ? value : fallback;
  return Math.min(HARD_MAX_VIDEO_UPLOAD_MB, Math.max(minimum, candidate));
}

function getMaxVideoUploadMb() {
  return clampMegabytes(
    readMegabytes('UPLOAD_MAX_VIDEO_MB', 'VIDEO_UPLOAD_MAX_MB'),
    DEFAULT_VIDEO_UPLOAD_MB
  );
}

function getMaxVideoUploadBytes() {
  return getMaxVideoUploadMb() * 1024 * 1024;
}

function getMaxVideoApiFallbackBytes() {
  return clampMegabytes(
    readMegabytes('VIDEO_API_FALLBACK_MAX_MB'),
    DEFAULT_VIDEO_API_FALLBACK_MB
  ) * 1024 * 1024;
}

module.exports = {
  HARD_MAX_VIDEO_UPLOAD_MB,
  DEFAULT_VIDEO_UPLOAD_MB,
  DEFAULT_VIDEO_API_FALLBACK_MB,
  getMaxVideoUploadMb,
  getMaxVideoUploadBytes,
  getMaxVideoApiFallbackBytes,
};
