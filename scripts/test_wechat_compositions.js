// scripts/test_wechat_compositions.js
// /api/wechat-compositions 真实冒烟：POST/GET list/GET :id/PUT/DELETE + 越权(404) + 超限 name(400)。
// 可重复执行：结尾清理自建的存档行与临时用户。
// 用法：node scripts/test_wechat_compositions.js  （要求本地服务已在 8001 端口跑最新代码）

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
const cleanupIds = [];
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
  try { json = await resp.json(); } catch (e) { /* 非 JSON body 忽略 */ }
  return { status: resp.status, json };
}

async function login(student_no, password) {
  const { status, json } = await api('POST', '/api/users/login', null, { student_no, password });
  if (status !== 200 || !json || !json.token) {
    throw new Error(`login failed for ${student_no}: status=${status} body=${JSON.stringify(json)}`);
  }
  return json.token;
}

// 造第二个临时账号用于「越权」测试：直接写库，绕开注册接口的邮箱验证码环节。
async function createTempUser() {
  const [orgRows] = await pool.query('SELECT organization_id FROM users WHERE student_no = ? LIMIT 1', ['devadmin']);
  const orgId = orgRows && orgRows[0] ? orgRows[0].organization_id : null;

  // 需要一个「拥有 ai.generate」的角色，这样越权测试打的是"看不到别人的存档"，而不是权限不足的 403。
  const [roleRows] = await pool.query(
    `SELECT DISTINCT role FROM role_permissions WHERE permission = 'ai.generate'`
  );
  const role = roleRows && roleRows[0] ? roleRows[0].role : null;
  if (!role) throw new Error('no role with ai.generate permission found in role_permissions');

  const studentNo = `_wctest_${RUN_TAG}`;
  const password = 'Dev123456';
  const passwordHash = await bcrypt.hash(password, 10);
  const [result] = await pool.query(
    'INSERT INTO users (student_no, name, role, password_hash, organization_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, NOW(), NOW())',
    [studentNo, '_wc_test_user', role, passwordHash, orgId]
  );
  tempUserId = result.insertId;
  return { studentNo, password };
}

