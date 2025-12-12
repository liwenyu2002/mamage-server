// scripts/test_ai_text_model.js
require('dotenv').config();
const { generateFromPrompt } = require('../ai_function/ai_for_news/ai_for_news');

async function main() {
  try {
    const prompt = '活动名称：测试活动\n时间：今天\n地点：校园礼堂\n请写一段约 100 字的新闻稿，要求严肃、新闻口吻。';
    console.log('[test_ai_text_model] running generateFromPrompt (may use mock if no key)');
    const res = await generateFromPrompt({ prompt, options: {} });
    console.log('=> result.title:', res.title);
    console.log('=> result.markdown (first 400 chars):\n', res.markdown && res.markdown.slice(0, 400));
    // Let Node exit naturally so background handles (sockets/timers) can close cleanly.
    return;
  } catch (e) {
    console.error(e && e.stack ? e.stack : e);
    // Return with non-zero code by rethrowing so the process exits with failure.
    throw e;
  }
}

main();
