const express = require('express');
const router = express.Router();
const { pool, buildUploadUrl } = require('../db');
const { enqueueJob, runJobNow } = require('../lib/ai_job_worker');
const { generateFromPrompt } = require('../ai_function/ai_for_news/ai_for_news');
const { requirePermission } = require('../lib/permissions');
const { renderNewsPreviewPng } = require('../lib/news_preview_renderer');

// basic size limits
const MAX_REFERENCE_CHARS = 20000;
const MAX_FULLPROMPT_CHARS = 100000;
const MAX_PHOTOS = 30;
const MAX_PREVIEW_HTML_CHARS = 300000;

function toNameList(input) {
  if (!input) return [];
  const raw = Array.isArray(input) ? input : String(input).split(/[;,|]/);
  const out = [];
  raw.forEach((v) => {
    const s = String(v || '').trim();
    if (!s) return;
    if (out.includes(s)) return;
    out.push(s);
  });
  return out;
}

function extractPersonNames(photo) {
  const direct = toNameList(
    (photo && (
      photo.faceNames
      || photo.personNames
      || photo.personNameList
      || photo.face_name_list
      || photo.person_name_list
      || photo.people
    )) || []
  );
  if (direct.length) return direct;

  const faces = Array.isArray(photo && photo.faces) ? photo.faces : [];
  const names = [];
  faces.forEach((f) => {
    const name = String((f && (f.personName || f.person_name || f.name || f.label)) || '').trim();
    if (!name) return;
    if (names.includes(name)) return;
    names.push(name);
  });
  return names;
}

