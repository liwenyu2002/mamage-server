// 入口自动选择支撑：后端就跑在 Mac Mini 上，实时上报自己当前的内网地址，
// 并判断"当前访问者是否和 Mini 同处校园网"（比对双方的公网出口 IP）。
// DHCP 轮换内网 IP 也不怕——每次请求返回的都是当下值。
//
// 访问者公网 IP 来源：Cloudflare Tunnel 会带 CF-Connecting-IP；
// Mini 自己的公网 IP：定期查询外部服务（默认 api.ipify.org，5 分钟缓存）。
// 判定命中（精确相等 / 同 /24，学校 NAT 汜围）→ visitorOnIntranet=true，
// 前端据此自动跳内网入口；判不准一律 false，留在公网（安全方向：最多慢，不会断）。
const os = require('os');
const express = require('express');
const fetch = require('node-fetch');
const router = express.Router();

const LAN_HTTPS_PORT = Number(process.env.LAN_HTTPS_PORT || 3443);
const PUBLIC_IP_CACHE_MS = 5 * 60 * 1000;
const PUBLIC_IP_TIMEOUT_MS = 5000;
// 额外判定规则（可选）：逗号分隔的 CIDR/单个 IP，命中也算内网，用于学校多 NAT 池
const EXTRA_VISITOR_CIDRS = String(process.env.INTRANET_VISITOR_CIDRS || '')
  .split(',').map((x) => x.trim()).filter(Boolean);

let publicIpCache = { v4: null, v6: null, at: 0 };

// 过滤掉虚拟网卡（docker/colima 桥、VPN utun、苹果随享 awdl 等），优先物理口 en0/en1
function pickLanAddress() {
  const ifaces = os.networkInterfaces() || {};
  const preferred = ['en0', 'en1'];
  const candidates = [];
  for (const [name, addrs] of Object.entries(ifaces)) {
    if (/^(docker|br-|veth|utun|bridge|llw|awdl|anpi|ap|gif|stf|tap|tun|zt|tailscale)/i.test(name)) continue;
    for (const a of addrs || []) {
      if (!a || a.family !== 'IPv4' || a.internal) continue;
      if (!/^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(a.address)) continue;
      const score = preferred.indexOf(name);
      candidates.push({ name, address: a.address, score: score < 0 ? 99 : score });
    }
  }
  if (!candidates.length) return null;
  candidates.sort((a, b) => a.score - b.score || a.name.localeCompare(b.name));
  return candidates[0];
}

async function fetchText(url) {
  const resp = await fetch(url, { timeout: PUBLIC_IP_TIMEOUT_MS });
  return String(await resp.text()).trim();
}

// 双栈查本机公网出口：ipv4./ipv6. 专用主机名只解析对应族，天然强制走 v4/v6 路由。
// 校园网常有双栈（今日实测 v4=125.35.71.202、v6=240e:604:76b::/48），两族分开比对。
async function getOwnPublicIps() {
  const now = Date.now();
  if (now - publicIpCache.at < PUBLIC_IP_CACHE_MS) return publicIpCache;
  const [v4, v6] = await Promise.all([
    fetchText('https://ipv4.icanhazip.com').catch(() => null),
    fetchText('https://ipv6.icanhazip.com').catch(() => null),
  ]);
  publicIpCache = {
    v4: v4 && /^(\d{1,3}\.){3}\d{1,3}$/.test(v4) ? v4 : null,
    v6: v6 && v6.includes(':') ? v6.toLowerCase() : null,
    at: now,
  };
  return publicIpCache;
}

// 访问者的公网 IP：隧道流量看 CF 头；直连/内网 nginx 场景回退 XFF / socket 地址
function visitorPublicIp(req) {
  const cf = req.headers['cf-connecting-ip'] || req.headers['cf-connecting-for'];
  if (cf) return String(cf).split(',')[0].trim();
  const xff = req.headers['x-forwarded-for'];
  if (xff) return String(xff).split(',')[0].trim();
  const ra = req.socket && req.socket.remoteAddress;
  return ra ? String(ra).replace(/^::ffff:/, '') : null;
}

function ipv4ToLong(ip) {
  const parts = String(ip).split('.').map(Number);
  if (parts.length !== 4 || parts.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return null;
  return ((parts[0] << 24) | (parts[1] << 16) | (parts[2] << 8) | parts[3]) >>> 0;
}

// 支持 "1.2.3.4" 与 "1.2.3.0/24" 两种写法
function ipMatchesRule(ip, rule) {
  if (!ip || !rule) return false;
  if (!rule.includes('/')) return String(ip) === String(rule);
  const [base, bitsRaw] = rule.split('/');
  const bits = Number(bitsRaw);
  const a = ipv4ToLong(ip);
  const b = ipv4ToLong(base);
  if (a === null || b === null || !Number.isInteger(bits) || bits < 0 || bits > 32) return false;
  const mask = bits === 0 ? 0 : (~0 << (32 - bits)) >>> 0;
  return (a & mask) === (b & mask);
}

function ipv6Normalize(ip) {
  const s = String(ip || '').toLowerCase();
  if (!s.includes(':')) return null;
  return s;
}

// v6 按前 3 段（/48）比对：校园网通常分到 /48 前缀
function ipv6SharesCampusPrefix(a, b) {
  const x = ipv6Normalize(a);
  const y = ipv6Normalize(b);
  if (!x || !y) return false;
  const pick = (s) => s.split(':').slice(0, 3).join(':');
  return pick(x) === pick(y);
}

// 访问者是否与 Mini 同校园网：同族出口 IP 精确相等 / v4 同 /24（NAT 池）/ v6 同 /48，
// 或命中额外配置规则。只在把握大时返回 true；判不准一律 false（前端留在公网入口）。
function visitorLooksIntranet(visitorIp, ownIps) {
  if (!visitorIp) return false;
  for (const rule of EXTRA_VISITOR_CIDRS) {
    if (ipMatchesRule(visitorIp, rule)) return true;
  }
  if (!ownIps) return false;
  if (visitorIp.includes(':')) {
    return ipv6SharesCampusPrefix(visitorIp, ownIps.v6);
  }
  if (visitorIp === ownIps.v4) return true;
  const a = ipv4ToLong(visitorIp);
  const b = ipv4ToLong(ownIps.v4);
  if (a === null || b === null) return false;
  const mask = 0xffffff00;
  return (a & mask) === (b & mask);
}

router.get('/lan', async (req, res) => {
  const lan = pickLanAddress();
  const visitorIp = visitorPublicIp(req);
  const ownIps = await getOwnPublicIps();
  const visitorOnIntranet = visitorLooksIntranet(visitorIp, ownIps);
  // 只回前端自动切换真正需要的字段；网卡名/主机名/公网出口 IP 属于内网拓扑，
  // 不向未认证访客暴露
  res.json({
    ok: Boolean(lan),
    lanIp: lan ? lan.address : null,
    lanPort: LAN_HTTPS_PORT,
    visitorOnIntranet,
    reportedAt: new Date().toISOString(),
  });
});

module.exports = router;
