const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const FFMPEG_PATH = process.env.FFMPEG_PATH || (fs.existsSync('/opt/homebrew/bin/ffmpeg') ? '/opt/homebrew/bin/ffmpeg' : 'ffmpeg');
const DEFAULT_WHISPER_ROOT = path.join(os.homedir(), 'whisper.cpp');
const DEFAULT_WHISPER_CLI = path.join(DEFAULT_WHISPER_ROOT, 'build', 'bin', 'whisper-cli');
const DEFAULT_WHISPER_MODEL = path.join(DEFAULT_WHISPER_ROOT, 'models', 'ggml-large-v3-q5_0.bin');

function boundedNumber(name, fallback, minimum, maximum) {
  const value = Number(process.env[name]);
  if (!Number.isFinite(value)) return fallback;
  return Math.max(minimum, Math.min(maximum, value));
}

function rounded(value, digits = 3) {
  const factor = 10 ** digits;
  return Math.round((Number(value) || 0) * factor) / factor;
}

function transcriptConfig() {
  const cli = process.env.VIDEO_TRANSCRIPT_WHISPER_CLI || DEFAULT_WHISPER_CLI;
  const model = process.env.VIDEO_TRANSCRIPT_MODEL_PATH || DEFAULT_WHISPER_MODEL;
  const enabled = String(process.env.VIDEO_TRANSCRIPT_ENABLED || '1') !== '0';
  return {
    enabled,
    cli,
    model,
    language: String(process.env.VIDEO_TRANSCRIPT_LANGUAGE || 'zh').trim() || 'zh',
    threads: Math.round(boundedNumber('VIDEO_TRANSCRIPT_THREADS', 4, 1, 12)),
    maxSeconds: boundedNumber('VIDEO_TRANSCRIPT_MAX_SECONDS', 7200, 30, 6 * 60 * 60),
    prompt: String(process.env.VIDEO_TRANSCRIPT_PROMPT || '中关村学院，北京大学，团代会，校园融媒体，学生工作').trim(),
  };
}

function isTranscriptAvailable() {
  const config = transcriptConfig();
  return Boolean(config.enabled && fs.existsSync(config.cli) && fs.existsSync(config.model));
}

function commandError(label, code, signal, stderr, timedOut) {
  const suffix = timedOut || signal ? `（${signal || 'timeout'}）` : `（${code}）`;
  return new Error(`${label}失败${suffix}${stderr ? `：${stderr.slice(-700)}` : ''}`);
}

function runCommand(command, args, options = {}) {
  const timeoutMs = Math.max(15000, Number(options.timeoutMs) || 120000);
  const label = options.label || path.basename(command);
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ['ignore', 'ignore', 'pipe'] });
    let stderr = '';
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGKILL');
    }, timeoutMs);
    child.stderr.on('data', (chunk) => { stderr = (stderr + chunk.toString()).slice(-1024 * 1024); });
    child.on('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on('close', (code, signal) => {
      clearTimeout(timer);
      if (code === 0) resolve();
      else reject(commandError(label, code, signal, stderr, timedOut));
    });
  });
}

function parseOffset(value) {
  const number = Number(value);
  return Number.isFinite(number) ? Math.max(0, number / 1000) : null;
}

function parseWhisperTimestamp(value) {
  const matched = String(value || '').trim().match(/^(\d+):(\d{2}):(\d{2})(?:[,.](\d{1,3}))?$/);
  if (!matched) return null;
  const hours = Number(matched[1]) || 0;
  const minutes = Number(matched[2]) || 0;
  const seconds = Number(matched[3]) || 0;
  const milliseconds = Number(String(matched[4] || '').padEnd(3, '0')) || 0;
  return hours * 3600 + minutes * 60 + seconds + milliseconds / 1000;
}

function cleanTranscriptText(value) {
  return String(value || '')
    .replace(/\s+/g, ' ')
    .replace(/^\s*[\[（(](?:blank[_\s-]*audio|music|silence|静音)[\]）)]\s*$/i, '')
    .trim()
    .slice(0, 1000);
}

function normalizeWhisperSegments(payload, maximumDuration) {
  const seen = new Set();
  const source = Array.isArray(payload && payload.transcription) ? payload.transcription : [];
  return source.reduce((segments, item) => {
    const text = cleanTranscriptText(item && item.text);
    if (!text) return segments;
    const offsets = item && item.offsets && typeof item.offsets === 'object' ? item.offsets : {};
    const timestamps = item && item.timestamps && typeof item.timestamps === 'object' ? item.timestamps : {};
    const start = parseOffset(offsets.from) ?? parseWhisperTimestamp(timestamps.from) ?? 0;
    const end = parseOffset(offsets.to) ?? parseWhisperTimestamp(timestamps.to) ?? start;
    const safeStart = rounded(Math.min(Math.max(0, start), maximumDuration));
    const safeEnd = rounded(Math.min(Math.max(safeStart, end), maximumDuration));
    const duplicateKey = `${text.toLowerCase()}|${Math.round(safeStart)}`;
    if (seen.has(duplicateKey)) return segments;
    seen.add(duplicateKey);
    segments.push({ start: safeStart, end: safeEnd, text });
    return segments;
  }, []).slice(0, 4000);
}

