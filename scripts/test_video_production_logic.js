const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const { buildRenderSpec, renderProject } = require('../lib/video_render');
const videoStorage = require('../lib/video_editor_storage');
const { analyzeVideo } = require('../lib/video_analysis');
const { heuristicRoughCut } = require('../ai_function/ai_for_video/ai_for_video');
const { deterministicTimelineSummary } = require('../ai_function/ai_for_video/video_semantic');

async function main() {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mamage-video-production-test-'));
  try {
    const fakeVideo = path.join(tempDir, 'source.mp4');
    fs.writeFileSync(fakeVideo, Buffer.from([0]));
    const project = {
      aspectRatio: '1:1',
      sources: [{ id: 'source-1', assetId: '11' }],
      clips: [
        { sourceId: 'source-1', inPoint: 2, outPoint: 5, speed: 1 },
        { id: 'blank-1', kind: 'blank', inPoint: 0, outPoint: 2, speed: 1 },
      ],
    };
    const rows = [{ id: 11, storage_path: fakeVideo, duration_seconds: 6, has_audio: 0 }];
    const spec = await buildRenderSpec(project, rows, { width: 320, height: 320, fps: 12 });
    assert.strictEqual(spec.clips.length, 2);
    assert.strictEqual(spec.clips[0].outPoint, 5);
    assert.strictEqual(spec.clips[1].kind, 'blank');
    assert.strictEqual(spec.clips[1].outPoint, 2);

    const proxyUrl = videoStorage.mediaProxyUrl('uploads/video-editor/assets/1/2/demo.mp4');
    assert(proxyUrl.startsWith('/api/image/uploads/video-editor/assets/1/2/demo.mp4'));

    const blankOutput = path.join(tempDir, 'blank.mp4');
    await renderProject({
      project: { aspectRatio: '1:1', clips: [{ kind: 'blank', inPoint: 0, outPoint: 0.25, speed: 1 }] },
      assetRows: [],
      outputPath: blankOutput,
      options: { width: 320, height: 320, fps: 12, preset: 'ultrafast' },
    });
    assert(fs.statSync(blankOutput).size > 0);
    const ffprobe = process.env.FFPROBE_PATH || 'ffprobe';
    const duration = Number(execFileSync(ffprobe, ['-v', 'error', '-show_entries', 'format=duration', '-of', 'default=nw=1:nk=1', blankOutput], { encoding: 'utf8' }).trim());
    assert(duration >= 0.2 && duration <= 0.5);

    const ffmpeg = process.env.FFMPEG_PATH || 'ffmpeg';
    const firstSource = path.join(tempDir, 'first.mp4');
    const secondSource = path.join(tempDir, 'second.mp4');
    [
      [firstSource, 'red'],
      [secondSource, 'blue'],
    ].forEach(([target, color]) => execFileSync(ffmpeg, [
      '-hide_banner', '-y', '-f', 'lavfi', '-i', `color=c=${color}:s=320x320:r=12`, '-t', '0.8',
      '-c:v', 'libx264', '-pix_fmt', 'yuv420p', target,
    ], { stdio: 'ignore' }));
    const transitionOutput = path.join(tempDir, 'transition.mp4');
    await renderProject({
      project: {
        aspectRatio: '1:1',
        sources: [{ id: 'source-a', assetId: '21' }, { id: 'source-b', assetId: '22' }],
        clips: [
          { sourceId: 'source-a', inPoint: 0, outPoint: 0.8, transition: 'none' },
          { sourceId: 'source-b', inPoint: 0, outPoint: 0.8, transition: 'dissolve' },
        ],
      },
      assetRows: [
        { id: 21, storage_path: firstSource, duration_seconds: 0.8, has_audio: 0 },
        { id: 22, storage_path: secondSource, duration_seconds: 0.8, has_audio: 0 },
      ],
      outputPath: transitionOutput,
      options: { width: 320, height: 320, fps: 12, preset: 'ultrafast' },
    });
    const transitionDuration = Number(execFileSync(ffprobe, ['-v', 'error', '-show_entries', 'format=duration', '-of', 'default=nw=1:nk=1', transitionOutput], { encoding: 'utf8' }).trim());
    assert(transitionDuration >= 1 && transitionDuration <= 1.4, `unexpected transition duration ${transitionDuration}`);

    const temporalSource = path.join(tempDir, 'temporal.mp4');
    execFileSync(ffmpeg, [
      '-hide_banner', '-y', '-f', 'lavfi', '-i', 'testsrc2=s=320x180:r=12', '-t', '7',
      '-c:v', 'libx264', '-pix_fmt', 'yuv420p', temporalSource,
    ], { stdio: 'ignore' });
    const temporal = await analyzeVideo(temporalSource, 7, { semantic: false, includeAudio: false });
    assert.strictEqual(temporal.version, 4);
    assert.strictEqual(temporal.coverage.complete, true);
    assert(temporal.segments.length >= 2, 'temporal analysis should cover multiple consecutive segments');
    assert(temporal.coverage.sampleFrameCount >= temporal.segments.length, 'every temporal segment should own representative samples');
    assert.strictEqual(temporal.semanticStatus, 'technical');

    const detailedGlobal = deterministicTimelineSummary([{
      start: 0,
      end: 4,
      summary: '工作人员打开并展示空投票箱。',
      scene: '团代会选举正式会议会场',
      eventStage: '展示空投票箱',
      tags: ['室内', '会议'],
      keyObjects: ['投票箱'],
      visibleText: ['投票箱'],
      actions: ['打开', '展示'],
      keyMoment: true,
    }], 4);
    assert(detailedGlobal.totalSemantic.includes('投票箱'), 'total semantic should retain key entities');
    assert.strictEqual(detailedGlobal.detailedSummary, detailedGlobal.totalSemantic, 'legacy detailed summary should mirror total semantic');
    assert(detailedGlobal.visibleText.includes('投票箱'), 'global summary should retain visible text');

    const semanticPlan = heuristicRoughCut({
      targetDuration: 5,
      style: 'documentary',
      aspectRatio: '16:9',
      sources: [{
        id: 'semantic-source', name: 'semantic', duration: 20,
        analysis: {
          segments: [{ start: 8, end: 12, summary: '嘉宾登台发言', actions: ['发言'], keyMoment: true }],
          scenes: [{ start: 0, end: 20, duration: 20 }],
        },
      }],
    });
    assert(semanticPlan.clips.length > 0);
    assert(semanticPlan.clips[0].start >= 8 && semanticPlan.clips[0].start <= 12, 'rough cut should prefer the temporal semantic segment');

    const localMaterialized = await videoStorage.materializeAsset(rows[0], tempDir);
    assert.strictEqual(localMaterialized, fakeVideo);
    console.log('[test:video] production video logic passed');
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(error && error.stack ? error.stack : error);
  process.exit(1);
});
