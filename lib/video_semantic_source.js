const { buildInternalMediaUrl } = require('../db');
const cosStorage = require('./cos_storage');

/** Resolve an analysis source without materialising a full video on the server. */
async function resolveVideoAnalysisInput(row) {
  const source = String(row && row.url || '').trim();
  if (!source) throw new Error('video source missing');
  const key = cosStorage.keyFromUrlOrPath(source);
  if (key && cosStorage.isConfigured() && cosStorage.isSafeKey(key)) {
    const signed = await cosStorage.signedGetUrl(key, { expires: 6 * 60 * 60 });
    if (signed && signed.signedUrl) return signed.signedUrl;
  }
  if (/^https?:\/\//i.test(source)) return source;
  const internal = buildInternalMediaUrl(source);
  if (!internal) throw new Error('video source unavailable');
  return internal;
}

module.exports = { resolveVideoAnalysisInput };
