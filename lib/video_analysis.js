const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const sharp = require('sharp');
const {
  analyzeTemporalStoryboard,
  isVisionEnabled,
  summarizeTemporalTimeline,
} = require('../ai_function/ai_for_video/video_semantic');

const FFMPEG_PATH = process.env.FFMPEG_PATH || (fs.existsSync('/opt/homebrew/bin/ffmpeg') ? '/opt/homebrew/bin/ffmpeg' : 'ffmpeg');

function numberEnv(name, fallback, min, max) {
  const value = Number(process.env[name]);
  if (!Number.isFinite(value)) return fallback;
  return Math.max(min, Math.min(max, value));
}

function rounded(value, digits = 3) {
  const factor = 10 ** digits;
  return Math.round((Number(value) || 0) * factor) / factor;
}

function parseUniqueTimes(text, pattern, limit = 200) {
  const values = [];
  let match;
  while ((match = pattern.exec(text)) && values.length < limit) {
    const value = Number(match[1]);
    if (Number.isFinite(value) && (values.length === 0 || Math.abs(value - values[values.length - 1]) > 0.35)) values.push(value);
  }
  return values;
}

function runFfmpeg(args, timeoutMs = 180000) {
  return new Promise((resolve, reject) => {
    const child = spawn(FFMPEG_PATH, args, { stdio: ['ignore', 'ignore', 'pipe'] });
    let stderr = '';
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGKILL');
    }, timeoutMs);
    child.stderr.on('data', (chunk) => { stderr = (stderr + chunk.toString()).slice(-2 * 1024 * 1024); });
    child.on('error', (error) => { clearTimeout(timer); reject(error); });
    child.on('close', (code, signal) => {
      clearTimeout(timer);
      if (code === 0 || code === 255) resolve(stderr);
      else reject(new Error(timedOut || signal ? `素材分析超时（${signal || 'timeout'}）` : `FFmpeg 素材分析失败（${code}）：${stderr.slice(-600)}`));
    });
  });
}

function analysisTimeoutMs(duration, minimum = 120000, maximum = 20 * 60 * 1000) {
  return Math.max(minimum, Math.min(maximum, minimum + Math.ceil(Math.max(0, Number(duration) || 0) * 1500)));
}

function desiredSegmentCount(duration) {
  const targetSeconds = numberEnv('VIDEO_SEMANTIC_SEGMENT_SECONDS', 18, 4, 180);
  const maxSegments = Math.round(numberEnv('VIDEO_SEMANTIC_MAX_SEGMENTS', 18, 1, 48));
  if (duration <= 6) return 1;
  return Math.max(2, Math.min(maxSegments, Math.ceil(duration / targetSeconds)));
}

function buildTemporalBoundaries(duration, sceneTimes) {
  const segmentCount = desiredSegmentCount(duration);
  const span = duration / segmentCount;
  const boundaries = [0];
  const minDistance = Math.min(2, Math.max(0.35, span * 0.18));
  for (let index = 1; index < segmentCount; index += 1) {
    const ideal = index * span;
    const window = Math.max(1.5, span * 0.34);
    const nearest = (sceneTimes || [])
      .filter((time) => time > boundaries[boundaries.length - 1] + minDistance && time < duration - minDistance && Math.abs(time - ideal) <= window)
      .sort((left, right) => Math.abs(left - ideal) - Math.abs(right - ideal))[0];
    boundaries.push(nearest === undefined ? ideal : nearest);
  }
  boundaries.push(duration);
  return boundaries.map((value) => rounded(value)).filter((value, index, values) => index === 0 || value > values[index - 1] + 0.05);
}

function sampleTimesForSegment(start, end) {
  const duration = Math.max(0.05, end - start);
  const ratios = duration < 1.2 ? [0.5] : duration < 4 ? [0.25, 0.75] : [0.16, 0.5, 0.84];
  return Array.from(new Set(ratios.map((ratio) => rounded(Math.min(end - 0.03, Math.max(start + 0.03, start + duration * ratio))))));
}

