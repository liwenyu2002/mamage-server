const express = require('express');
const { requirePermission } = require('../lib/permissions');
const { generateRoughCut } = require('../ai_function/ai_for_video/ai_for_video');

const router = express.Router();

router.post('/rough-cut', requirePermission('ai.generate'), async (req, res) => {
  try {
    const result = await generateRoughCut(req.body || {});
    res.json(result);
  } catch (error) {
    console.error('POST /api/ai/video/rough-cut error:', error && error.stack ? error.stack : error);
    res.status(error.status || 500).json({
      error: error.status === 400 ? 'INVALID_VIDEO_SOURCES' : 'VIDEO_ROUGH_CUT_FAILED',
      message: error && error.message ? error.message : '生成粗剪方案失败',
    });
  }
});

module.exports = router;
