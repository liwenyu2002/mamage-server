const { spawn } = require('child_process');
const fs = require('fs');

const FFMPEG_PATH = process.env.FFMPEG_PATH || (fs.existsSync('/opt/homebrew/bin/ffmpeg') ? '/opt/homebrew/bin/ffmpeg' : 'ffmpeg');

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
    const timer = setTimeout(() => child.kill('SIGKILL'), timeoutMs);
    child.stderr.on('data', (chunk) => { stderr = (stderr + chunk.toString()).slice(-2 * 1024 * 1024); });
    child.on('error', (error) => { clearTimeout(timer); reject(error); });
    child.on('close', (code, signal) => {
      clearTimeout(timer);
      if (code === 0 || code === 255) resolve(stderr);
      else reject(new Error(signal ? `素材分析超时（${signal}）` : `FFmpeg 素材分析失败（${code}）`));
    });
  });
}

async function analyzeVideo(filePath, duration = 0) {
  const maxSeconds = Math.min(Math.max(Number(duration) || 0, 1), 7200);
  const sceneLog = await runFfmpeg([
    '-hide_banner', '-i', filePath, '-t', String(maxSeconds),
    '-vf', "select='gt(scene,0.32)',showinfo", '-an', '-f', 'null', '-',
  ]);
  const silenceLog = await runFfmpeg([
    '-hide_banner', '-i', filePath, '-t', String(maxSeconds),
    '-af', 'silencedetect=noise=-35dB:d=0.7', '-vn', '-f', 'null', '-',
  ]).catch(() => '');

  const sceneTimes = parseUniqueTimes(sceneLog, /pts_time:([0-9.]+)/g);
  const silenceStarts = parseUniqueTimes(silenceLog, /silence_start:\s*([0-9.]+)/g);
  const silenceEnds = parseUniqueTimes(silenceLog, /silence_end:\s*([0-9.]+)/g);
  const boundaries = [0, ...sceneTimes.filter((t) => t > 0.2 && t < maxSeconds - 0.2), maxSeconds]
    .sort((a, b) => a - b);
  const scenes = boundaries.slice(0, -1).map((start, index) => ({
    index,
    start: Number(start.toFixed(3)),
    end: Number(boundaries[index + 1].toFixed(3)),
    duration: Number((boundaries[index + 1] - start).toFixed(3)),
  })).filter((scene) => scene.duration >= 0.08);
  const silences = silenceStarts.map((start, index) => ({
    start: Number(start.toFixed(3)),
    end: Number((silenceEnds[index] !== undefined ? silenceEnds[index] : Math.min(maxSeconds, start + 0.7)).toFixed(3)),
  }));

  return {
    version: 1,
    analyzedAt: new Date().toISOString(),
    method: 'ffmpeg-scene-and-silence',
    sceneThreshold: 0.32,
    scenes,
    silences,
    summary: `检测到 ${scenes.length} 个镜头、${silences.length} 段静音`,
  };
}

module.exports = { analyzeVideo };