async function detectSceneTimes(input, duration) {
  const maxScanSeconds = numberEnv('VIDEO_SEMANTIC_SCENE_SCAN_MAX_SECONDS', 1800, 10, 4 * 60 * 60);
  if (duration > maxScanSeconds) return { times: [], mode: 'uniform-temporal-sampling' };
  const threshold = numberEnv('VIDEO_SEMANTIC_SCENE_THRESHOLD', 0.32, 0.05, 0.95);
  try {
    const log = await runFfmpeg([
      '-hide_banner', '-loglevel', 'info', '-i', input,
      '-vf', `fps=1/2,select='gt(scene,${threshold})',showinfo`, '-an', '-f', 'null', '-',
    ], analysisTimeoutMs(duration));
    return { times: parseUniqueTimes(log, /pts_time:([0-9.]+)/g, 600), mode: 'shot-aware' };
  } catch (error) {
    console.warn('[video-analysis] scene pass fallback:', error && error.message ? error.message : error);
    return { times: [], mode: 'uniform-temporal-sampling' };
  }
}

async function detectSilences(input, duration) {
  const maxScanSeconds = numberEnv('VIDEO_SEMANTIC_AUDIO_SCAN_MAX_SECONDS', 4 * 60 * 60, 10, 12 * 60 * 60);
  const scanSeconds = Math.min(duration, maxScanSeconds);
  if (scanSeconds <= 0) return { silences: [], coverage: 0, mode: 'no-audio-scan' };
  try {
    const log = await runFfmpeg([
      '-hide_banner', '-loglevel', 'info', '-i', input, '-t', String(scanSeconds),
      '-af', 'silencedetect=noise=-35dB:d=0.7', '-vn', '-f', 'null', '-',
    ], analysisTimeoutMs(scanSeconds));
    const starts = parseUniqueTimes(log, /silence_start:\s*([0-9.]+)/g, 300);
    const ends = parseUniqueTimes(log, /silence_end:\s*([0-9.]+)/g, 300);
    return {
      silences: starts.map((start, index) => ({
        start: rounded(start),
        end: rounded(ends[index] !== undefined ? ends[index] : Math.min(scanSeconds, start + 0.7)),
      })).filter((silence) => silence.end > silence.start),
      coverage: scanSeconds,
      mode: scanSeconds < duration ? 'partial' : 'full',
    };
  } catch (_) {
    return { silences: [], coverage: 0, mode: 'unavailable' };
  }
}

async function captureFrame(input, time, targetPath) {
  await runFfmpeg([
    '-hide_banner', '-loglevel', 'error', '-y', '-ss', String(Math.max(0, time)), '-i', input,
    '-frames:v', '1', '-vf', 'scale=640:-2', '-q:v', '4', targetPath,
  ], 90000);
}

async function buildStoryboard(input, sampleTimes, frameDir, segmentIndex) {
  const paths = [];
  for (let index = 0; index < sampleTimes.length; index += 1) {
    const framePath = path.join(frameDir, `segment-${segmentIndex}-${index}.jpg`);
    try {
      await captureFrame(input, sampleTimes[index], framePath);
      paths.push(framePath);
    } catch (error) {
      console.warn('[video-analysis] frame extract failed:', rounded(sampleTimes[index]), error && error.message ? error.message : error);
    }
  }
  if (!paths.length) return null;
  try {
    const panelWidth = 320;
    const panelHeight = 200;
    const gap = 6;
    const panels = await Promise.all(paths.map((framePath) => sharp(framePath)
      .rotate()
      .resize(panelWidth, panelHeight, { fit: 'contain', background: { r: 14, g: 18, b: 26, alpha: 1 } })
      .flatten({ background: { r: 14, g: 18, b: 26 } })
      .jpeg({ quality: 84, mozjpeg: true })
      .toBuffer()));
    return sharp({
      create: {
        width: panels.length * panelWidth + Math.max(0, panels.length - 1) * gap,
        height: panelHeight,
        channels: 3,
        background: { r: 14, g: 18, b: 26 },
      },
    }).composite(panels.map((buffer, index) => ({ input: buffer, left: index * (panelWidth + gap), top: 0 })))
      .jpeg({ quality: 86, mozjpeg: true })
      .toBuffer();
  } finally {
    await Promise.all(paths.map((framePath) => fs.promises.rm(framePath, { force: true }).catch(() => null)));
  }
}

function genericSegmentSummary(segment) {
  return `第 ${segment.index + 1} 段（${rounded(segment.start, 1)}-${rounded(segment.end, 1)} 秒）`;
}

async function notifyProgress(callback, payload) {
  if (typeof callback !== 'function') return;
  try { await callback(payload); } catch (_) { /* Progress reporting cannot break analysis. */ }
}