function transcriptionTimeoutMs(duration) {
  const configured = Number(process.env.VIDEO_TRANSCRIPT_TIMEOUT_MS);
  if (Number.isFinite(configured)) return Math.max(120000, Math.min(4 * 60 * 60 * 1000, configured));
  return Math.max(180000, Math.min(4 * 60 * 60 * 1000, 180000 + Math.ceil(Math.max(0, duration) * 2200)));
}

async function removeIfExists(target) {
  if (!target) return;
  await fs.promises.rm(target, { force: true }).catch(() => null);
}

/**
 * Transcribe a video's first audio stream locally. Failures intentionally return
 * structured status instead of throwing: visual semantics remain useful even
 * when a source has no speech or the ASR runtime is temporarily unavailable.
 */
async function transcribeVideoAudio(input, duration = 0, options = {}) {
  const config = transcriptConfig();
  const fullDuration = Math.max(0, Number(duration) || 0);
  if (!config.enabled || options.enabled === false) return { status: 'disabled', segments: [], text: '' };
  if (!fs.existsSync(config.cli) || !fs.existsSync(config.model)) {
    return {
      status: 'unavailable',
      provider: 'whisper.cpp',
      model: path.basename(config.model),
      segments: [],
      text: '',
      error: 'local whisper runtime unavailable',
    };
  }
  if (fullDuration <= 0) return { status: 'unavailable', segments: [], text: '', error: 'video duration unavailable' };

  const coverageDuration = Math.min(fullDuration, config.maxSeconds);
  const ownsWorkDir = !options.workDir;
  const workDir = options.workDir || await fs.promises.mkdtemp(path.join(os.tmpdir(), 'mamage-video-transcript-'));
  const id = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const audioPath = path.join(workDir, `audio-${id}.wav`);
  const outputBase = path.join(workDir, `transcript-${id}`);
  const outputJsonPath = `${outputBase}.json`;
  try {
    await fs.promises.mkdir(workDir, { recursive: true });
    await runCommand(FFMPEG_PATH, [
      '-hide_banner', '-loglevel', 'error', '-nostdin', '-y',
      '-i', input,
      '-t', String(rounded(coverageDuration)),
      '-map', '0:a:0', '-vn', '-ac', '1', '-ar', '16000', '-c:a', 'pcm_s16le',
      audioPath,
    ], { label: '提取视频音轨', timeoutMs: transcriptionTimeoutMs(Math.min(coverageDuration, 900)) });
    await runCommand(config.cli, [
      '-m', config.model,
      '-f', audioPath,
      '-l', config.language,
      '-t', String(config.threads),
      '-oj',
      '-of', outputBase,
      '-np',
      ...(config.prompt ? ['--prompt', config.prompt] : []),
    ], { label: '本地声音转写', timeoutMs: transcriptionTimeoutMs(coverageDuration) });
    const raw = await fs.promises.readFile(outputJsonPath, 'utf8');
    const payload = JSON.parse(raw);
    const segments = normalizeWhisperSegments(payload, coverageDuration);
    const text = segments.map((segment) => segment.text).join('\n').slice(0, 300000);
    return {
      status: segments.length ? (coverageDuration < fullDuration ? 'partial' : 'done') : 'no-speech',
      provider: 'whisper.cpp',
      model: path.basename(config.model),
      language: config.language,
      segments,
      text,
      coverage: {
        start: 0,
        end: rounded(coverageDuration),
        duration: rounded(coverageDuration),
        complete: coverageDuration >= fullDuration,
      },
      generatedAt: new Date().toISOString(),
    };
  } catch (error) {
    return {
      status: 'failed',
      provider: 'whisper.cpp',
      model: path.basename(config.model),
      segments: [],
      text: '',
      error: String(error && error.message ? error.message : error).slice(0, 500),
      coverage: {
        start: 0,
        end: 0,
        duration: 0,
        complete: false,
      },
    };
  } finally {
    await Promise.all([removeIfExists(audioPath), removeIfExists(outputJsonPath)]);
    if (ownsWorkDir) await fs.promises.rm(workDir, { recursive: true, force: true }).catch(() => null);
  }
}

module.exports = {
  isTranscriptAvailable,
  transcriptConfig,
  transcribeVideoAudio,
};
