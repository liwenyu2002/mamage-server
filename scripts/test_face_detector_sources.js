const assert = require('assert');
const path = require('path');

const ROOT = path.join(__dirname, '..');
process.env.FACE_DETECTOR_SERVICE_URL = 'http://127.0.0.1:8009';
process.env.FACE_DETECTOR_USE_SERVICE = '1';
process.env.FACE_DETECTOR_SERVICE_REQUIRED = '1';
process.env.FACE_DETECTOR_USE_THUMB = '1';

const requests = [];
let rejectFullResolution = false;
const axiosPath = require.resolve('axios');
require.cache[axiosPath] = {
  id: axiosPath, filename: axiosPath, loaded: true,
  exports: {
    post: async (_url, body) => {
      requests.push(body.imageUrl);
      if (rejectFullResolution && body.imageUrl.includes('full-resolution.jpg')) throw new Error('unavailable');
      return { data: { backend: 'insightface', modelName: 'buffalo_l', faces: [] } };
    },
  },
};

const dbPath = require.resolve(path.join(ROOT, 'db'));
require.cache[dbPath] = {
  id: dbPath, filename: dbPath, loaded: true,
  exports: {
    buildUploadUrl: (value) => `https://public.test${value}`,
    buildInternalMediaUrl: (value) => value.replace('https://public.test', 'http://127.0.0.1:8080'),
  },
};

const keysPath = require.resolve(path.join(ROOT, 'config/keys'));
require.cache[keysPath] = { id: keysPath, filename: keysPath, loaded: true, exports: {} };

const { detectFacesForPhoto } = require(path.join(ROOT, 'lib/face_detector'));

async function main() {
  await detectFacesForPhoto({
    url: '/uploads/original.jpg',
    thumbUrl: '/uploads/thumb.jpg',
    publicDownloadUrl: '/uploads/full-resolution.jpg',
  });
  assert.deepStrictEqual(requests, ['http://127.0.0.1:8080/uploads/full-resolution.jpg'],
    'face detection must use the full-resolution variant over the local media path');
  requests.length = 0;
  rejectFullResolution = true;
  await detectFacesForPhoto({
    url: '/uploads/original.jpg',
    thumbUrl: '/uploads/thumb.jpg',
    publicDownloadUrl: '/uploads/full-resolution.jpg',
  });
  assert.deepStrictEqual(requests, [
    'http://127.0.0.1:8080/uploads/full-resolution.jpg',
    'http://127.0.0.1:8080/uploads/thumb.jpg',
  ], 'unavailable full-resolution variant must fall back to the thumbnail');
  console.log('face detector source: full-resolution variant via internal media path');
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
