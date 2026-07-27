#!/usr/bin/env node
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

require('dotenv').config({ path: path.resolve(__dirname, '..', '.env') });

const errors = [];
const requiredStorage = ['COS_SECRET_ID', 'COS_SECRET_KEY', 'COS_BUCKET', 'COS_BASE_URL'];
requiredStorage.forEach((name) => {
  if (!String(process.env[name] || '').trim()) errors.push(`缺少 ${name}`);
});
if (String(process.env.MEDIA_URL_SIGNING || '') !== '1') errors.push('MEDIA_URL_SIGNING 必须设为 1');
if (!String(process.env.MEDIA_URL_SECRET || process.env.JWT_SECRET || '').trim()) errors.push('缺少 MEDIA_URL_SECRET 或 JWT_SECRET');

const workDir = String(process.env.VIDEO_WORK_DIR || '').trim();
if (!workDir) {
  errors.push('缺少 VIDEO_WORK_DIR');
} else if (!path.isAbsolute(workDir)) {
  errors.push('VIDEO_WORK_DIR 必须是绝对路径');
} else {
  const deployRoot = path.resolve(__dirname, '..');
  const resolvedWorkDir = path.resolve(workDir);
  if (resolvedWorkDir === deployRoot || resolvedWorkDir.startsWith(`${deployRoot}${path.sep}`)) {
    errors.push('VIDEO_WORK_DIR 不能位于代码部署目录内');
  } else {
    try {
      fs.mkdirSync(resolvedWorkDir, { recursive: true });
      fs.accessSync(resolvedWorkDir, fs.constants.R_OK | fs.constants.W_OK);
    } catch (error) {
      errors.push(`VIDEO_WORK_DIR 不可读写：${error.message}`);
    }
  }
}

function verifyBinary(envName, fallback) {
  const binary = String(process.env[envName] || fallback).trim();
  const result = spawnSync(binary, ['-version'], { encoding: 'utf8', timeout: 15000 });
  if (result.error || result.status !== 0) errors.push(`${envName} 不可用：${binary}`);
  else console.log(`[video:validate] ${envName}: ${String(result.stdout || '').split(/\r?\n/)[0]}`);
}

verifyBinary('FFMPEG_PATH', 'ffmpeg');
verifyBinary('FFPROBE_PATH', 'ffprobe');

if (String(process.env.VIDEO_AI_REQUIRE_MODEL || '1') === '1') {
  const apiKey = process.env.AI_TEXT_API_KEY || process.env.OPENAI_API_KEY;
  const model = process.env.AI_VIDEO_MODEL || process.env.AI_TEXT_MODEL || process.env.OPENAI_MODEL;
  if (!apiKey) errors.push('缺少 AI_TEXT_API_KEY 或 OPENAI_API_KEY，无法保证生产 AI 编排');
  if (!model) errors.push('缺少 AI_VIDEO_MODEL、AI_TEXT_MODEL 或 OPENAI_MODEL');
}

if (errors.length) {
  console.error('[video:validate] 生产视频能力检查失败：');
  errors.forEach((error) => console.error(`  - ${error}`));
  process.exit(1);
}

console.log('[video:validate] 对象存储、临时目录、FFmpeg 与 AI 配置检查通过');
