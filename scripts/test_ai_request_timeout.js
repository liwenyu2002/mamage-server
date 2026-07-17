// 验证本地视觉模型无响应时，HTTP 总时限会真正中断请求。
const assert = require('assert');
const http = require('http');
const { postJson } = require('../ai_function/ai_for_tags/ai_for_tags');

async function run() {
  const sockets = new Set();
  const server = http.createServer((_req, _res) => {
    // Intentionally keep the response open to simulate a wedged model request.
  });
  server.on('connection', (socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
  });

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  const startedAt = Date.now();

  try {
    await assert.rejects(
      () => postJson(`http://127.0.0.1:${port}/api/generate`, { model: 'test' }, 100),
      (err) => err && err.code === 'AI_REQUEST_TIMEOUT'
    );
    const elapsedMs = Date.now() - startedAt;
    assert(elapsedMs >= 70 && elapsedMs < 1500, `timeout elapsed ${elapsedMs}ms`);
    console.log(`AI request deadline test passed in ${elapsedMs}ms`);
  } finally {
    for (const socket of sockets) socket.destroy();
    await new Promise((resolve) => server.close(resolve));
  }
}

run().catch((err) => {
  console.error(err && err.stack ? err.stack : err);
  process.exit(1);
});
