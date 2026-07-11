// AI 选片 2.0 管线冒烟测试：合成两张图（清晰高对比 vs 重糊欠曝），
// 走完整 analyzePhoto 链路（技术实测 + 真实 Ollama 评分 + 综合分）。
// 用法：OLLAMA_BASE_URL=http://127.0.0.1:11435 AI_VISION_PROVIDER=ollama \
//        OLLAMA_VISION_MODEL=qwen2.5vl:7b node scripts/test_ai_quality.js

const http = require('http');
const sharp = require('sharp');
const { analyzePhoto } = require('../ai_function/ai_for_tags/ai_for_tags');

async function makeSharpImage() {
  // 高对比棋盘 + 渐变：锐度应高、曝光正常
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="1600" height="1200">
    <defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" stop-color="#7a94b8"/><stop offset="1" stop-color="#3d4c61"/>
    </linearGradient></defs>
    <rect width="1600" height="1200" fill="url(#g)"/>
    ${Array.from({ length: 12 }, (_, i) => `<rect x="${100 + i * 120}" y="${180 + (i % 3) * 260}" width="90" height="90" fill="${i % 2 ? '#f4f0e8' : '#1d232e'}"/>`).join('')}
    <circle cx="800" cy="640" r="210" fill="#e8ddc8" stroke="#22282f" stroke-width="14"/>
    <text x="800" y="1080" font-size="90" text-anchor="middle" fill="#101418" font-family="sans-serif">MaMage QUALITY TEST</text>
    <rect x="250" y="120" width="1100" height="120" fill="#b91c1c"/>
    <text x="800" y="200" font-size="72" text-anchor="middle" fill="#ffffff" font-family="sans-serif">2026 校运会 100米决赛</text>
  </svg>`;
  return sharp(Buffer.from(svg)).jpeg({ quality: 92 }).toBuffer();
}

async function makeBlurryImage() {
  const base = await makeSharpImage();
  // 重高斯模糊 + 大幅压暗 → 应触发 严重模糊 flag 与低曝光分
  return sharp(base).blur(18).modulate({ brightness: 0.28 }).jpeg({ quality: 85 }).toBuffer();
}

async function main() {
  const images = {
    '/sharp.jpg': await makeSharpImage(),
    '/blurry.jpg': await makeBlurryImage(),
  };
  const server = http.createServer((req, res) => {
    const buf = images[req.url];
    if (!buf) { res.writeHead(404); res.end(); return; }
    res.writeHead(200, { 'content-type': 'image/jpeg', 'content-length': buf.length });
    res.end(buf);
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;

  for (const name of Object.keys(images)) {
    const t0 = Date.now();
    try {
      const result = await analyzePhoto(`http://127.0.0.1:${port}${name}`);
      console.log(`\n=== ${name} (${Date.now() - t0}ms) ===`);
      console.log('score:', result.score, '| label:', result.tags && result.tags[0]);
      console.log('dims:', JSON.stringify(result.quality && result.quality.dims));
      console.log('flags:', JSON.stringify(result.quality && result.quality.flags));
      console.log('reason:', result.quality && result.quality.reason);
      console.log('tech:', JSON.stringify(result.quality && result.quality.tech));
      console.log('tags:', JSON.stringify(result.tags));
      console.log('description:', result.description);
      console.log('ocrText:', result.ocrText);
    } catch (e) {
      console.error(`\n=== ${name} FAILED ===`, e && e.message ? e.message : e);
      process.exitCode = 1;
    }
  }
  server.close();
}

main();
