const express = require('express');
const router = express.Router();
const { pool, buildUploadUrl } = require('../db');
const { enqueueJob, runJobNow } = require('../lib/ai_job_worker');
const { generateFromPrompt } = require('../ai_function/ai_for_news/ai_for_news');
const { requirePermission } = require('../lib/permissions');

// basic size limits
const MAX_REFERENCE_CHARS = 20000;
const MAX_FULLPROMPT_CHARS = 100000;
const MAX_PHOTOS = 30;

function assemblePrompt(form, selectedPhotos, referenceArticle, interviewText, options) {
  const lines = [];
  lines.push(`活动名称：${form.eventName || ''}`);
  lines.push(`时间：${form.eventDate || ''}`);
  lines.push(`地点：${form.location || ''}`);
  lines.push(`主办：${form.organizer || ''}`);
  lines.push(`参与：${form.participants || ''}`);
  lines.push(`亮点：${form.highlights || ''}`);
  lines.push(`用途：${form.usage || ''}；文风：${form.tone || ''}; 目标字数：${form.targetWords || ''}`);

  if (selectedPhotos && selectedPhotos.length) {
    lines.push('\n已选图片：');
    selectedPhotos.slice(0, MAX_PHOTOS).forEach((p, idx) => {
      const desc = p.description || '';
      const tags = Array.isArray(p.tags) ? p.tags.join(',') : '';
      const thumb = p.thumbUrl || '';
      const projectTitle = p.projectTitle || p.project || '';
      // include thumbnail reference note and project title as reference info
      lines.push(`图${idx+1}：${desc} (tags:${tags}) (projectTitle:${projectTitle}) -> 占位符 PHOTO:${p.id} (thumb provided)`);
    });
    // 说明：前端仅提供缩略图链接（thumbUrl）与图片 id；请仅使用占位符代表缩略图，勿在文中生成或插入任何图片 URL。
    // 图片的 projectTitle 也作为参考信息之一，可用于把握语气与主题，但不得作为事实性信息直接引用。
    // 要求：在正文中以一行形式内嵌图片占位，采用 Markdown 图片语法，格式必须严格为：![图题](PHOTO:<id>)。
    // 其中“图题”为一句话（不超过20字），仅描述画面或意境，不得包含地点、时间、人物姓名或具体数字等事实信息。
    // 示例：段落内容……\n![学生在操场进行体能测试](PHOTO:123)\n段落继续……
    // 注意：不要在文末重复列出所有图片；图片占位应仅代表缩略图并以内嵌形式出现在正文中。
  }

  if (referenceArticle) {
    lines.push('\n参考资料：');
    lines.push(referenceArticle.slice(0, MAX_REFERENCE_CHARS));
    // 指示：只把参考资料作为格式与文风的示例使用，不要采纳其中的事实信息
    lines.push('注意：以下参考资料仅供格式与文风参考，请勿引用或采纳其中的具体事实信息（例如地点、时间、人物、事件或具体数字）。仅模仿文本的结构、句式与表达风格。');
  }

  if (interviewText) {
    lines.push('\n采访记录：');
    lines.push(interviewText.slice(0, 5000));
  }

  lines.push('\n请根据以上信息生成一篇新闻稿，包含标题/导语/正文，正文中适当插入 PHOTO: 占位符，遵循目标字数和文风。输出 Markdown 格式。');

  return lines.join('\n');
}

// POST /api/ai/news/preview
router.post('/preview', requirePermission('ai.generate'), async (req, res) => {
  try {
    const body = req.body || {};
    const fullPrompt = body.fullPrompt;
    if (fullPrompt) return res.json({ assembledPrompt: String(fullPrompt).slice(0, MAX_FULLPROMPT_CHARS) });

    const form = body.form || {};
    const selectedPhotos = Array.isArray(body.selectedPhotos) ? body.selectedPhotos : [];
    const referenceArticle = body.referenceArticle || '';
    const interviewText = body.interviewText || '';

    if (referenceArticle && referenceArticle.length > MAX_REFERENCE_CHARS) {
      return res.status(413).json({ code: 4131, message: 'referenceArticle too large', details: { field: 'referenceArticle', max: MAX_REFERENCE_CHARS } });
    }

    const assembled = assemblePrompt(form, selectedPhotos, referenceArticle, interviewText, body.options || {});
    res.json({ assembledPrompt: assembled });
  } catch (e) {
    console.error('POST /api/ai/news/preview error', e);
    res.status(500).json({ code: 5000, message: 'Internal server error' });
  }
});

