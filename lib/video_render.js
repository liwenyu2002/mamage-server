const fs = require('fs');
const path = require('path');
const { spawn, execFile } = require('child_process');
const { promisify } = require('util');

const execFileAsync = promisify(execFile);
const FFMPEG_PATH = process.env.FFMPEG_PATH || (fs.existsSync('/opt/homebrew/bin/ffmpeg') ? '/opt/homebrew/bin/ffmpeg' : 'ffmpeg');
const FFPROBE_PATH = process.env.FFPROBE_PATH || (fs.existsSync('/opt/homebrew/bin/ffprobe') ? '/opt/homebrew/bin/ffprobe' : 'ffprobe');

function clamp(value, min, max) {
  const number = Number(value);
  if (!Number.isFinite(number)) return min;
  return Math.max(min, Math.min(max, number));
}

async function probeVideo(filePath) {
  const { stdout } = await execFileAsync(FFPROBE_PATH, [
    '-v', 'error', '-show_streams', '-show_format', '-of', 'json', filePath,
  ], { maxBuffer: 4 * 1024 * 1024, timeout: 60000 });
  const data = JSON.parse(stdout || '{}');
  const video = (data.streams || []).find((stream) => stream.codec_type === 'video') || {};
  const audio = (data.streams || []).find((stream) => stream.codec_type === 'audio') || null;
  return {
    duration: Number(data.format && data.format.duration) || Number(video.duration) || 0,
    width: Number(video.width) || 0,
    height: Number(video.height) || 0,
    hasAudio: Boolean(audio),
    videoCodec: video.codec_name || null,
    audioCodec: audio && audio.codec_name ? audio.codec_name : null,
    frameRate: video.avg_frame_rate || video.r_frame_rate || null,
  };
}

function atempoChain(speed) {
  let value = clamp(speed || 1, 0.25, 4);
  const filters = [];
  while (value > 2) { filters.push('atempo=2'); value /= 2; }
  while (value < 0.5) { filters.push('atempo=0.5'); value /= 0.5; }
  filters.push(`atempo=${value.toFixed(4)}`);
  return filters.join(',');
}

function normalizeProjectClips(project) {
  if (Array.isArray(project.clips)) return project.clips;
  const tracks = Array.isArray(project.tracks) ? project.tracks : [];
  const primary = tracks.find((track) => track.type === 'video' && (track.primary || track.id === 'V1'))
    || tracks.find((track) => track.type === 'video');
  return primary && Array.isArray(primary.clips) ? primary.clips : [];
}

function normalizeTransition(value) {
  const transition = String(value || '').trim().toLowerCase();
  return ['dissolve', 'fade', 'flash'].includes(transition) ? transition : 'cut';
}

function transitionDuration(previousDuration, nextDuration, transition) {
  if (normalizeTransition(transition) === 'cut') return 0;
  const duration = Math.min(0.35, previousDuration / 2, nextDuration / 2);
  return duration >= 0.08 ? Number(duration.toFixed(3)) : 0;
}

function xfadeTransition(transition) {
  if (transition === 'dissolve') return 'dissolve';
  if (transition === 'fade') return 'fadeblack';
  if (transition === 'flash') return 'fadewhite';
  return 'fade';
}

function parseCanvas(project, options = {}) {
  const ratio = options.aspectRatio || project.aspectRatio || (project.canvas && project.canvas.aspectRatio) || '16:9';
  const presets = {
    '16:9': [1920, 1080],
    '9:16': [1080, 1920],
    '1:1': [1080, 1080],
    '4:3': [1440, 1080],
  };
  const preset = presets[ratio] || presets['16:9'];
  return {
    width: clamp(options.width || (project.canvas && project.canvas.width) || preset[0], 320, 3840),
    height: clamp(options.height || (project.canvas && project.canvas.height) || preset[1], 320, 3840),
    fps: clamp(options.fps || (project.canvas && project.canvas.fps) || 25, 12, 60),
    ratio,
  };
}

