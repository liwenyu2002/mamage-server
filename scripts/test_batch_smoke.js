// 批量矩阵生成冒烟测试：不起 HTTP，直接函数级调用——建 1 个 batch + 2 个渠道 job → worker 跑完 →
// 断言两个 job 均 succeeded 且按 GET /batches/:id 同款口径汇总为 succeeded。
// 覆盖点：channel_key 驱动的渠道模板注入（options.channelTemplate）、ai_results 落库、
// mock 模式（本地无 AI_TEXT_API_KEY）下矩阵生成链路整体可跑通。
//
// 前置：本地 MySQL 已跑过 npm run db:migrate 与 node scripts/seed_channel_templates.js。
// 用法：AI_TEXT_ALLOW_MOCK=1 node scripts/test_batch_smoke.js

try {
  const path = require('path');
  require('dotenv').config({ path: path.resolve(__dirname, '..', '.env') });
} catch (e) {}

if (process.env.AI_TEXT_ALLOW_MOCK !== '1') {
  console.error('[test_batch_smoke] 需要 AI_TEXT_ALLOW_MOCK=1（本地无 AI_TEXT_API_KEY 时用 mock 生成，避免误打真实模型 API）');
  process.exit(1);
}

const assert = require('assert');
const { pool } = require('../db');
const { getActiveTemplates } = require('../lib/channel_templates');
const { runJobNow } = require('../lib/ai_job_worker');
const { assemblePrompt, buildFactCheck } = require('../routes/ai_news.js');

const TEST_CHANNELS = ['wechat_article', 'xiaohongshu'];

const FORM = {
  eventName: '冒烟测试活动',
  eventDate: '2026-07-11',
  location: '测试场地',
  organizer: '测试主办方',
  participants: '测试参与者',
  highlights: '测试亮点',
  usage: '内部测试',
  tone: '正式',
  targetWords: '500',
};

async function main() {
  const templates = await getActiveTemplates();
  const byKey = new Map(templates.map((t) => [t.channel_key, t]));
  TEST_CHANNELS.forEach((key) => {
    if (!byKey.has(key)) {
      throw new Error(`渠道模板 ${key} 不存在，请先跑 node scripts/seed_channel_templates.js`);
    }
  });

  const [batchInsert] = await pool.query(
    'INSERT INTO ai_job_batches (user_id, project_id, form_snapshot, selected_photo_ids, status, created_at) VALUES (?, ?, ?, ?, ?, NOW())',
    [null, null, JSON.stringify(FORM), JSON.stringify([]), 'pending']
  );
  const batchId = batchInsert.insertId;

  const jobIds = [];
  try {
    for (const channelKey of TEST_CHANNELS) {
      const template = byKey.get(channelKey);
      // 与 POST /generate/batch 同款拼装方式：channelName 触发新格式分支，maxTokens 取渠道默认值
      const prompt = assemblePrompt(FORM, [], '', '', { channelName: template.name, orgPreset: null });
      const [jobInsert] = await pool.query(
        'INSERT INTO ai_jobs (user_id, project_id, status, model, prompt_text, options, client_request_id, batch_id, channel_key, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NOW())',
        [null, null, 'pending', 'default', prompt, JSON.stringify({ maxTokens: template.default_max_tokens }), null, batchId, channelKey]
      );
      jobIds.push(jobInsert.insertId);
    }

    // runJobNow 直接 await processJob，跳过 enqueueJob 的 setImmediate，测试需要确定性等待完成
    await Promise.all(jobIds.map((id) => runJobNow(id)));

    const [jobRows] = await pool.query('SELECT * FROM ai_jobs WHERE batch_id = ? ORDER BY id ASC', [batchId]);
    assert.strictEqual(jobRows.length, TEST_CHANNELS.length, `应生成 ${TEST_CHANNELS.length} 个 job`);

    jobRows.forEach((job) => {
      assert.strictEqual(job.status, 'succeeded', `job ${job.id}（渠道 ${job.channel_key}）应为 succeeded，实际 ${job.status}：${job.error || ''}`);
    });

    // 与 GET /batches/:id 相同的汇总口径：全 succeeded → succeeded
    const statuses = jobRows.map((j) => j.status);
    const aggregated = statuses.every((s) => s === 'succeeded') ? 'succeeded' : 'partial';
    assert.strictEqual(aggregated, 'succeeded', 'batch 汇总状态应为 succeeded');

    for (const job of jobRows) {
      const [resRows] = await pool.query('SELECT * FROM ai_results WHERE job_id = ? ORDER BY id DESC LIMIT 1', [job.id]);
      assert.ok(resRows && resRows[0], `job ${job.id} 应有 ai_results 行`);
      assert.ok(resRows[0].markdown && String(resRows[0].markdown).trim(), `job ${job.id} 的 markdown 不应为空`);
    }

    console.log(`[test_batch_smoke] PASS: batch ${batchId} 两渠道（${TEST_CHANNELS.join('、')}）均 succeeded，batch 汇总 succeeded`);

    // factCheck 集成断言：与 GET /batches/:batchId 同一份 buildFactCheck，构造一篇正文日期与表单 eventDate
    // 不符的稿件（mock 生成的稿件里没有日期，无法覆盖这条路径，所以这里直接喂一段带错误日期的 markdown），
    // 断言能报出对应的 date issue，覆盖"事实校验已经挂进查询链路"这件事，而不是重复测 news_fact_check 本身的规则。
    const mismatchMarkdown = '# 测试标题\n\n导语：活动于2026年7月12日举行。\n\n正文：内容略。';
    const factCheck = buildFactCheck({
      markdown: mismatchMarkdown,
      formSnapshot: { ...FORM, selectedPhotos: [] }, // FORM.eventDate = '2026-07-11'，与正文的 7月12日 不符
      personNames: [],
      forbiddenWords: [],
    });
    assert.ok(factCheck.issues.length > 0, 'factCheck.issues 应非空（正文日期与表单不符）');
    assert.ok(factCheck.issues.some((i) => i.type === 'date'), 'issues 中应包含 date 类型的不符项');
    console.log('[test_batch_smoke] PASS: buildFactCheck 对日期不符的稿件报出非空 issues');

    const jobIdList = jobRows.map((j) => j.id);
    if (jobIdList.length) {
      await pool.query('DELETE FROM ai_results WHERE job_id IN (?)', [jobIdList]);
      await pool.query('DELETE FROM ai_jobs WHERE id IN (?)', [jobIdList]);
    }
  } finally {
    await pool.query('DELETE FROM ai_job_batches WHERE id = ?', [batchId]);
  }
}

main()
  .catch((err) => {
    console.error('[test_batch_smoke] FAIL:', err && err.stack ? err.stack : err);
    process.exitCode = 1;
  })
  .finally(async () => {
    try { await pool.end(); } catch (e) {}
  });