async function analyzeVideo(input, duration = 0, options = {}) {
  const resolvedDuration = Math.max(0.2, Number(duration) || 0.2);
  const sceneResult = await detectSceneTimes(input, resolvedDuration);
  const silenceResult = options.includeAudio === false
    ? { silences: [], coverage: 0, mode: 'disabled' }
    : await detectSilences(input, resolvedDuration);
  const boundaries = buildTemporalBoundaries(resolvedDuration, sceneResult.times);
  const scenes = boundaries.slice(0, -1).map((start, index) => ({
    index,
    start: rounded(start),
    end: rounded(boundaries[index + 1]),
    duration: rounded(boundaries[index + 1] - start),
  })).filter((scene) => scene.duration >= 0.05);
  const semanticEnabled = options.semantic !== false && isVisionEnabled();
  const temporaryRoot = options.workDir || await fs.promises.mkdtemp(path.join(os.tmpdir(), 'mamage-video-semantic-'));
  const ownsTemporaryRoot = !options.workDir;
  const frameDir = path.join(temporaryRoot, `storyboards-${Date.now()}-${Math.random().toString(16).slice(2)}`);
  const segments = [];
  let visualFailures = 0;
  let visualSuccesses = 0;
  try {
    if (semanticEnabled) await fs.promises.mkdir(frameDir, { recursive: true });
    for (const scene of scenes) {
      const segment = { ...scene, sampleTimes: sampleTimesForSegment(scene.start, scene.end), summary: null, tags: [], actions: [], peopleCount: null, keyMoment: false, confidence: null };
      if (semanticEnabled) {
        await notifyProgress(options.onProgress, { phase: 'visual', completed: segments.length, total: scenes.length, segment });
        try {
          const storyboard = await buildStoryboard(input, segment.sampleTimes, frameDir, segment.index);
          if (!storyboard) throw new Error('无法提取该时间段的画面');
          const result = await analyzeTemporalStoryboard(storyboard, segment);
          segment.summary = result.summary;
          segment.tags = result.tags || [];
          segment.actions = result.actions || [];
          segment.peopleCount = result.peopleCount;
          segment.keyMoment = Boolean(result.keyMoment);
          segment.confidence = result.confidence;
          segment.provider = result.provider;
          segment.model = result.model;
          if (segment.summary || segment.tags.length) visualSuccesses += 1;
        } catch (error) {
          visualFailures += 1;
          segment.error = String(error && error.message ? error.message : error).slice(0, 180);
        }
      }
      if (!segment.summary) segment.summary = genericSegmentSummary(segment);
      segments.push(segment);
    }
  } finally {
    await fs.promises.rm(frameDir, { recursive: true, force: true }).catch(() => null);
    if (ownsTemporaryRoot) await fs.promises.rm(temporaryRoot, { recursive: true, force: true }).catch(() => null);
  }

  await notifyProgress(options.onProgress, { phase: 'summary', completed: segments.length, total: scenes.length });
  const global = await summarizeTemporalTimeline({
    segments,
    duration: resolvedDuration,
    hasAudio: silenceResult.mode !== 'unavailable' && silenceResult.mode !== 'no-audio-scan',
    silences: silenceResult.silences,
    allowModel: semanticEnabled,
  });
  const semanticStatus = visualSuccesses > 0 ? (visualFailures > 0 ? 'partial' : 'done') : 'technical';
  return {
    version: 2,
    analyzedAt: new Date().toISOString(),
    method: 'temporal-storyboards-and-audio',
    semanticStatus,
    coverage: {
      start: 0,
      end: rounded(resolvedDuration),
      duration: rounded(resolvedDuration),
      complete: true,
      segmentCount: segments.length,
      sampleFrameCount: segments.reduce((sum, segment) => sum + segment.sampleTimes.length, 0),
      visualSegments: visualSuccesses,
      failedVisualSegments: visualFailures,
      sampling: sceneResult.mode,
      audioCoverage: rounded(silenceResult.coverage),
      audioMode: silenceResult.mode,
    },
    sceneThreshold: numberEnv('VIDEO_SEMANTIC_SCENE_THRESHOLD', 0.32, 0.05, 0.95),
    scenes,
    shotChanges: sceneResult.times.map((time) => rounded(time)),
    silences: silenceResult.silences,
    segments,
    global,
    summary: global.summary || `已覆盖 ${segments.length} 个连续时段并完成全程分析`,
  };
}

module.exports = { analyzeVideo, buildTemporalBoundaries, sampleTimesForSegment };
