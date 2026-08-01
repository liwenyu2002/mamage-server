/*
 * Add local speech-to-text to existing video semantic records without repeating
 * the visual storyboard analysis. Usage:
 *   node scripts/backfill_video_transcripts.js --all
 *   node scripts/backfill_video_transcripts.js --limit 3
 */
const { pool } = require('../db');
const { probeVideo } = require('../lib/video_render');
const { resolveVideoAnalysisInput } = require('../lib/video_semantic_source');
const { transcribeVideoAudio, isTranscriptAvailable } = require('../lib/video_transcription');
const { deterministicTimelineSummary } = require('../ai_function/ai_for_video/video_semantic');

function parseArgs(argv) {
  const args = new Set(argv || []);
  const position = (argv || []).indexOf('--limit');
  const suppliedLimit = position >= 0 ? Number(argv[position + 1]) : null;
  const limit = args.has('--all') ? 5000 : Math.max(1, Math.min(5000, Number.isFinite(suppliedLimit) ? suppliedLimit : 3));
  return { limit };
}

function parseAnalysis(raw) {
  if (!raw) return {};
  if (typeof raw === 'object') return raw;
  try { return JSON.parse(raw); } catch (_) { return {}; }
}

function transcriptNeedsBackfill(analysis) {
  const status = String(analysis && analysis.transcript && analysis.transcript.status || '').toLowerCase();
  return !['done', 'partial', 'no-speech'].includes(status);
}

async function loadCandidates(limit) {
  const [rows] = await pool.query(
    `SELECT p.id, p.url, pvs.analysis_json AS analysisJson
       FROM photos p
       INNER JOIN photo_video_semantics pvs ON pvs.photo_id = p.id
      WHERE LOWER(COALESCE(p.type, '')) = 'video'
        AND (
          JSON_EXTRACT(pvs.analysis_json, '$.transcript') IS NULL
          OR LOWER(COALESCE(JSON_UNQUOTE(JSON_EXTRACT(pvs.analysis_json, '$.transcript.status')), '')) NOT IN ('done', 'partial', 'no-speech')
        )
      ORDER BY pvs.updated_at ASC, p.id ASC
      LIMIT ?`,
    [limit]
  );
  return rows || [];
}

async function persistTranscript(row, analysis, transcript) {
  const next = { ...analysis };
  next.version = Math.max(5, Number(next.version) || 0);
  next.method = 'temporal-storyboards-audio-transcript-and-global-evidence';
  next.transcript = transcript;
  next.transcribedAt = new Date().toISOString();
  next.coverage = {
    ...(next.coverage && typeof next.coverage === 'object' ? next.coverage : {}),
    transcriptStatus: transcript.status || 'unavailable',
    transcriptCoverage: Number(transcript.coverage && transcript.coverage.duration) || 0,
    transcriptComplete: Boolean(transcript.coverage && transcript.coverage.complete),
  };
  const fallback = deterministicTimelineSummary(
    Array.isArray(next.segments) ? next.segments : [],
    Number(next.coverage.duration || next.coverage.end) || 0,
    next.globalEvidence,
    transcript,
  );
  next.global = {
    ...(next.global && typeof next.global === 'object' ? next.global : {}),
    spokenHighlights: fallback.spokenHighlights,
  };
  await pool.query(
    `UPDATE photo_video_semantics
        SET analysis_json = ?, updated_at = NOW()
      WHERE photo_id = ?`,
    [JSON.stringify(next), row.id]
  );
}

async function main() {
  const { limit } = parseArgs(process.argv.slice(2));
  if (!isTranscriptAvailable()) {
    throw new Error('本地 whisper.cpp 或模型未就绪，无法执行视频声音转写回填');
  }
  const rows = await loadCandidates(limit);
  console.log(`[video-transcript-backfill] ${rows.length} video(s) queued for local transcription`);
  let completed = 0;
  let failed = 0;
  for (const row of rows) {
    const analysis = parseAnalysis(row.analysisJson);
    if (!transcriptNeedsBackfill(analysis)) continue;
    try {
      const input = await resolveVideoAnalysisInput(row);
      const metadata = await probeVideo(input);
      const transcript = metadata.hasAudio
        ? await transcribeVideoAudio(input, metadata.duration)
        : { status: 'unavailable', segments: [], text: '', error: 'source has no audio stream' };
      await persistTranscript(row, analysis, transcript);
      completed += 1;
      console.log(`[video-transcript-backfill] ${row.id}: ${transcript.status} (${(transcript.segments || []).length} segment(s))`);
    } catch (error) {
      failed += 1;
      console.error(`[video-transcript-backfill] ${row.id} failed:`, error && error.message ? error.message : error);
    }
  }
  console.log(`[video-transcript-backfill] completed=${completed} failed=${failed}`);
}

main()
  .then(() => pool.end())
  .catch(async (error) => {
    console.error(error && error.stack ? error.stack : error);
    await pool.end().catch(() => null);
    process.exit(1);
  });
