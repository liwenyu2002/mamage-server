// 合影救场端到端冒烟测试（本地，无真人脸服务）：
//   1. 合成 3 张"连拍"：3 个卡通人物，睁眼/闭眼状态各不相同，脸颊带来源字母(A/B/C)
//   2. 直插 photos + photo_faces（正交假 embedding、已知 ratio bbox）
//   3. 直接调 lib/group_rescue 跑完整管线（qwen3-vl 评审 + 羽化合成 + 入库）
//   4. 期望：基准图 A（分最高）中闭眼的 2 号被 B 的睁眼脸替换（合成图 2 号脸颊应出现 B）
//
// 用法：
//   OLLAMA_BASE_URL=http://127.0.0.1:11435 AI_VISION_PROVIDER=ollama \
//   OLLAMA_VISION_MODEL=qwen3-vl:8b node scripts/test_group_rescue.js [--cleanup]
//
// --cleanup：删除本脚本创建的测试数据（photos/photo_faces/文件）后退出

try {
  const path = require('path');
  require('dotenv').config({ path: path.resolve(__dirname, '..', '.env') });
} catch (e) {}

const sharp = require('sharp');
const path = require('path');
const fs = require('fs');
const { pool } = require('../db');

const PROJECT_ID = 47; // 本地"UI走查"项目
const ORG_ID = 3;
const TEST_TAG = 'rescue-test';
const REL_DIR = 'uploads/2026/07/11/rescue-test';
const ABS_DIR = path.resolve(__dirname, '..', REL_DIR);

const IMG_W = 1600;
const IMG_H = 1200;
const FACE_R = 95;
const PERSONS = [
  { cx: 320, cy: 480, hair: '#3d2b1f', shirt: '#8a1f1f' },
  { cx: 800, cy: 480, hair: '#111111', shirt: '#1f4d8a' },
  { cx: 1280, cy: 480, hair: '#5a4632', shirt: '#2e7d32' },
];
// 每张照片每个人的睁眼状态：A=基准（2号闭眼）、B=2号睁眼、C=1号闭眼
const EYE_STATES = {
  A: [true, false, true],
  B: [true, true, false],
  C: [false, true, true],
};
const AI_SCORES = { A: 90, B: 70, C: 60 };

function faceSvg(p, eyesOpen, marker) {
  const { cx, cy, hair } = p;
  const r = FACE_R;
  const eyeY = cy - r * 0.18;
  const eyeDx = r * 0.38;
  const eyes = eyesOpen
    ? `<ellipse cx="${cx - eyeDx}" cy="${eyeY}" rx="14" ry="18" fill="#fff" stroke="#333" stroke-width="2"/>
       <ellipse cx="${cx + eyeDx}" cy="${eyeY}" rx="14" ry="18" fill="#fff" stroke="#333" stroke-width="2"/>
       <circle cx="${cx - eyeDx}" cy="${eyeY + 3}" r="7" fill="#222"/>
       <circle cx="${cx + eyeDx}" cy="${eyeY + 3}" r="7" fill="#222"/>`
    : `<path d="M ${cx - eyeDx - 15} ${eyeY} Q ${cx - eyeDx} ${eyeY + 12} ${cx - eyeDx + 15} ${eyeY}" stroke="#333" stroke-width="4" fill="none"/>
       <path d="M ${cx + eyeDx - 15} ${eyeY} Q ${cx + eyeDx} ${eyeY + 12} ${cx + eyeDx + 15} ${eyeY}" stroke="#333" stroke-width="4" fill="none"/>`;
  const mouth = eyesOpen
    ? `<path d="M ${cx - 32} ${cy + r * 0.42} Q ${cx} ${cy + r * 0.62} ${cx + 32} ${cy + r * 0.42}" stroke="#8a4a3a" stroke-width="5" fill="none"/>`
    : `<line x1="${cx - 26}" y1="${cy + r * 0.48}" x2="${cx + 26}" y2="${cy + r * 0.48}" stroke="#8a4a3a" stroke-width="5"/>`;
  return `
    <path d="M ${cx - r} ${cy - r * 0.1} A ${r} ${r} 0 0 1 ${cx + r} ${cy - r * 0.1} L ${cx + r * 0.8} ${cy - r * 0.55} L ${cx - r * 0.8} ${cy - r * 0.55} Z" fill="${hair}"/>
    <circle cx="${cx}" cy="${cy}" r="${r}" fill="#f2c9a0" stroke="#7a5b3a" stroke-width="3"/>
    <path d="M ${cx - r} ${cy - r * 0.25} A ${r} ${r} 0 0 1 ${cx + r} ${cy - r * 0.25} L ${cx + r * 0.9} ${cy - r * 0.72} Q ${cx} ${cy - r * 1.25} ${cx - r * 0.9} ${cy - r * 0.72} Z" fill="${hair}"/>
    ${eyes}
    ${mouth}
    <circle cx="${cx}" cy="${cy + r * 0.12}" r="6" fill="#e0a87e"/>
    <text x="${cx + r * 0.52}" y="${cy + r * 0.28}" font-size="26" font-weight="bold" fill="#9a6d4f" font-family="sans-serif">${marker}</text>
  `;
}

function personSvg(p, eyesOpen, marker) {
  const { cx, cy, shirt } = p;
  return `
    <rect x="${cx - 130}" y="${cy + FACE_R - 8}" width="260" height="320" rx="60" fill="${shirt}"/>
    ${faceSvg(p, eyesOpen, marker)}
  `;
}

