// scripts/test_user_favorites.js
// /api/favorites 真实冒烟：对本地服务（localhost:8001）跑一遍 CRUD + 幂等 + 越权 + 超限。
// 可重复执行：每次用带时间戳的 refKey 避免撞已有数据，结尾无论成败都清理自建的收藏行与临时用户。
// 用法：node scripts/test_user_favorites.js  （要求本地服务已在 8001 端口跑最新代码）

try {
  const path = require('path');
  require('dotenv').config({ path: path.resolve(__dirname, '..', '.env') });
} catch (e) {}

const bcrypt = require('bcryptjs');
const { pool } = require('../db');

const BASE_URL = process.env.TEST_BASE_URL || 'http://localhost:8001';
const RUN_TAG = Date.now().toString(36);

let passCount = 0;
let failCount = 0;
const cleanupFavoriteIds = []; // {token, id}
let tempUserId = null;

function check(label, cond, detail) {
  if (cond) {
    passCount += 1;
    console.log(`PASS  ${label}`);
  } else {
    failCount += 1;
    console.log(`FAIL  ${label}${detail !== undefined ? '  detail=' + JSON.stringify(detail) : ''}`);
  }
}

async function api(method, urlPath, token, body) {
  const resp = await fetch(BASE_URL + urlPath, {
    method,
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: 'Bearer ' + token } : {}),
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  let json = null;
  try { json = await resp.json(); } catch (e) { /* 空 body 忽略 */ }
  return { status: resp.status, json };
}

async function login(student_no, password) {
  const { status, json } = await api('POST', '/api/users/login', null, { student_no, password });
  if (status !== 200 || !json || !json.token) {
    throw new Error(`login failed for ${student_no}: status=${status} body=${JSON.stringify(json)}`);
  }
  return json.token;
}

// 造第二个临时账号用于「越权 DELETE」测试：直接写库，绕开注册接口的邮箱验证码环节。
async function createTempUser() {
  const [orgRows] = await pool.query('SELECT organization_id FROM users WHERE student_no = ? LIMIT 1', ['devadmin']);
  const orgId = orgRows && orgRows[0] ? orgRows[0].organization_id : null;
  const studentNo = `_favtest_${RUN_TAG}`;
  const password = 'Dev123456';
  const passwordHash = await bcrypt.hash(password, 10);
  const [result] = await pool.query(
    'INSERT INTO users (student_no, name, role, password_hash, organization_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, NOW(), NOW())',
    [studentNo, '_fav_test_other', 'admin', passwordHash, orgId]
  );
  tempUserId = result.insertId;
  return { studentNo, password };
}

async function cleanup() {
  console.log('--- cleanup ---');
  for (const { token, id } of cleanupFavoriteIds) {
    try {
      await api('DELETE', `/api/favorites/${id}`, token);
    } catch (e) {
      console.log('cleanup favorite failed (ignored)', id, e && e.message);
    }
  }
  if (tempUserId) {
    try {
      await pool.query('DELETE FROM users WHERE id = ?', [tempUserId]);
      console.log('temp user removed', tempUserId);
    } catch (e) {
      console.log('cleanup temp user failed (ignored)', e && e.message);
    }
  }
}