function assemblePrompt(form, selectedPhotos, referenceArticle, interviewText, options) {
  const lines = [];
  lines.push(`活动名称：${form.eventName || ''}`);
  lines.push(`时间：${form.eventDate || ''}`);
  lines.push(`地点：${form.location || ''}`);
  lines.push(`主办：${form.organizer || ''}`);
  lines.push(`参与：${form.participants || ''}`);
  lines.push(`亮点：${form.highlights || ''}`);
  lines.push(`用途：${form.usage || ''}；文风：${form.tone || ''}；目标字数：${form.targetWords || ''}`);

  if (selectedPhotos && selectedPhotos.length) {
    lines.push('\n已选图片：');
    selectedPhotos.slice(0, MAX_PHOTOS).forEach((p, idx) => {
      const desc = p.description || '';
      const tags = Array.isArray(p.tags) ? p.tags.join(',') : '';
      const projectTitle = p.projectTitle || p.project || '';
      const personNames = extractPersonNames(p);
      const peoplePart = personNames.length ? ` (人物:${personNames.join('、')})` : '';
      lines.push(`图${idx + 1}：${desc} (tags:${tags}) (projectTitle:${projectTitle})${peoplePart} -> 占位符 PHOTO:${p.id} (thumb provided)`);
    });
    lines.push('说明：仅使用 PHOTO:<id> 作为图片占位符，不要在正文中输出真实图片 URL。');
    lines.push('说明：可以参考 projectTitle 把握语气与主题，但不要把它当成事实来源直接写入。');
    lines.push('要求：正文中以内嵌方式插入图片，格式必须是 ![图题](PHOTO:<id>)。');
    lines.push('要求：图题为一句话，不超过 20 字，仅描述画面，不包含具体事实信息。');
  }

  if (referenceArticle) {
    lines.push('\n参考资料：');
    lines.push(referenceArticle.slice(0, MAX_REFERENCE_CHARS));
    lines.push('注意：参考资料仅用于学习结构与文风，不可直接引用其中的具体事实。');
  }

  if (interviewText) {
    lines.push('\n采访记录：');
    lines.push(interviewText.slice(0, 5000));
  }

  lines.push('\n请根据以上信息生成一篇新闻稿，包含标题、导语、正文；在正文中按需插入 PHOTO: 占位符；遵守目标字数与文风要求；输出 Markdown。');
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

// POST /api/ai/news/render-preview
// Render HTML preview on backend and return PNG bytes.
router.post('/render-preview', requirePermission('ai.generate'), async (req, res) => {
  try {
    const body = req.body || {};
    const html = String(body.html || '').trim();
    if (!html) {
      return res.status(400).json({ code: 4002, message: 'html is required' });
    }
    if (html.length > MAX_PREVIEW_HTML_CHARS) {
      return res.status(413).json({
        code: 4133,
        message: 'preview html too large',
        details: { field: 'html', max: MAX_PREVIEW_HTML_CHARS },
      });
    }

    const width = Number(body.width);
    const height = Number(body.height);
    const inferredBaseHref = `${req.protocol}://${req.get('host')}/`;
    const baseHref = body.baseHref || inferredBaseHref;

    const png = await renderNewsPreviewPng({
      html,
      width,
      height,
      baseHref,
      authHeader: req.get('authorization') || '',
    });

    res.setHeader('Content-Type', 'image/png');
    res.setHeader('Cache-Control', 'no-store');
    return res.status(200).send(png);
  } catch (e) {
    const code = e && e.code ? String(e.code) : '';
    if (code === 'PREVIEW_RENDERER_NOT_INSTALLED') {
      return res.status(501).json({
        code: 5011,
        message: 'preview renderer not installed: run `npm i playwright` and `npx playwright install chromium`',
      });
    }
    if (code === 'PREVIEW_RENDERER_BROWSER_MISSING') {
      return res.status(501).json({
        code: 5012,
        message: 'preview browser missing: run `npx playwright install chromium`',
      });
    }
    if (code === 'PREVIEW_RENDERER_SYSTEM_BROWSER_FAILED') {
      return res.status(500).json({
        code: 5002,
        message: String(e && e.message ? e.message : 'system chromium launch failed'),
      });
    }
    console.error('POST /api/ai/news/render-preview error', e);
    return res.status(500).json({ code: 5001, message: 'preview render failed' });
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

    const [insertResult] = await pool.query(
      'INSERT INTO ai_jobs (user_id, project_id, status, model, prompt_text, options, client_request_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, NOW())',
      [req.user && req.user.id ? req.user.id : null, projectId, 'pending', options.model || 'default', prompt, JSON.stringify(options || {}), clientRequestId || null]
    );

    const jobId = insertResult.insertId;

    if (sync) {
      try {
        await pool.query('UPDATE ai_jobs SET status = ?, started_at = NOW() WHERE id = ?', ['running', jobId]);
        const result = await generateFromPrompt({ prompt, options });

        await pool.query(
          'INSERT INTO ai_results (job_id, title, subtitle, markdown, html, placeholders, created_at) VALUES (?, ?, ?, ?, ?, ?, NOW())',
          [jobId, result.title, result.subtitle, result.markdown, result.html, JSON.stringify(result.placeholders || [])]
        );
        await pool.query(
          'UPDATE ai_jobs SET status = ?, finished_at = NOW(), tokens_used = ?, cost_estimate = ? WHERE id = ?',
          ['succeeded', result.tokens || 0, result.cost || 0, jobId]
        );

        const photos = Array.isArray(result.placeholders)
          ? result.placeholders
          : (result.placeholders ? JSON.parse(result.placeholders) : []);
        const onePot = { markdown: result.markdown, photos };
        return res.json({ jobId, status: 'succeeded', result: onePot });
      } catch (e) {
        console.error('sync generate error', e);
        await pool.query('UPDATE ai_jobs SET status = ?, error = ?, finished_at = NOW() WHERE id = ?', ['failed', String(e && e.message || e), jobId]);
        return res.status(500).json({ jobId, status: 'failed', error: 'generation failed' });
      }
    }

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

    let photos = [];
    if (result && result.placeholders) {
      try {
        photos = JSON.parse(result.placeholders);
      } catch (e) {
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
