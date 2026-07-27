const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const { buildRenderSpec, renderProject } = require('../lib/video_render');
const videoStorage = require('../lib/video_editor_storage');

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