async function main() {
  const tokenA = await login('devadmin', 'Dev123456');
  const { studentNo: tempStudentNo, password: tempPassword } = await createTempUser();
  const tokenB = await login(tempStudentNo, tempPassword);

  const styleRefKey = `builtin-favtest-${RUN_TAG}`;
  const stylePayload = {
    type: 'h2',
    name: '冒烟测试块',
    htmlTemplate: '<h2 onclick="alert(1)">标题<script>alert(2)</script></h2>',
    accentEditable: true,
    source: 'builtin',
  };

  // 1) POST styleBlock 收藏，校验 sanitize 生效
  {
    const { status, json } = await api('POST', '/api/favorites', tokenA, {
      kind: 'styleBlock',
      refKey: styleRefKey,
      payload: stylePayload,
    });
    check('POST styleBlock -> 201', status === 201, { status, json });
    const fav = json && json.favorite;
    check('POST styleBlock 返回 refKey 匹配', !!fav && fav.refKey === styleRefKey, fav);
    check('POST styleBlock 剥离 <script>', !!fav && !/<script/i.test(fav.payload.htmlTemplate), fav && fav.payload);
    check('POST styleBlock 剥离 onclick', !!fav && !/onclick/i.test(fav.payload.htmlTemplate), fav && fav.payload);
    if (fav) cleanupFavoriteIds.push({ token: tokenA, id: fav.id });
  }

  // 2) 重复 POST 同一 kind+refKey -> 幂等 200，同一行
  let styleFavId = null;
  {
    const { status, json } = await api('POST', '/api/favorites', tokenA, {
      kind: 'styleBlock',
      refKey: styleRefKey,
      payload: stylePayload,
    });
    check('重复 POST styleBlock -> 200 幂等', status === 200, { status, json });
    styleFavId = json && json.favorite && json.favorite.id;
    const firstId = cleanupFavoriteIds[0] && cleanupFavoriteIds[0].id;
    check('重复 POST 返回同一 id', styleFavId === firstId, { styleFavId, firstId });
  }

  // 3) GET ?kind=styleBlock 能看到刚建的收藏
  {
    const { status, json } = await api('GET', '/api/favorites?kind=styleBlock', tokenA);
    check('GET ?kind=styleBlock -> 200', status === 200, { status });
    const found = json && Array.isArray(json.favorites) && json.favorites.find((f) => f.refKey === styleRefKey);
    check('GET ?kind=styleBlock 含刚建的行', !!found, json && json.favorites);
  }

  // 4) POST photo 收藏
  const photoRefKey = `${RUN_TAG}001`;
  const photoPayload = { id: photoRefKey, url: 'http://example.com/a.jpg', thumbUrl: 'http://example.com/a_thumb.jpg', description: '', projectId: '1', projectTitle: '测试相册' };
  {
    const { status, json } = await api('POST', '/api/favorites', tokenA, {
      kind: 'photo',
      refKey: photoRefKey,
      payload: photoPayload,
    });
    check('POST photo -> 201', status === 201, { status, json });
    const fav = json && json.favorite;
    if (fav) cleanupFavoriteIds.push({ token: tokenA, id: fav.id });
  }

  // 5) GET 全量（不传 kind）应同时含 styleBlock 与 photo
  {
    const { status, json } = await api('GET', '/api/favorites', tokenA);
    check('GET 全量 -> 200', status === 200, { status });
    const kinds = new Set((json && json.favorites || []).map((f) => f.kind));
    check('GET 全量含 styleBlock 与 photo 两种', kinds.has('styleBlock') && kinds.has('photo'), Array.from(kinds));
  }

  // 6) 越权 DELETE：用户 B 删用户 A 的收藏 -> 404
  {
    const { status, json } = await api('DELETE', `/api/favorites/${styleFavId}`, tokenB);
    check('越权 DELETE -> 404', status === 404, { status, json });
  }

  // 7) 伪造不存在 id DELETE -> 404
  {
    const { status, json } = await api('DELETE', '/api/favorites/999999999', tokenA);
    check('不存在 id DELETE -> 404', status === 404, { status, json });
  }

  // 8) payload 超 32KB -> 413
  {
    const bigPayload = { type: 'h2', name: '超限', htmlTemplate: 'x'.repeat(33 * 1024), accentEditable: false, source: 'builtin' };
    const { status, json } = await api('POST', '/api/favorites', tokenA, {
      kind: 'styleBlock',
      refKey: `oversize-${RUN_TAG}`,
      payload: bigPayload,
    });
    check('payload 超 32KB -> 413', status === 413, { status, json });
  }

  // 9) 非法 kind -> 400
  {
    const { status, json } = await api('POST', '/api/favorites', tokenA, { kind: 'nope', refKey: 'x', payload: null });
    check('非法 kind POST -> 400', status === 400, { status, json });
  }
  {
    const { status, json } = await api('GET', '/api/favorites?kind=nope', tokenA);
    check('非法 kind GET -> 400', status === 400, { status, json });
  }

  // 10) refKey 缺失 -> 400
  {
    const { status, json } = await api('POST', '/api/favorites', tokenA, { kind: 'photo', refKey: '', payload: null });
    check('refKey 缺失 -> 400', status === 400, { status, json });
  }

  // 11) 正常 DELETE 自己的收藏 -> 200 deleted:true，随后再删同一 id 变 404（已被删）
  {
    const { status, json } = await api('DELETE', `/api/favorites/${styleFavId}`, tokenA);
    check('正常 DELETE 自己的收藏 -> 200', status === 200 && json && json.deleted === true && json.id === styleFavId, { status, json });
    // 从待清理列表移除（已经删过了，避免 cleanup 阶段对已删行再删一次刷 404 噪音）
    const idx = cleanupFavoriteIds.findIndex((c) => c.id === styleFavId);
    if (idx !== -1) cleanupFavoriteIds.splice(idx, 1);

    const { status: status2 } = await api('DELETE', `/api/favorites/${styleFavId}`, tokenA);
    check('二次 DELETE 已删行 -> 404', status2 === 404, { status2 });
  }
}

main()
  .catch((e) => {
    failCount += 1;
    console.error('FAIL  unexpected error', e && e.stack ? e.stack : e);
  })
  .finally(async () => {
    await cleanup();
    console.log(`--- summary: ${passCount} passed, ${failCount} failed ---`);
    try { await pool.end(); } catch (e) {}
    process.exit(failCount > 0 ? 1 : 0);
  });