async function cleanup() {
  console.log('--- cleanup ---');
  if (cleanupIds.length) {
    try {
      const [result] = await pool.query('DELETE FROM wechat_compositions WHERE id IN (?)', [cleanupIds]);
      console.log('compositions removed', result.affectedRows);
    } catch (e) {
      console.log('cleanup compositions failed (ignored)', e && e.message);
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

function sampleDoc() {
  return [
    { uid: 'b1', kind: 'styled', type: 'h2', blockId: 'mock-h2', content: '标题文字', src: '', caption: '', accent: null },
    { uid: 'b2', kind: 'para', html: '这是<strong>加粗</strong>正文<img src="x1.png">' },
    { uid: 'b3', kind: 'raw', html: '<script>alert(1)</script><p onclick="alert(2)">导入的整段<img src="x2.png"></p><a href="javascript:alert(3)">坏链接</a>' },
    { uid: 'b4', kind: 'styled', type: 'imageCard', blockId: 'mock-image', content: '', src: 'https://x.com/a.jpg', caption: '图注', accent: null },
  ];
}

async function main() {
  const tokenA = await login('devadmin', 'Dev123456');

  let compId = null;

  // 1) POST 创建：校验清洗生效 + blockCount/imageCount 计算 + 返回结构
  {
    const doc = sampleDoc();
    const { status, json } = await api('POST', '/api/wechat-compositions', tokenA, {
      name: '  冒烟测试存档  ',
      title: '标题A',
      digest: '摘要A',
      doc,
      blockConfig: { h2: 'cfg-h2' },
      themeKey: 'default',
    });
    check('POST -> 201', status === 201, { status, json });
    check('POST 返回 id', !!(json && json.id), json);
    check('POST 返回 name 已 trim', json && json.name === '冒烟测试存档', json);
    check('POST 返回 createdAt/updatedAt', !!(json && json.createdAt && json.updatedAt), json);
    compId = json && json.id;
    if (compId) cleanupIds.push(compId);
  }

  // 2) GET :id：doc 清洗生效、blockCount/imageCount 服务端计算正确、blockConfig/themeKey 回传
  {
    const { status, json } = await api('GET', `/api/wechat-compositions/${compId}`, tokenA);
    check('GET :id -> 200', status === 200, { status, json });
    check('GET :id blockCount=4', json && json.blockCount === 4, json && json.blockCount);
    // imageCount = <img 出现次数(2: x1.png, x2.png) + imageCard 块数(1) = 3
    check('GET :id imageCount=3', json && json.imageCount === 3, json && json.imageCount);
    check('GET :id title/digest 回传', json && json.title === '标题A' && json.digest === '摘要A', json);
    check('GET :id blockConfig 回传', json && json.blockConfig && json.blockConfig.h2 === 'cfg-h2', json && json.blockConfig);
    check('GET :id themeKey 回传', json && json.themeKey === 'default', json && json.themeKey);
    const rawBlock = json && Array.isArray(json.doc) ? json.doc.find((b) => b.uid === 'b3') : null;
    check('GET :id raw 块 script 已剥离', !!rawBlock && !/<script/i.test(rawBlock.html), rawBlock);
    check('GET :id raw 块 onclick 已剥离', !!rawBlock && !/onclick/i.test(rawBlock.html), rawBlock);
    check('GET :id raw 块 javascript: 已剥离', !!rawBlock && !/javascript:alert/i.test(rawBlock.html), rawBlock);
    check('GET :id raw 块 img 仍保留', !!rawBlock && /<img/i.test(rawBlock.html), rawBlock);
    const paraBlock = json && Array.isArray(json.doc) ? json.doc.find((b) => b.uid === 'b2') : null;
    check('GET :id para 块内容未受影响', !!paraBlock && paraBlock.html.includes('<strong>加粗</strong>'), paraBlock);
  }

  // 3) GET list：不含 doc 大字段，按 updated_at 倒序含新建项
  {
    const { status, json } = await api('GET', '/api/wechat-compositions', tokenA);
    check('GET list -> 200', status === 200, { status });
    check('GET list 返回 items 数组', json && Array.isArray(json.items), json);
    const item = json && json.items.find((it) => it.id === compId);
    check('GET list 含新建项', !!item, json && json.items);
    check('GET list 项不含 doc 字段', !!item && item.doc === undefined, item);
    check('GET list 项含 blockCount/imageCount', !!item && item.blockCount === 4 && item.imageCount === 3, item);
  }

  // 4) PUT 部分更新：只传 name，其它字段（title/doc）应保持不变
  {
    const { status, json } = await api('PUT', `/api/wechat-compositions/${compId}`, tokenA, { name: '改名后的存档' });
    check('PUT 部分更新 -> 200', status === 200, { status, json });
    check('PUT 返回新 name', json && json.name === '改名后的存档', json);

    const { json: detail } = await api('GET', `/api/wechat-compositions/${compId}`, tokenA);
    check('PUT 后 title 未被清空', detail && detail.title === '标题A', detail);
    check('PUT 后 blockCount 未变', detail && detail.blockCount === 4, detail);
  }

  // 5) PUT 更新 doc：blockCount/imageCount 应重新计算
  {
    const newDoc = [
      { uid: 'c1', kind: 'para', html: '只有一段文字' },
    ];
    const { status } = await api('PUT', `/api/wechat-compositions/${compId}`, tokenA, { doc: newDoc });
    check('PUT 更新 doc -> 200', status === 200, { status });

    const { json: detail } = await api('GET', `/api/wechat-compositions/${compId}`, tokenA);
    check('PUT 更新 doc 后 blockCount=1', detail && detail.blockCount === 1, detail);
    check('PUT 更新 doc 后 imageCount=0', detail && detail.imageCount === 0, detail);
  }

  // 6) name 超限 -> 400
  {
    const { status, json } = await api('POST', '/api/wechat-compositions', tokenA, {
      name: 'x'.repeat(121),
      doc: [{ uid: 'd1', kind: 'para', html: 'x' }],
    });
    check('name 超 120 字符 -> 400', status === 400, { status, json });
    check('name 超限响应含 error', !!(json && json.error), json);
  }

  // 7) doc 非数组 -> 400
  {
    const { status, json } = await api('POST', '/api/wechat-compositions', tokenA, { name: 'bad doc', doc: { not: 'array' } });
    check('doc 非数组 -> 400', status === 400, { status, json });
  }

  // 8) 空 name -> 服务端兜底 '未命名存档'
  {
    const { status, json } = await api('POST', '/api/wechat-compositions', tokenA, {
      name: '   ',
      doc: [{ uid: 'e1', kind: 'para', html: 'x' }],
    });
    check('空 name POST -> 201', status === 201, { status, json });
    check('空 name 兜底为未命名存档', json && json.name === '未命名存档', json);
    if (json && json.id) cleanupIds.push(json.id);
  }

  // 9) 越权：另一账号看不到本账号的存档（404，不是 403，不暴露"存在但无权"）
  {
    const { studentNo: tempStudentNo, password: tempPassword } = await createTempUser();
    const tokenB = await login(tempStudentNo, tempPassword);

    const { status: getStatus, json: getJson } = await api('GET', `/api/wechat-compositions/${compId}`, tokenB);
    check('越权 GET :id -> 404', getStatus === 404, { status: getStatus, json: getJson });

    const { status: putStatus } = await api('PUT', `/api/wechat-compositions/${compId}`, tokenB, { name: '改一下' });
    check('越权 PUT :id -> 404', putStatus === 404, { status: putStatus });

    const { status: delStatus } = await api('DELETE', `/api/wechat-compositions/${compId}`, tokenB);
    check('越权 DELETE :id -> 404', delStatus === 404, { status: delStatus });

    const { json: listJson } = await api('GET', '/api/wechat-compositions', tokenB);
    check('越权 GET list 不含他人存档', listJson && Array.isArray(listJson.items) && !listJson.items.some((it) => it.id === compId), listJson);
  }

  // 10) 无 token -> 401
  {
    const { status } = await api('GET', '/api/wechat-compositions', null);
    check('无 token GET list -> 401', status === 401, { status });
  }

  // 11) DELETE 本人存档 -> ok，随后 GET -> 404
  {
    const { status, json } = await api('DELETE', `/api/wechat-compositions/${compId}`, tokenA);
    check('DELETE -> 200 ok:true', status === 200 && json && json.ok === true, { status, json });

    const { status: getStatus } = await api('GET', `/api/wechat-compositions/${compId}`, tokenA);
    check('DELETE 后 GET -> 404', getStatus === 404, { status: getStatus });

    // 已删除，从清理列表移除避免重复 DELETE 报错（不影响结果，只是保持日志干净）
    const idx = cleanupIds.indexOf(compId);
    if (idx !== -1) cleanupIds.splice(idx, 1);
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
