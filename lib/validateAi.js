const { OpenAI } = require('openai');

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
  // DashScope or other vision providers
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
    if (resp && resp.choices && resp.choices[0] && resp.choices[0].message) return { ok: true };
    return { ok: false, reason: 'no-response' };
  } catch (e) {
    return { ok: false, reason: e && e.message ? e.message : String(e) };
  }
}

async function validateAll() {
  const result = {};
  result.text = await validateTextModel();
  result.vision = await validateVisionModel();
  return result;
}

module.exports = { validateAll, validateTextModel, validateVisionModel };