// POST /api/ai/news/generate
router.post('/generate', requirePermission('ai.generate'), async (req, res) => {
  try {
    const body = req.body || {};
    const projectId = body.projectId || null;
    const clientRequestId = body.clientRequestId || null;
    const options = body.options || {};
    const sync = (req.query && req.query.sync === 'true') || options.sync || false;

    let prompt = '';
    if (body.fullPrompt) {
      if (String(body.fullPrompt).length > MAX_FULLPROMPT_CHARS) {
        return res.status(413).json({ code: 4132, message: 'fullPrompt too large' });
      }
      prompt = String(body.fullPrompt);
    } else {
      const form = body.form || {};
      const selectedPhotos = Array.isArray(body.selectedPhotos) ? body.selectedPhotos : [];
      const referenceArticle = body.referenceArticle || '';
      const interviewText = body.interviewText || '';

      if (referenceArticle && referenceArticle.length > MAX_REFERENCE_CHARS) {
        return res.status(413).json({ code: 4131, message: 'referenceArticle too large', details: { field: 'referenceArticle', max: MAX_REFERENCE_CHARS } });
      }

      prompt = assemblePrompt(form, selectedPhotos, referenceArticle, interviewText, options);
    }

    // insert job into DB
    const [insertResult] = await pool.query(`INSERT INTO ai_jobs (user_id, project_id, status, model, prompt_text, options, client_request_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, NOW())`,
      [req.user && req.user.id ? req.user.id : null, projectId, 'pending', options.model || 'default', prompt, JSON.stringify(options || {}), clientRequestId || null]
    );

    const jobId = insertResult.insertId;

    if (sync) {
      // run immediately and return result when done (blocking)
      try {
        await pool.query('UPDATE ai_jobs SET status = ?, started_at = NOW() WHERE id = ?', ['running', jobId]);
        const result = await generateFromPrompt({ prompt, options });

        // store result (placeholders stored as JSON)
        await pool.query(`INSERT INTO ai_results (job_id, title, subtitle, markdown, html, placeholders, created_at) VALUES (?, ?, ?, ?, ?, ?, NOW())`,
          [jobId, result.title, result.subtitle, result.markdown, result.html, JSON.stringify(result.placeholders || [])]
        );
        await pool.query('UPDATE ai_jobs SET status = ?, finished_at = NOW(), tokens_used = ?, cost_estimate = ? WHERE id = ?', ['succeeded', result.tokens || 0, result.cost || 0, jobId]);

        // Return a single "one-pot" payload: markdown + photos (front-end will use markdown + photos only)
        const photos = Array.isArray(result.placeholders) ? result.placeholders : (result.placeholders ? JSON.parse(result.placeholders) : []);
        const onePot = { markdown: result.markdown, photos };
        return res.json({ jobId, status: 'succeeded', result: onePot });
      } catch (e) {
        console.error('sync generate error', e);
        await pool.query('UPDATE ai_jobs SET status = ?, error = ?, finished_at = NOW() WHERE id = ?', ['failed', String(e && e.message || e), jobId]);
        return res.status(500).json({ jobId, status: 'failed', error: 'generation failed' });
      }
    }

    // async: enqueue and return 202
    await enqueueJob(jobId);
    res.status(202).json({ jobId, status: 'pending', estimatedSeconds: 5 });
  } catch (e) {
    console.error('POST /api/ai/news/generate error', e);
    res.status(500).json({ code: 5000, message: 'Internal server error' });
  }
});

// GET /api/ai/news/jobs/:jobId
router.get('/jobs/:jobId', requirePermission('ai.generate'), async (req, res) => {
  try {
    const id = parseInt(req.params.jobId, 10);
    if (!id) return res.status(400).json({ code: 4001, message: 'invalid job id' });
    const [rows] = await pool.query('SELECT * FROM ai_jobs WHERE id = ?', [id]);
    if (!rows || rows.length === 0) return res.status(404).json({ code: 4041, message: 'job not found' });
    const job = rows[0];
    const [resRows] = await pool.query('SELECT * FROM ai_results WHERE job_id = ? ORDER BY id DESC LIMIT 1', [id]);
    const result = resRows && resRows[0] ? resRows[0] : null;

    // Build one-pot result: markdown + photos array parsed from placeholders
    let photos = [];
    if (result && result.placeholders) {
      try {
        photos = JSON.parse(result.placeholders);
      } catch (e) {
        // fallback: if placeholders is already an array-like string, leave empty
        photos = [];
      }
    }
    res.json({
      jobId: job.id,
      status: job.status,
      progress: job.status === 'running' ? 0.5 : (job.status === 'succeeded' ? 1 : 0),
      startedAt: job.started_at,
      finishedAt: job.finished_at,
      result: result ? { markdown: result.markdown, photos } : null,
      error: job.error || null
    });
  } catch (e) {
    console.error('GET /api/ai/news/jobs/:jobId error', e);
    res.status(500).json({ code: 5000, message: 'Internal server error' });
  }
});

module.exports = router;
