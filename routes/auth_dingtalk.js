// 钉钉企业内应用 OAuth 登录。
// 未配置 DINGTALK_CLIENT_ID/SECRET 时整套路由处于休眠：providers 报 dingtalk:false，
// 登录入口 404，前端按钮不渲染。
//
// 流程（网页扫码/账号登录）：
//   GET /api/auth/dingtalk/login  → 302 钉钉授权页（带防 CSRF 的短时 state JWT）
//   钉钉回调 GET /api/auth/dingtalk/callback?authCode&state
//     → 换 userAccessToken → 拉 /contact/users/me → 按 unionId 绑定/按邮箱合并/新建用户
//     → 签发本站 JWT → 302 到 /#dingtalk_token=<jwt>（fragment 不进服务器日志）
//
// 环境变量：
//   DINGTALK_CLIENT_ID / DINGTALK_CLIENT_SECRET   钉钉开放平台应用凭证（必填才激活）
//   DINGTALK_REDIRECT_URI    默认 https://mamage.wenyuli.site/api/auth/dingtalk/callback
//   DINGTALK_DEFAULT_ORG_ID  新建用户归属组织 id（必填才允许自动建号，否则仅允许已绑定/邮箱匹配）
//   DINGTALK_DEFAULT_ROLE    新建用户角色，默认 visitor

const express = require('express');
const jwt = require('jsonwebtoken');
const fetch = require('node-fetch');
const { pool } = require('../db');
const keys = require('../config/keys');

const router = express.Router();
const JWT_SECRET = keys.JWT_SECRET;

function getConfig() {
  const clientId = String(process.env.DINGTALK_CLIENT_ID || '').trim();
  const clientSecret = String(process.env.DINGTALK_CLIENT_SECRET || '').trim();
  return {
    enabled: Boolean(clientId && clientSecret && JWT_SECRET),
    clientId,
    clientSecret,
    redirectUri: String(process.env.DINGTALK_REDIRECT_URI || 'https://mamage.wenyuli.site/api/auth/dingtalk/callback').trim(),
    defaultOrgId: Number(process.env.DINGTALK_DEFAULT_ORG_ID) || null,
    defaultRole: String(process.env.DINGTALK_DEFAULT_ROLE || 'visitor').trim() || 'visitor',
  };
}

function signToken(payload) {
  return jwt.sign(payload, JWT_SECRET, { expiresIn: '7d' });
}

function redirectWithError(res, message) {
  const msg = encodeURIComponent(String(message || 'dingtalk login failed').slice(0, 120));
  res.redirect(`/#dingtalk_error=${msg}`);
}

// 前端用它决定是否渲染第三方登录按钮
router.get('/providers', (req, res) => {
  res.json({ password: true, dingtalk: getConfig().enabled });
});

router.get('/dingtalk/login', (req, res) => {
  const cfg = getConfig();
  if (!cfg.enabled) return res.status(404).json({ error: 'dingtalk login not configured' });
  const state = jwt.sign({ p: 'dtk' }, JWT_SECRET, { expiresIn: '10m' });
  const url = 'https://login.dingtalk.com/oauth2/auth'
    + `?redirect_uri=${encodeURIComponent(cfg.redirectUri)}`
    + '&response_type=code'
    + `&client_id=${encodeURIComponent(cfg.clientId)}`
    + '&scope=openid'
    + `&state=${encodeURIComponent(state)}`
    + '&prompt=consent';
  res.redirect(url);
});

async function fetchDingTalkProfile(cfg, authCode) {
  const tokenResp = await fetch('https://api.dingtalk.com/v1.0/oauth2/userAccessToken', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      clientId: cfg.clientId,
      clientSecret: cfg.clientSecret,
      code: authCode,
      grantType: 'authorization_code',
    }),
    timeout: 10000,
  });
  const tokenData = await tokenResp.json().catch(() => ({}));
  if (!tokenResp.ok || !tokenData.accessToken) {
    throw new Error(`token exchange failed: ${tokenData.message || tokenResp.status}`);
  }

  const meResp = await fetch('https://api.dingtalk.com/v1.0/contact/users/me', {
    headers: { 'x-acs-dingtalk-access-token': tokenData.accessToken },
    timeout: 10000,
  });
  const me = await meResp.json().catch(() => ({}));
  if (!meResp.ok || !me.unionId) {
    throw new Error(`profile fetch failed: ${me.message || meResp.status}`);
  }
  return me; // { nick, unionId, openId, email?, mobile?, avatarUrl? }
}

// 按 unionId 找人；否则按钉钉返回的邮箱合并进已有账号；再否则（配置了默认组织时）自动建号
async function resolveLocalUser(cfg, profile) {
  const unionId = String(profile.unionId);

  const [byUnion] = await pool.query(
    'SELECT id, role FROM users WHERE dingtalk_union_id = ? LIMIT 1', [unionId]
  );
  if (byUnion && byUnion.length) return byUnion[0];

  const email = String(profile.email || '').trim().toLowerCase();
  if (email) {
    const [byEmail] = await pool.query('SELECT id, role FROM users WHERE email = ? LIMIT 1', [email]);
    if (byEmail && byEmail.length) {
      await pool.query('UPDATE users SET dingtalk_union_id = ? WHERE id = ?', [unionId, byEmail[0].id]);
      return byEmail[0];
    }
  }

  if (!cfg.defaultOrgId) {
    throw new Error('账号未绑定：请先用邮箱注册，或联系管理员配置 DINGTALK_DEFAULT_ORG_ID 开启自动建号');
  }

  const name = String(profile.nick || '钉钉用户').slice(0, 100);
  const studentNo = `dtk_${unionId.slice(0, 24)}`;
  const [result] = await pool.query(
    `INSERT INTO users (student_no, name, email, dingtalk_union_id, role, organization_id)
     VALUES (?, ?, ?, ?, ?, ?)`,
    [studentNo, name, email || null, unionId, cfg.defaultRole, cfg.defaultOrgId]
  );
  return { id: result.insertId, role: cfg.defaultRole };
}

router.get('/dingtalk/callback', async (req, res) => {
  const cfg = getConfig();
  if (!cfg.enabled) return res.status(404).json({ error: 'dingtalk login not configured' });
  try {
    const { authCode, code, state } = req.query || {};
    const oauthCode = authCode || code;
    if (!oauthCode) return redirectWithError(res, '缺少授权码');
    try {
      const parsed = jwt.verify(String(state || ''), JWT_SECRET);
      if (!parsed || parsed.p !== 'dtk') throw new Error('bad state');
    } catch (e) {
      return redirectWithError(res, '登录状态校验失败，请重试');
    }

    const profile = await fetchDingTalkProfile(cfg, String(oauthCode));
    const user = await resolveLocalUser(cfg, profile);
    const token = signToken({ id: user.id, role: user.role });
    res.redirect(`/#dingtalk_token=${encodeURIComponent(token)}`);
  } catch (err) {
    console.error('[auth.dingtalk] callback error:', err && err.message ? err.message : err);
    redirectWithError(res, err && err.message ? err.message : '钉钉登录失败');
  }
});

module.exports = router;
