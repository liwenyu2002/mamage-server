// Public-download rendition: retain the rendered pixel dimensions while
// re-encoding to a broadly compatible JPEG that fits a predictable download budget.
const sharp = require('sharp');

const MB = 1024 * 1024;
// Use decimal MB so browser download UIs also report this as below 5 MB.
const DEFAULT_MAX_BYTES = 5_000_000;
const DEFAULT_MAX_QUALITY = 92;
const DEFAULT_MIN_QUALITY = 1;

function positiveInt(value, fallback, min = 1) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= min ? Math.floor(parsed) : fallback;
}

async function readStreamToBuffer(stream, options = {}) {
  if (!stream || typeof stream[Symbol.asyncIterator] !== 'function') {
    throw new Error('PUBLIC_DOWNLOAD_SOURCE_UNAVAILABLE');
  }
  const maxBytes = positiveInt(options.maxBytes, 128 * MB);
  const chunks = [];
  let total = 0;
  for await (const chunk of stream) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    total += buffer.length;
    if (total > maxBytes) {
      const err = new Error('PUBLIC_DOWNLOAD_SOURCE_TOO_LARGE');
      err.code = 'PUBLIC_DOWNLOAD_SOURCE_TOO_LARGE';
      throw err;
    }
    chunks.push(buffer);
  }
  return Buffer.concat(chunks, total);
}

async function encodeJpeg(input, quality) {
  // rotate() bakes EXIF orientation into pixels. The output intentionally strips
  // EXIF/GPS metadata, while keeping the visual width, height and colour space.
  return sharp(input, { failOn: 'none' })
    .rotate()
    .flatten({ background: '#ffffff' })
    .toColorspace('srgb')
    .jpeg({
      quality,
      mozjpeg: true,
      progressive: true,
      chromaSubsampling: '4:2:0',
      optimiseScans: true,
    })
    .toBuffer({ resolveWithObject: true });
}

/**
 * Encode the highest JPEG quality that fits maxBytes without resizing.
 * The search includes quality=1 as a final safety net; if even that cannot fit,
 * callers receive an explicit error instead of publishing a file over budget.
 */
async function createPublicDownloadBuffer(input, options = {}) {
  if (!input || !input.length) throw new Error('PUBLIC_DOWNLOAD_EMPTY_SOURCE');

  const maxBytes = positiveInt(options.maxBytes, DEFAULT_MAX_BYTES);
  const maxQuality = Math.min(100, positiveInt(options.maxQuality, DEFAULT_MAX_QUALITY));
  const minQuality = Math.min(maxQuality, Math.max(1, positiveInt(options.minQuality, DEFAULT_MIN_QUALITY)));
  let low = minQuality;
  let high = maxQuality;
  let best = null;

  while (low <= high) {
    const quality = Math.floor((low + high) / 2);
    const encoded = await encodeJpeg(input, quality);
    if (encoded.data.length <= maxBytes) {
      best = { ...encoded, quality };
      low = quality + 1;
    } else {
      high = quality - 1;
    }
  }

  if (!best && minQuality > 1) {
    const encoded = await encodeJpeg(input, 1);
    if (encoded.data.length <= maxBytes) best = { ...encoded, quality: 1 };
  }

  if (!best) {
    const err = new Error('PUBLIC_DOWNLOAD_TARGET_UNREACHABLE');
    err.code = 'PUBLIC_DOWNLOAD_TARGET_UNREACHABLE';
    err.maxBytes = maxBytes;
    throw err;
  }

  return {
    buffer: best.data,
    bytes: best.data.length,
    quality: best.quality,
    width: best.info.width,
    height: best.info.height,
    format: 'jpeg',
  };
}

module.exports = {
  DEFAULT_MAX_BYTES,
  createPublicDownloadBuffer,
  readStreamToBuffer,
};
