// 入口选择（公网/内网）支撑：后端就跑在 Mac Mini 上，实时上报自己当前的内网地址。
// DHCP 轮换 IP 也不怕——每次请求返回的都是当下值，前端入口页据此生成内网链接。
// 公开端点：返回的是 RFC1918 私网地址，外网拿到也连不上，无敏感信息。
const os = require('os');
const express = require('express');
const router = express.Router();

const LAN_HTTPS_PORT = Number(process.env.LAN_HTTPS_PORT || 3443);

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

router.get('/lan', (req, res) => {
  const lan = pickLanAddress();
  const hostname = String(os.hostname() || '').toLowerCase().replace(/\.$/, '');
  res.json({
    ok: Boolean(lan),
    lanIp: lan ? lan.address : null,
    lanInterface: lan ? lan.name : null,
    lanPort: LAN_HTTPS_PORT,
    mdnsHost: hostname ? `${hostname}.local` : null,
    reportedAt: new Date().toISOString(),
  });
});

module.exports = router;