async function buildRenderSpec(project, assetRows, options = {}) {
  const assets = new Map(assetRows.map((row) => [String(row.id), row]));
  const sourceAliases = new Map();
  (Array.isArray(project.sources) ? project.sources : []).forEach((source) => {
    const assetId = source.assetId || source.asset_id || source.serverId || source.id;
    if (assetId !== undefined && assetId !== null) sourceAliases.set(String(source.id), String(assetId));
  });
  const rawClips = normalizeProjectClips(project).slice(0, 120);
  const clips = [];
  for (const clip of rawClips) {
    if (clip && clip.kind === 'blank') {
      const requestedBlankDuration = Number(
        clip.duration !== undefined ? clip.duration : (Number(clip.outPoint) - Number(clip.inPoint))
      );
      const blankDuration = Number.isFinite(requestedBlankDuration) ? Math.max(0.08, requestedBlankDuration) : 0.08;
      clips.push({
        kind: 'blank', inPoint: 0, outPoint: blankDuration, speed: 1, volume: 0,
        transition: normalizeTransition(clip.transition),
      });
      continue;
    }
    const requestedId = String(clip.assetId || clip.asset_id || sourceAliases.get(String(clip.sourceId)) || clip.sourceId || '');
    const asset = assets.get(requestedId);
    if (!asset || !asset.storage_path || !fs.existsSync(asset.storage_path)) continue;
    const duration = Number(asset.duration_seconds) || 0;
    const inPoint = clamp(clip.inPoint !== undefined ? clip.inPoint : clip.start, 0, duration);
    const outPoint = clamp(clip.outPoint !== undefined ? clip.outPoint : clip.end, inPoint, duration);
    if (outPoint - inPoint < 0.08) continue;
    clips.push({
      asset,
      inPoint,
      outPoint,
      speed: clamp(clip.speed || 1, 0.25, 4),
      volume: clamp(clip.volume === undefined ? 1 : clip.volume, 0, 4),
      transition: normalizeTransition(clip.transition),
    });
  }
  if (!clips.length) {
    const error = new Error('工程中没有可渲染的视频片段');
    error.code = 'NO_RENDERABLE_CLIPS';
    throw error;
  }
  const audioTrack = Array.isArray(project.audioClips)
    ? project.audioClips
    : (((Array.isArray(project.tracks) ? project.tracks : []).find((track) => track.type === 'audio' || track.id === 'A1') || {}).clips || []);
  const audioClips = audioTrack.slice(0, 24).map((clip) => {
    const requestedId = String(clip.assetId || clip.asset_id || sourceAliases.get(String(clip.sourceId)) || clip.sourceId || '');
    const asset = assets.get(requestedId);
    if (!asset || !asset.storage_path || !fs.existsSync(asset.storage_path) || !Number(asset.has_audio)) return null;
    const duration = Number(asset.duration_seconds) || 0;
    const inPoint = clamp(clip.inPoint !== undefined ? clip.inPoint : clip.start, 0, duration);
    const outPoint = clamp(clip.outPoint !== undefined ? clip.outPoint : clip.end, inPoint, duration);
    if (outPoint - inPoint < 0.08) return null;
    return { asset, inPoint, outPoint, timelineStart: Math.max(0, Number(clip.timelineStart) || 0), volume: clamp(clip.volume === undefined ? 0.35 : clip.volume, 0, 4) };
  }).filter(Boolean);
  return { clips, audioClips, canvas: parseCanvas(project, options) };
}

function srtTime(seconds) {
  const value = Math.max(0, Number(seconds) || 0);
  const hours = Math.floor(value / 3600);
  const minutes = Math.floor((value % 3600) / 60);
  const secs = Math.floor(value % 60);
  const ms = Math.floor((value % 1) * 1000);
  return `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}:${String(secs).padStart(2, '0')},${String(ms).padStart(3, '0')}`;
}

