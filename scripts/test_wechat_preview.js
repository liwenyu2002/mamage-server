// scripts/test_wechat_preview.js
// /api/wechat-preview 真实冒烟：POST 落库(鉴权+清洗) + GET 公开访问(无鉴权+CSP) + 404 + 越权。
// 可重复执行：结尾清理自建的预览行与临时用户。
// 用法：node scripts/test_wechat_preview.js  （要求本地服务已在 8001 端口跑最新代码）

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
const cleanupTokens = [];
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
  return { status: resp.status, json, headers: resp.headers };
}

// GET 原始响应（不解析 JSON），用于校验 HTML 页面与响应头。
async function getRaw(urlPath, token) {
  const resp = await fetch(BASE_URL + urlPath, {
    method: 'GET',
    headers: token ? { Authorization: 'Bearer ' + token } : {},
  });
  const text = await resp.text();
  return { status: resp.status, text, headers: resp.headers };
}

async function login(student_no, password) {
  const { status, json } = await api('POST', '/api/users/login', null, { student_no, password });
  if (status !== 200 || !json || !json.token) {
    throw new Error(`login failed for ${student_no}: status=${status} body=${JSON.stringify(json)}`);
  }
  return json.token;
}

// 造第二个临时账号用于「无权限」测试：直接写库，绕开注册接口的邮箱验证码环节。
// 分配一个没有 ai.generate 权限的角色（role_permissions 表里查一个真实存在但不含该权限的角色）。
async function createTempUserWithoutPermission() {
  const [orgRows] = await pool.query('SELECT organization_id FROM users WHERE student_no = ? LIMIT 1', ['devadmin']);
  const orgId = orgRows && orgRows[0] ? orgRows[0].organization_id : null;

  // 直接查 role_permissions：取一个「存在于权限表、但没有 ai.generate」的角色，
  // 而不是看 users 表里已经用过哪些角色（当前库里可能只存在 admin/superadmin，两者都带 ai.generate）。
  const [roleRows] = await pool.query(
    `SELECT DISTINCT role FROM role_permissions
     WHERE role NOT IN (SELECT role FROM role_permissions WHERE permission = 'ai.generate')`
  );
  const role = roleRows && roleRows[0] ? roleRows[0].role : null;
  if (!role) {
    throw new Error('no role without ai.generate permission found in role_permissions; cannot build 越权 test user');
  }

  const studentNo = `_wpvtest_${RUN_TAG}`;
  const password = 'Dev123456';
  const passwordHash = await bcrypt.hash(password, 10);
  const [result] = await pool.query(
    'INSERT INTO users (student_no, name, role, password_hash, organization_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, NOW(), NOW())',
    [studentNo, '_wpv_test_norole', role, passwordHash, orgId]
  );
  tempUserId = result.insertId;
  return { studentNo, password };
}

async function cleanup() {
  console.log('--- cleanup ---');
  if (cleanupTokens.length) {
    try {
      const [result] = await pool.query(
        'DELETE FROM wechat_previews WHERE token IN (?)',
        [cleanupTokens]
      );
      console.log('previews removed', result.affectedRows);
    } catch (e) {
      console.log('cleanup previews failed (ignored)', e && e.message);
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

  const dirtyHtml =
    '<script>alert(1)</script>' +
    '<p style="color:red">正文</p>' +
    '<section style="background-image:url(https://mmbiz.qpic.cn/x.png)">底</section>' +
    '<img src="x.png" onerror="alert(2)">' +
    '<a href="javascript:alert(3)">链接</a>';

  let previewToken = null;

  // 1) POST 落库：校验清洗生效 + 返回结构
  {
    const { status, json } = await api('POST', '/api/wechat-preview', tokenA, {
      title: '冒烟测试标题',
      digest: '冒烟测试摘要',
      html: dirtyHtml,
    });
    check('POST -> 201', status === 201, { status, json });
    check('POST 返回 token', !!(json && json.token && typeof json.token === 'string'), json);
    check('POST 返回 path 含 token', !!(json && json.path === `/api/wechat-preview/${json.token}`), json);
    check('POST 返回 expiresAt', !!(json && json.expiresAt), json);
    previewToken = json && json.token;
    if (previewToken) cleanupTokens.push(previewToken);
  }

  // 2) GET 公开访问（不带 Authorization）：验证内容清洗结果与 CSP 头
  {
    const { status, text, headers } = await getRaw(`/api/wechat-preview/${previewToken}`);
    check('GET 公开访问(无 token) -> 200', status === 200, { status });
    check('GET 响应含标题', text.includes('冒烟测试标题'), text.slice(0, 300));
    check('GET 响应含正文', text.includes('正文'), text.slice(0, 500));
    check('GET 响应保留 style="color:red"', text.includes('style="color:red"'), text.slice(0, 800));
    check('GET 响应保留 background-image 内联样式', text.includes('background-image:url(https://mmbiz.qpic.cn/x.png)'), text.slice(0, 800));
    check('GET 响应不含 <script', !/<script/i.test(text), text.slice(0, 800));
    check('GET 响应不含 onerror', !/onerror/i.test(text), text.slice(0, 800));
    check('GET 响应不含 onload', !/onload/i.test(text), text.slice(0, 800));
    check('GET 响应 javascript: 伪协议已被剥离', !/javascript:alert/i.test(text), text.slice(0, 800));
    const csp = headers.get('content-security-policy');
    check('GET 响应头含 Content-Security-Policy', !!csp, csp);
    check('CSP 含 default-src \'none\'', !!(csp && csp.includes("default-src 'none'")), csp);
    const ct = headers.get('content-type') || '';
    check('GET 响应 Content-Type 为 text/html', ct.includes('text/html'), ct);
  }

  // 3) GET 不存在的 token -> 404，Content-Type text/html
  {
    const { status, text, headers } = await getRaw(`/api/wechat-preview/not_a_real_token_${RUN_TAG}`);
    check('GET 不存在 token -> 404', status === 404, { status });
    const ct = headers.get('content-type') || '';
    check('GET 404 响应 Content-Type 为 text/html', ct.includes('text/html'), ct);
    check('GET 404 页面含中文提示', text.includes('预览不存在或已过期'), text.slice(0, 300));
  }

  // 4) 无 token POST -> 401
  {
    const { status, json } = await api('POST', '/api/wechat-preview', null, { html: '<p>x</p>' });
    check('无 token POST -> 401', status === 401, { status, json });
  }

  // 5) 越权（无 ai.generate 权限账号）POST -> 403
  {
    const { studentNo: tempStudentNo, password: tempPassword } = await createTempUserWithoutPermission();
    const tokenB = await login(tempStudentNo, tempPassword);
    const { status, json } = await api('POST', '/api/wechat-preview', tokenB, { html: '<p>x</p>' });
    check('无权限账号 POST -> 403', status === 403, { status, json });
  }

  // 6) html 缺失 -> 400
  {
    const { status, json } = await api('POST', '/api/wechat-preview', tokenA, { title: 'x' });
    check('html 缺失 -> 400', status === 400, { status, json });
  }

  // 7) html 超 2MB -> 413 code 4133
  {
    const bigHtml = '<p>' + 'x'.repeat(2 * 1024 * 1024 + 100) + '</p>';
    const { status, json } = await api('POST', '/api/wechat-preview', tokenA, { html: bigHtml });
    check('html 超 2MB -> 413', status === 413, { status, json });
    check('html 超 2MB code=4133', !!(json && json.code === 4133), json);
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
