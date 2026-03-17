const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const axios = require('axios');
const { spawnSync } = require('child_process');
const { buildUploadUrl } = require('../db');
const keys = require('../config/keys');

const DEFAULT_MAX_IMAGE_BYTES = 15 * 1024 * 1024;
const DEFAULT_FETCH_TIMEOUT_MS = 20000;
const DEFAULT_DETECT_TIMEOUT_MS = 45000;
const DEFAULT_SERVICE_TIMEOUT_MS = 20000;

function envBool(name, fallback) {
  const raw = process.env[name];
  if (raw === undefined || raw === null || String(raw).trim() === '') return fallback;
  const v = String(raw).trim().toLowerCase();
  return v === '1' || v === 'true' || v === 'yes' || v === 'y';
}

function envInt(name, fallback) {
  const raw = process.env[name];
  if (raw === undefined || raw === null || String(raw).trim() === '') return fallback;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : fallback;
}

function buildUploadRoot() {
  const uploadsAbsDir = keys.UPLOAD_ABS_DIR || path.join(__dirname, '..', 'uploads');
  return uploadsAbsDir.replace(/\\/g, '/').toLowerCase().endsWith('/uploads')
    ? uploadsAbsDir
    : path.join(uploadsAbsDir, 'uploads');
}

function resolveLocalPathFromDbValue(v) {
  if (!v) return null;
  const raw = String(v).replace(/\\/g, '/');
  if (/^https?:\/\//i.test(raw)) return null;

  let rel = raw;
  if (rel.startsWith('/uploads/')) {
    rel = rel.replace(/^\/uploads\//, '');
  } else if (rel.startsWith('uploads/')) {
    rel = rel.replace(/^uploads\//, '');
  } else {
    rel = rel.replace(/^\/+/, '');
  }

  if (!rel) return null;
  return path.join(buildUploadRoot(), rel.split('/').join(path.sep));
}

function looksLikeHttpUrl(v) {
  return /^https?:\/\//i.test(String(v || ''));
}

function makeFaceDetectError(code, message, detail, installHint) {
  const err = new Error(message);
  err.code = code;
  if (detail) err.detail = detail;
  if (installHint) err.installHint = installHint;
  return err;
}

function trimSlash(v) {
  return String(v || '').replace(/\/+$/, '');
}

function detectImageUrl(photoRow, preferThumb) {
  if (!photoRow || typeof photoRow !== 'object') return null;
  const primary = preferThumb ? (photoRow.thumbUrl || photoRow.thumb_url || photoRow.url) : (photoRow.url || photoRow.thumbUrl || photoRow.thumb_url);
  if (!primary) return null;
  if (looksLikeHttpUrl(primary)) return String(primary);
  return buildUploadUrl(primary);
}

function parseDetectorJson(parsed) {
  if (parsed && parsed.error) {
    throw makeFaceDetectError(
      parsed.code || 'FACE_DETECT_FAILED',
      parsed.error || 'face detector failed',
      parsed.detail || null,
      parsed.installHint || null
    );
  }

  const rawFaces = Array.isArray(parsed)
    ? parsed
    : (Array.isArray(parsed.faces) ? parsed.faces : []);

  const imageWidth = Number(parsed.imageWidth) || Number(parsed.image_width) || null;
  const imageHeight = Number(parsed.imageHeight) || Number(parsed.image_height) || null;

  const faces = rawFaces.map((f, idx) => {
    const face = f && typeof f === 'object' ? f : {};
    const box = face.bbox && typeof face.bbox === 'object' ? face.bbox : {};

    const left = Number(box.left ?? face.left ?? 0);
    const top = Number(box.top ?? face.top ?? 0);
    const width = Number(box.width ?? face.width ?? 0);
    const height = Number(box.height ?? face.height ?? 0);
    const score = Number(face.score ?? face.confidence ?? 0);

    return {
      faceNo: Number(face.faceNo || face.faceNumber || face.no || (idx + 1)) || (idx + 1),
      bbox: {
        left,
        top,
        width,
        height,
        normalized: true,
        unit: 'ratio',
      },
      score: Number.isFinite(score) ? score : null,
      imageWidth: imageWidth || null,
      imageHeight: imageHeight || null,
      embedding: Array.isArray(face.embedding) ? face.embedding : null,
      normalizedEmbedding: Array.isArray(face.normalizedEmbedding)
        ? face.normalizedEmbedding
        : (Array.isArray(face.normalized_embedding) ? face.normalized_embedding : null),
      modelName: String(parsed.modelName || parsed.model || parsed.backend || 'face-detector'),
      modelVersion: parsed.modelVersion || null,
      status: 'detected',
      extra: face.extra && typeof face.extra === 'object' ? face.extra : null,
    };
  }).filter((f) => Number.isFinite(f.bbox.left) && Number.isFinite(f.bbox.top) && Number.isFinite(f.bbox.width) && Number.isFinite(f.bbox.height) && f.bbox.width > 0 && f.bbox.height > 0);

  return {
    faces,
    meta: {
      backend: parsed.backend || null,
      modelName: parsed.modelName || parsed.model || null,
      modelVersion: parsed.modelVersion || null,
      imageWidth,
      imageHeight,
      total: faces.length,
    },
  };
}

async function detectViaService(photoRow) {
  const base = trimSlash(process.env.FACE_DETECTOR_SERVICE_URL || '');
  if (!base) return null;

  const preferThumb = envBool('FACE_DETECTOR_USE_THUMB', false);
  const timeout = envInt('FACE_DETECTOR_SERVICE_TIMEOUT_MS', DEFAULT_SERVICE_TIMEOUT_MS);
  const backend = process.env.FACE_DETECTOR_BACKEND || 'auto';
  const modelName = process.env.FACE_DETECTOR_MODEL_NAME || '';

  const candidates = [];
  const first = detectImageUrl(photoRow, preferThumb);
  const second = detectImageUrl(photoRow, !preferThumb);
  if (first) candidates.push(first);
  if (second && second !== first) candidates.push(second);

  let lastErr = null;
  for (const imageUrl of candidates) {
    try {
      const resp = await axios.post(`${base}/detect`, {
        imageUrl,
        backend,
        modelName: modelName || undefined,
      }, {
        timeout,
        validateStatus: (s) => s >= 200 && s < 300,
      });
      const parsed = parseDetectorJson(resp && resp.data ? resp.data : {});
      return {
        ...parsed,
        source: imageUrl,
        sourceType: 'service_url',
      };
    } catch (err) {
      lastErr = err;
    }
  }

  if (!lastErr) {
    throw makeFaceDetectError('FACE_DETECT_SERVICE_FAILED', 'face detector service has no valid image source');
  }
  throw makeFaceDetectError(
    'FACE_DETECT_SERVICE_FAILED',
    'face detector service request failed',
    lastErr && lastErr.message ? lastErr.message : String(lastErr)
  );
}

async function loadPhotoBinary(photoRow) {
  const maxBytes = envInt('FACE_DETECTOR_MAX_IMAGE_BYTES', DEFAULT_MAX_IMAGE_BYTES);
  const fetchTimeout = envInt('FACE_DETECTOR_FETCH_TIMEOUT_MS', DEFAULT_FETCH_TIMEOUT_MS);
  const preferThumb = envBool('FACE_DETECTOR_USE_THUMB', false);

  const localCandidateOrder = preferThumb
    ? [photoRow.thumbUrl, photoRow.thumb_url, photoRow.url]
    : [photoRow.url, photoRow.thumbUrl, photoRow.thumb_url];

  for (const c of localCandidateOrder) {
    const abs = resolveLocalPathFromDbValue(c);
    if (!abs) continue;
    try {
      if (fs.existsSync(abs)) {
        const st = fs.statSync(abs);
        if (st.size > maxBytes) {
          throw makeFaceDetectError(
            'FACE_IMAGE_TOO_LARGE',
            'face detector image is too large',
            `file size=${st.size}, max=${maxBytes}`
          );
        }
        const buffer = fs.readFileSync(abs);
        return {
          buffer,
          source: abs,
          sourceType: 'file',
          extHint: path.extname(abs) || '.jpg',
        };
      }
    } catch (err) {
      if (err && err.code === 'FACE_IMAGE_TOO_LARGE') throw err;
      // Continue to URL fallback.
    }
  }

  const url = detectImageUrl(photoRow, preferThumb);
  if (!url) {
    throw makeFaceDetectError('FACE_IMAGE_NOT_FOUND', 'photo image source is empty');
  }

  let resp;
  try {
    resp = await axios.get(url, {
      responseType: 'arraybuffer',
      timeout: fetchTimeout,
      maxContentLength: maxBytes,
      maxBodyLength: maxBytes,
      validateStatus: (s) => s >= 200 && s < 300,
    });
  } catch (err) {
    throw makeFaceDetectError(
      'FACE_IMAGE_FETCH_FAILED',
      'failed to fetch image for face detector',
      err && err.message ? err.message : String(err)
    );
  }

  const contentType = String((resp.headers && resp.headers['content-type']) || '').toLowerCase();
  const extHint = contentType.includes('png')
    ? '.png'
    : (contentType.includes('webp') ? '.webp' : '.jpg');

  return {
    buffer: Buffer.from(resp.data || []),
    source: url,
    sourceType: 'url',
    extHint,
  };
}

function writeTempImage(buffer, extHint) {
  const safeExt = String(extHint || '.jpg').replace(/[^a-zA-Z0-9.]/g, '').toLowerCase();
  const ext = safeExt.startsWith('.') ? safeExt : `.${safeExt || 'jpg'}`;
  const name = `mamage_face_${Date.now()}_${crypto.randomBytes(5).toString('hex')}${ext}`;
  const tmpPath = path.join(os.tmpdir(), name);
  fs.writeFileSync(tmpPath, buffer);
  return tmpPath;
}

function parseDetectorOutput(rawStdout) {
  let parsed;
  try {
    parsed = JSON.parse(String(rawStdout || '').trim() || '{}');
  } catch (err) {
    throw makeFaceDetectError(
      'FACE_DETECT_PARSE_FAILED',
      'face detector returned invalid json',
      (rawStdout || '').slice(0, 500)
    );
  }

  return parseDetectorJson(parsed);
}

async function detectFacesForPhoto(photoRow) {
  const useServiceFirst = envBool('FACE_DETECTOR_USE_SERVICE', true);
  const serviceRequired = envBool('FACE_DETECTOR_SERVICE_REQUIRED', false);
  if (useServiceFirst) {
    try {
      const serviceResult = await detectViaService(photoRow);
      if (serviceResult) return serviceResult;
    } catch (serviceErr) {
      if (serviceRequired) throw serviceErr;
      console.warn('[face_detector] service detect failed, fallback to local python:', serviceErr && serviceErr.message ? serviceErr.message : serviceErr);
    }
  }

  const python = process.env.FACE_DETECTOR_PYTHON_PATH || process.env.PYTHON_PATH || 'python';
  const script = process.env.FACE_DETECTOR_SCRIPT_PATH || path.join(__dirname, '..', 'scripts', 'face_detect.py');
  const timeoutMs = envInt('FACE_DETECTOR_TIMEOUT_MS', DEFAULT_DETECT_TIMEOUT_MS);

  if (!fs.existsSync(script)) {
    throw makeFaceDetectError('FACE_DETECTOR_SCRIPT_NOT_FOUND', `face detector script not found: ${script}`);
  }

  const loaded = await loadPhotoBinary(photoRow);
  const tmpPath = writeTempImage(loaded.buffer, loaded.extHint);
  let stdout = '';
  let stderr = '';

  try {
    const res = spawnSync(python, [script, tmpPath], {
      encoding: 'utf8',
      timeout: timeoutMs,
      windowsHide: true,
      maxBuffer: 8 * 1024 * 1024,
    });
    stdout = res && res.stdout ? String(res.stdout) : '';
    stderr = res && res.stderr ? String(res.stderr) : '';

    if (res && res.error) {
      throw makeFaceDetectError(
        'FACE_DETECTOR_EXEC_FAILED',
        'failed to execute face detector',
        res.error && res.error.message ? res.error.message : String(res.error),
        'Install python + dependencies, then retry.'
      );
    }

    if (!res || res.status !== 0) {
      const parsedErr = (() => {
        try {
          return JSON.parse((stdout || '').trim() || '{}');
        } catch (e) {
          return null;
        }
      })();

      const detail = (parsedErr && (parsedErr.detail || parsedErr.error))
        ? String(parsedErr.detail || parsedErr.error)
        : (stderr || stdout || 'unknown detector failure').trim();

      throw makeFaceDetectError(
        (parsedErr && parsedErr.code) || 'FACE_DETECT_FAILED',
        (parsedErr && parsedErr.error) || 'face detector failed',
        detail,
        parsedErr && parsedErr.installHint ? parsedErr.installHint : null
      );
    }

    const parsed = parseDetectorOutput(stdout);
    return {
      ...parsed,
      source: loaded.source,
      sourceType: loaded.sourceType,
    };
  } finally {
    try {
      fs.unlinkSync(tmpPath);
    } catch (e) {}
  }
}

module.exports = {
  detectFacesForPhoto,
  makeFaceDetectError,
};
