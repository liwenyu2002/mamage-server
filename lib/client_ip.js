// 客户端真实 IP 提取（用于限速/冷却等安全控件）：
// - 走 Cloudflare Tunnel 的流量：信 CF-Connecting-IP（CF 边缘生成，不可伪造）
// - 走自家 nginx 直连的流量：信 x-forwarded-for 的【末段】——我们的 nginx 把真实
//   remote_addr 追加在最后；首段是客户端自带值，可任意伪造，不能用于安全控件
// - 直连 node：socket 地址
function clientIpFromReq(req) {
  const cf = req.headers && req.headers['cf-connecting-ip'];
  if (cf) return String(cf).split(',')[0].trim();
  const xff = req.headers && req.headers['x-forwarded-for'];
  if (xff) {
    const parts = String(xff).split(',').map((s) => s.trim()).filter(Boolean);
    if (parts.length) return parts[parts.length - 1];
  }
  return (req.socket && req.socket.remoteAddress)
    ? String(req.socket.remoteAddress).replace(/^::ffff:/, '')
    : 'unknown';
}

module.exports = { clientIpFromReq };
