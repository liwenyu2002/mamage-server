const https = require('https');
const dns = require('dns').promises;
const net = require('net');

function isPublicIp(address) {
  const version = net.isIP(address);
  if (version === 4) {
    const [a, b] = address.split('.').map(Number);
    return a !== 0 && a !== 10 && a !== 127 && a < 224
      && !(a === 100 && b >= 64 && b <= 127)
      && !(a === 169 && b === 254)
      && !(a === 172 && b >= 16 && b <= 31)
      && !(a === 192 && (b === 0 || b === 88 || b === 168))
      && !(a === 198 && (b === 18 || b === 19 || b === 51))
      && !(a === 203 && b === 0 && Number(address.split('.')[2]) === 113);
  }
  if (version === 6) {
    const lower = address.toLowerCase();
    if (lower.includes('.')) return false;
    return (lower.startsWith('2') || lower.startsWith('3'))
      && !lower.startsWith('2001:db8') && !lower.startsWith('2001:0:') && !lower.startsWith('2001:10:');
  }
  return false;
}

function parsePublicHttpsUrl(value) {
  let url;
  try { url = new URL(String(value || '').trim()); } catch (_) { return null; }
  if (url.protocol !== 'https:' || url.username || url.password || url.port && url.port !== '443') return null;
  if (!url.hostname || url.hostname.includes(':') || net.isIP(url.hostname) || url.hostname === 'localhost' || url.hostname.endsWith('.local')) return null;
  return url;
}

async function resolvePublicHost(hostname) {
  let timer;
  let addresses;
  try {
    addresses = await Promise.race([
      dns.lookup(hostname, { all: true }),
      new Promise((_, reject) => { timer = setTimeout(() => reject(Object.assign(new Error('DNS timeout'), { code: 'SOURCE_TIMEOUT' })), 5000); }),
    ]);
  } finally { clearTimeout(timer); }
  if (!addresses.length || addresses.some((entry) => !isPublicIp(entry.address))) {
    throw Object.assign(new Error('Private address is not allowed'), { code: 'PRIVATE_ADDRESS' });
  }
  return addresses[0];
}

async function openPublicHttps(value, options = {}) {
  const url = parsePublicHttpsUrl(value);
  if (!url) throw Object.assign(new Error('Only public HTTPS URLs are supported'), { code: 'INVALID_SOURCE_URL' });
  const address = await resolvePublicHost(url.hostname);
  const timeoutMs = Number(options.timeoutMs) || 20000;
  const response = await new Promise((resolve, reject) => {
    const request = https.request(url, {
      method: options.method || 'GET',
      headers: { Accept: options.accept || '*/*', 'User-Agent': 'MaMage-ExternalImport/1.0' },
      lookup: (_host, lookupOptions, callback) => {
        const options = typeof lookupOptions === 'function' ? {} : lookupOptions;
        const done = typeof lookupOptions === 'function' ? lookupOptions : callback;
        if (options.all) done(null, [address]);
        else done(null, address.address, address.family);
      },
    }, resolve);
    request.setTimeout(timeoutMs, () => request.destroy(Object.assign(new Error('Source timeout'), { code: 'SOURCE_TIMEOUT' })));
    request.on('error', reject);
    request.end();
  });
  if (response.statusCode >= 300 && response.statusCode < 400) {
    response.resume();
    if ((options.redirects || 0) >= 2) throw Object.assign(new Error('Too many redirects'), { code: 'SOURCE_REDIRECT' });
    const next = new URL(String(response.headers.location || ''), url);
    return openPublicHttps(next.href, { ...options, redirects: (options.redirects || 0) + 1 });
  }
  return { response, url: url.href };
}

async function readLimitedText(stream, maxBytes = 2 * 1024 * 1024) {
  const chunks = [];
  let size = 0;
  for await (const chunk of stream) {
    size += chunk.length;
    if (size > maxBytes) {
      stream.destroy();
      throw Object.assign(new Error('Page too large'), { code: 'SOURCE_TOO_LARGE' });
    }
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString('utf8');
}

module.exports = { isPublicIp, parsePublicHttpsUrl, resolvePublicHost, openPublicHttps, readLimitedText };