async function makeBurstImage(letter) {
  const states = EYE_STATES[letter];
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${IMG_W}" height="${IMG_H}">
    <defs><linearGradient id="bg" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="#c8d4e0"/><stop offset="1" stop-color="#8fa3b8"/>
    </linearGradient></defs>
    <rect width="${IMG_W}" height="${IMG_H}" fill="url(#bg)"/>
    <rect x="0" y="${IMG_H - 260}" width="${IMG_W}" height="260" fill="#6f8296"/>
    ${PERSONS.map((p, i) => personSvg(p, states[i], letter)).join('')}
    <text x="60" y="${IMG_H - 60}" font-size="40" fill="rgba(255,255,255,0.55)" font-family="sans-serif">burst frame ${letter}</text>
  </svg>`;
  return sharp(Buffer.from(svg)).jpeg({ quality: 92 }).toBuffer();
}

// 正交 + 微噪声的假 embedding：同人跨图余弦≈1，异人≈0
function fakeEmbedding(personIdx, photoIdx) {
  const v = new Array(8).fill(0);
  v[personIdx] = 1;
  v[(personIdx + 4) % 8] = 0.02 * (photoIdx + 1);
  const norm = Math.sqrt(v.reduce((s, x) => s + x * x, 0));
  return v.map((x) => Number((x / norm).toFixed(6)));
}

function bboxRatio(p) {
  const half = FACE_R * 1.15;
  return {
    x: (p.cx - half) / IMG_W,
    y: (p.cy - half) / IMG_H,
    w: (half * 2) / IMG_W,
    h: (half * 2) / IMG_H,
  };
}

async function cleanup() {
  const [rows] = await pool.query('SELECT id FROM photos WHERE project_id = ? AND (title LIKE ? OR title LIKE ?)', [PROJECT_ID, `${TEST_TAG}%`, '合影救场·rescue-test%']);
  const ids = rows.map((r) => r.id);
  if (ids.length) {
    await pool.query('DELETE FROM photo_faces WHERE photo_id IN (?)', [ids]);
    await pool.query('DELETE FROM photos WHERE id IN (?)', [ids]);
    console.log('deleted photo rows:', ids.join(','));
  }
  fs.rmSync(ABS_DIR, { recursive: true, force: true });
  console.log('cleanup done');
}

async function main() {
  if (process.argv.includes('--cleanup')) {
    await cleanup();
    return;
  }
  await cleanup(); // 幂等：先清掉上次残留

  fs.mkdirSync(path.join(ABS_DIR, 'thumbs'), { recursive: true });
  const letters = ['A', 'B', 'C'];
  const photoIds = {};

  for (let pi = 0; pi < letters.length; pi += 1) {
    const letter = letters[pi];
    const buf = await makeBurstImage(letter);
    const rel = `${REL_DIR}/${letter}.jpg`;
    const thumbRel = `${REL_DIR}/thumbs/thumb_${letter}.jpg`;
    fs.writeFileSync(path.resolve(__dirname, '..', rel), buf);
    fs.writeFileSync(path.resolve(__dirname, '..', thumbRel), await sharp(buf).resize(480).jpeg({ quality: 80 }).toBuffer());

    const [res] = await pool.query(
      `INSERT INTO photos (uuid, project_id, url, thumb_url, title, type, ai_status, ai_score, organization_id)
       VALUES (UUID(), ?, ?, ?, ?, 'normal', 'done', ?, ?)`,
      [PROJECT_ID, `/${rel}`, `/${thumbRel}`, `${TEST_TAG}-${letter}`, AI_SCORES[letter], ORG_ID]
    );
    photoIds[letter] = res.insertId;

    for (let k = 0; k < PERSONS.length; k += 1) {
      const b = bboxRatio(PERSONS[k]);
      const emb = JSON.stringify(fakeEmbedding(k, pi));
      await pool.query(
        `INSERT INTO photo_faces
           (photo_id, project_id, organization_id, face_no, bbox_x, bbox_y, bbox_w, bbox_h, bbox_unit,
            image_width, image_height, detection_score, quality_score, embedding, normalized_embedding, status)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'ratio', ?, ?, 0.99, 0.9, ?, ?, 'detected')`,
        [res.insertId, PROJECT_ID, ORG_ID, k + 1, b.x, b.y, b.w, b.h, IMG_W, IMG_H, emb, emb]
      );
    }
    console.log(`seeded photo ${letter} -> id ${res.insertId}`);
  }

  console.log('\nstarting rescue job on', Object.values(photoIds).join(','));
  const rescue = require('../lib/group_rescue');
  const jobId = rescue.startJob(Object.values(photoIds), ORG_ID);
  const t0 = Date.now();
  let lastStep = '';
  for (;;) {
    const job = rescue.getJob(jobId);
    if (!job) throw new Error('job vanished');
    if (job.step !== lastStep) {
      console.log(`[${Math.round((Date.now() - t0) / 1000)}s]`, job.status, '-', job.step);
      lastStep = job.step;
    }
    if (job.status !== 'running') {
      console.log('\nFINAL:', JSON.stringify(job));
      if (job.status === 'done' && job.resultPhotoId) {
        const [rows] = await pool.query('SELECT id, url, thumb_url, title, ai_status FROM photos WHERE id = ?', [job.resultPhotoId]);
        console.log('result photo row:', JSON.stringify(rows[0]));
        console.log('local file:', path.resolve(__dirname, '..', String(rows[0].url).replace(/^\//, '')));
      }
      break;
    }
    await new Promise((r) => setTimeout(r, 1500));
  }
}

main()
  .catch((err) => {
    console.error('fatal:', err && err.stack ? err.stack : err);
    process.exitCode = 1;
  })
  .finally(() => {
    // 不关 pool：group_rescue 完成后可能还有异步收尾；进程由 exit 兜底
    setTimeout(() => process.exit(process.exitCode || 0), 500).unref();
  });