function writeCaptionFile(project, outputPath, expectedDuration) {
  const captions = (Array.isArray(project.captions) ? project.captions : []).slice(0, 500).map((caption, index) => {
    const start = clamp(caption.at !== undefined ? caption.at : caption.start, 0, expectedDuration);
    const end = clamp(caption.end !== undefined ? caption.end : start + (Number(caption.duration) || 3.5), start + 0.15, expectedDuration);
    const text = String(caption.text || '').replace(/\r?\n/g, '\n').trim();
    return text ? `${index + 1}\n${srtTime(start)} --> ${srtTime(end)}\n${text}\n` : '';
  }).filter(Boolean);
  if (!captions.length) return null;
  const subtitlePath = `${outputPath}.srt`;
  fs.writeFileSync(subtitlePath, captions.join('\n'), 'utf8');
  return subtitlePath;
}

async function renderProject({ project, assetRows, outputPath, options = {}, onProgress, signalRef }) {
  const { clips, audioClips, canvas } = await buildRenderSpec(project, assetRows, options);
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  const args = ['-hide_banner', '-y'];
  clips.forEach((clip) => {
    if (clip.kind === 'blank') {
      const blankDuration = clip.outPoint - clip.inPoint;
      args.push('-f', 'lavfi', '-t', blankDuration.toFixed(3), '-i', `color=c=black:s=${canvas.width}x${canvas.height}:r=${canvas.fps}`);
    } else {
      args.push('-i', clip.asset.storage_path);
    }
  });
  audioClips.forEach((clip) => { args.push('-i', clip.asset.storage_path); });

  const filters = [];
  const renderedDurations = [];
  clips.forEach((clip, index) => {
    const renderedDuration = (clip.outPoint - clip.inPoint) / clip.speed;
    renderedDurations.push(renderedDuration);
    if (clip.kind === 'blank') {
      filters.push(`[${index}:v]trim=duration=${renderedDuration.toFixed(3)},setpts=PTS-STARTPTS,setsar=1,fps=${canvas.fps},format=yuv420p,settb=AVTB[v${index}]`);
    } else {
      filters.push(
        `[${index}:v]trim=start=${clip.inPoint.toFixed(3)}:end=${clip.outPoint.toFixed(3)},` +
        `setpts=(PTS-STARTPTS)/${clip.speed.toFixed(4)},` +
        `scale=${canvas.width}:${canvas.height}:force_original_aspect_ratio=decrease,` +
        `pad=${canvas.width}:${canvas.height}:(ow-iw)/2:(oh-ih)/2:black,setsar=1,fps=${canvas.fps},format=yuv420p,settb=AVTB[v${index}]`
      );
    }
    if (clip.kind !== 'blank' && Number(clip.asset.has_audio)) {
      filters.push(
        `[${index}:a]atrim=start=${clip.inPoint.toFixed(3)}:end=${clip.outPoint.toFixed(3)},` +
        `asetpts=PTS-STARTPTS,${atempoChain(clip.speed)},volume=${clip.volume.toFixed(3)},aresample=48000[a${index}]`
      );
    } else {
      filters.push(`anullsrc=r=48000:cl=stereo,atrim=duration=${renderedDuration.toFixed(3)}[a${index}]`);
    }
  });

  let videoLabel = 'v0';
  let audioLabel = 'a0';
  let expectedDuration = renderedDurations[0] || 0;
  for (let index = 1; index < clips.length; index += 1) {
    const duration = renderedDurations[index] || 0;
    const transition = normalizeTransition(clips[index].transition);
    const overlap = transitionDuration(expectedDuration, duration, transition);
    const nextVideoLabel = `vjoin${index}`;
    const nextAudioLabel = `ajoin${index}`;
    if (overlap > 0) {
      filters.push(
        `[${videoLabel}][v${index}]xfade=transition=${xfadeTransition(transition)}:` +
        `duration=${overlap.toFixed(3)}:offset=${Math.max(0, expectedDuration - overlap).toFixed(3)}[${nextVideoLabel}]`
      );
      filters.push(`[${audioLabel}][a${index}]acrossfade=d=${overlap.toFixed(3)}:c1=tri:c2=tri[${nextAudioLabel}]`);
      expectedDuration += duration - overlap;
    } else {
      filters.push(`[${videoLabel}][v${index}]concat=n=2:v=1:a=0[${nextVideoLabel}]`);
      filters.push(`[${audioLabel}][a${index}]concat=n=2:v=0:a=1[${nextAudioLabel}]`);
      expectedDuration += duration;
    }
    videoLabel = nextVideoLabel;
    audioLabel = nextAudioLabel;
  }
  filters.push(`[${videoLabel}]null[vbase]`);
  filters.push(`[${audioLabel}]anull[amain]`);
  const mixedInputs = ['[amain]'];
  audioClips.forEach((clip, index) => {
    const inputIndex = clips.length + index;
    const delay = Math.round(clip.timelineStart * 1000);
    filters.push(`[${inputIndex}:a]atrim=start=${clip.inPoint.toFixed(3)}:end=${clip.outPoint.toFixed(3)},asetpts=PTS-STARTPTS,adelay=${delay}|${delay},volume=${clip.volume.toFixed(3)},aresample=48000[bg${index}]`);
    mixedInputs.push(`[bg${index}]`);
  });
  if (mixedInputs.length > 1) filters.push(`${mixedInputs.join('')}amix=inputs=${mixedInputs.length}:duration=first:dropout_transition=2:normalize=0[aout]`);
  else filters.push('[amain]anull[aout]');

  const subtitlePath = writeCaptionFile(project, outputPath, expectedDuration);
  const subtitleInputIndex = clips.length + audioClips.length;
  if (subtitlePath) args.push('-f', 'srt', '-i', subtitlePath);
  filters.push('[vbase]null[vout]');
  args.push(
    '-filter_complex', filters.join(';'),
    '-map', '[vout]', '-map', '[aout]',
    '-c:v', 'libx264', '-preset', options.preset || 'veryfast', '-crf', String(clamp(options.crf || 23, 16, 32)),
    '-c:a', 'aac', '-b:a', '192k'
  );
  if (subtitlePath) args.push('-map', `${subtitleInputIndex}:s:0`, '-c:s', 'mov_text', '-metadata:s:s:0', 'language=chi');
  args.push('-movflags', '+faststart', '-progress', 'pipe:1', '-nostats', outputPath);

  try { await new Promise((resolve, reject) => {
    const child = spawn(FFMPEG_PATH, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    if (signalRef) signalRef.child = child;
    let stderr = '';
    let buffer = '';
    child.stdout.on('data', (chunk) => {
      buffer += chunk.toString();
      const lines = buffer.split(/\r?\n/);
      buffer = lines.pop() || '';
      lines.forEach((line) => {
        const match = line.match(/^out_time_(?:ms|us)=(\d+)/);
        if (!match || !onProgress) return;
        const seconds = Number(match[1]) / 1000000;
        onProgress(Math.max(1, Math.min(99, Math.round((seconds / expectedDuration) * 100))), '正在合成视频');
      });
    });
    child.stderr.on('data', (chunk) => { stderr = (stderr + chunk.toString()).slice(-12000); });
    child.on('error', reject);
    child.on('close', (code, signal) => {
      if (signalRef) signalRef.child = null;
      if (code === 0) resolve();
      else reject(new Error(signal ? `渲染已中止（${signal}）` : `FFmpeg 渲染失败（${code}）：${stderr.slice(-3000)}`));
    });
  }); } finally {
    if (subtitlePath) fs.unlink(subtitlePath, () => {});
  }
  return { outputPath, duration: expectedDuration, canvas };
}

module.exports = { probeVideo, renderProject, buildRenderSpec, normalizeProjectClips };
