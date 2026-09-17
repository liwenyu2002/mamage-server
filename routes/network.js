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

let publicIpCache = { ip: null, at: 0 };

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

async function getOwnPublicIp() {
  const now = Date.now();
  if (publicIpCache.ip && now - publicIpCache.at < PUBLIC_IP_CACHE_MS) return publicIpCache.ip;
  try {
    const resp = await fetch('https://api.ipify.org?format=json', { timeout: PUBLIC_IP_TIMEOUT_MS });
    const data = await resp.json().catch(() => null);
    const ip = data && data.ip ? String(data.ip).trim() : null;
    if (ip) publicIpCache = { ip, at: now };
    else publicIpCache = { ip: publicIpCache.ip, at: now }; // 查询失败也续期，避免打爆外部服务
    return publicIpCache.ip;
  } catch (e) {
    return publicIpCache.ip; // 失败回退旧值；没有旧值则判不出 → 访问者留在公网
  }
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

// 访问者是否与 Mini 同校园网：出口 IP 相同 / 同 /24（NAT 池）/ 命中额外配置规则。
// 只在把握大时返回 true；判不准一律 false（前端留在公网入口，绝不误跳）。
function visitorLooksIntranet(visitorIp, ownPublicIp) {
  if (!visitorIp || !ownPublicIp) return false;
  for (const rule of EXTRA_VISITOR_CIDRS) {
    if (ipMatchesRule(visitorIp, rule)) return true;
  }
  if (visitorIp === ownPublicIp) return true;
  // 同 /24：校园网常有连续公网出口池，按前缀松一点
  const a = ipv4ToLong(visitorIp);
  const b = ipv4ToLong(ownPublicIp);
  if (a === null || b === null) return false; // IPv6 等暂不猜
  const mask = 0xffffff00;
  return (a & mask) === (b & mask);
}

router.get('/lan', async (req, res) => {
  const lan = pickLanAddress();
  // macOS 的 hostname 常已带 .local 后缀，先剥掉再统一拼，避免 .local.local
  const hostname = String(os.hostname() || '').toLowerCase().replace(/\.local$/i, '').replace(/\.$/, '');
  const visitorIp = visitorPublicIp(req);
  const ownPublicIp = await getOwnPublicIp();
  const visitorOnIntranet = visitorLooksIntranet(visitorIp, ownPublicIp);
  res.json({
    ok: Boolean(lan),
    lanIp: lan ? lan.address : null,
    lanInterface: lan ? lan.name : null,
    lanPort: LAN_HTTPS_PORT,
    mdnsHost: hostname ? `${hostname}.local` : null,
    visitorOnIntranet,
    visitorIp: visitorIp && /^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(visitorIp)
      ? visitorIp
      : (visitorIp ? visitorIp : null), // 透传给前端便于排查（私网/公网均非敏感拓扑机密，仅出口地址）
    sitePublicIp: ownPublicIp,
    reportedAt: new Date().toISOString(),
  });
});

module.exports = router;
