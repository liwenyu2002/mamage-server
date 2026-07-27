const { OpenAI } = require('openai');
const http = require('http');
const https = require('https');

function withTimeout(p, ms) {
  return Promise.race([
    p,
    new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), ms))
  ]);
}

async function validateTextModel() {
  const key = process.env.AI_TEXT_API_KEY || process.env.OPENAI_API_KEY;
  const model = process.env.AI_TEXT_MODEL || process.env.OPENAI_MODEL || null;
  if (!key) return { ok: false, reason: 'no-key' };
  if (!model) return { ok: false, reason: 'no-model' };

  try {
    // allow DashScope / Model Studio compatible endpoint via DASHSCOPE_BASE_URL
    const baseURL = process.env.DASHSCOPE_BASE_URL || process.env.AI_TEXT_BASE_URL || undefined;
    const client = baseURL ? new OpenAI({ apiKey: key, baseURL }) : new OpenAI({ apiKey: key });
    // lightweight call: request 1 token
    const resp = await withTimeout(client.chat.completions.create({
      model: model,
      messages: [{ role: 'system', content: 'You are a validator. Reply with ok.' }, { role: 'user', content: 'test' }],
      max_tokens: 1,
      temperature: 0
    }), 5000);
    if (resp && resp.choices && resp.choices[0] && resp.choices[0].message) {
      return { ok: true };
    }
    return { ok: false, reason: 'no-response' };
  } catch (e) {
    return { ok: false, reason: e && e.message ? e.message : String(e) };
  }
}

async function validateVisionModel() {
  const provider = String(process.env.AI_VISION_PROVIDER || 'dashscope').trim().toLowerCase();
  if (provider === 'ollama' || provider === 'local' || provider === 'qwen' || provider === 'qwen-local') {
    return validateOllamaVisionModel();
  }
  if (provider === 'off' || provider === 'disabled' || provider === 'none') {
    return { ok: true, provider: 'off' };
  }

  // DashScope or other OpenAI-compatible vision providers.
  const key = process.env.AI_VISION_API_KEY || process.env.DASHSCOPE_API_KEY;
  const model = process.env.AI_VISION_MODEL || null;
  if (!key) return { ok: false, reason: 'no-key' };
  if (!model) return { ok: false, reason: 'no-model' };

  try {
    const client = new OpenAI({ apiKey: key, baseURL: process.env.DASHSCOPE_BASE_URL || 'https://dashscope.aliyuncs.com/compatible-mode/v1' });
    // Some vision models may require image inputs; we do a minimal chat call to validate auth/model.
    const resp = await withTimeout(client.chat.completions.create({
      model: model,
      messages: [{ role: 'system', content: 'You are a validator. Respond concisely.' }, { role: 'user', content: 'ping' }],
      max_tokens: 1,
      temperature: 0
    }), 5000);
    if (resp && resp.choices && resp.choices[0] && resp.choices[0].message) return { ok: true, provider: 'dashscope', model };
    return { ok: false, reason: 'no-response' };
  } catch (e) {
    return { ok: false, reason: e && e.message ? e.message : String(e) };
  }
}

function fetchJson(url, timeoutMs) {
  return new Promise((resolve, reject) => {
    try {
      const u = new URL(url);
      const lib = u.protocol === 'https:' ? https : http;
      const req = lib.get(u, { timeout: timeoutMs }, (res) => {
        const chunks = [];
        res.on('data', (chunk) => chunks.push(chunk));
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8');
          if (res.statusCode < 200 || res.statusCode >= 300) {
            reject(new Error(`HTTP ${res.statusCode}: ${text.slice(0, 500)}`));
            return;
          }
          try {
            resolve(JSON.parse(text));
          } catch (e) {
            reject(new Error('Invalid JSON response'));
          }
        });
      });
      req.on('timeout', () => req.destroy(new Error('timeout')));
      req.on('error', reject);
    } catch (e) {
      reject(e);
    }
  });
}

async function validateOllamaVisionModel() {
  const baseUrl = String(process.env.OLLAMA_BASE_URL || 'http://127.0.0.1:11434').replace(/\/+$/, '');
  const model = process.env.OLLAMA_VISION_MODEL || process.env.LOCAL_VISION_MODEL || 'qwen2.5vl:3b';
  try {
    const data = await withTimeout(fetchJson(`${baseUrl}/api/tags`, 5000), 6000);
    const models = Array.isArray(data && data.models) ? data.models : [];
    const found = models.some((m) => m && (m.name === model || m.model === model));
    if (!found) return { ok: false, provider: 'ollama', model, reason: 'model-not-found' };
    return { ok: true, provider: 'ollama', model };
  } catch (e) {
    return { ok: false, provider: 'ollama', model, reason: e && e.message ? e.message : String(e) };
  }
}

async function validateAll() {
  const result = {};
  result.text = await validateTextModel();
  result.vision = await validateVisionModel();
  return result;
}

module.exports = { validateAll, validateTextModel, validateVisionModel };
