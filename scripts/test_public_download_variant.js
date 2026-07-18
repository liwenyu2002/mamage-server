const assert = require('assert');
const sharp = require('sharp');
const { createPublicDownloadBuffer } = require('../lib/public_download_variant');

function makeNoise(width, height) {
  const data = Buffer.allocUnsafe(width * height * 3);
  let state = 0x12345678;
  for (let i = 0; i < data.length; i += 1) {
    state = (state * 1664525 + 1013904223) >>> 0;
    data[i] = state & 0xff;
  }
  return sharp(data, { raw: { width, height, channels: 3 } }).png().toBuffer();
}

async function main() {
  const source = await makeNoise(1600, 1000);
  const result = await createPublicDownloadBuffer(source, { maxBytes: 350 * 1024 });
  const meta = await sharp(result.buffer).metadata();
  assert.strictEqual(meta.format, 'jpeg');
  assert.strictEqual(meta.width, 1600);
  assert.strictEqual(meta.height, 1000);
  assert.ok(result.bytes <= 350 * 1024, `output must fit target, got ${result.bytes}`);
  console.log(`public download variant self-check passed: ${result.bytes} bytes, quality ${result.quality}`);
}

main().catch((err) => { console.error(err); process.exit(1); });
