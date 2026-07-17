// backend/app.js锛堝畬鏁寸ず渚嬶級
// Load local .env. Fill variables that PM2 may have injected as empty strings.
try {
  const dotenvResult = require('dotenv').config();
  if (dotenvResult && dotenvResult.parsed) {
    for (const [key, value] of Object.entries(dotenvResult.parsed)) {
      if (process.env[key] === undefined || process.env[key] === '') {
        process.env[key] = value;
      }
    }
  }
} catch (e) { }
// 涓存椂璋冭瘯锛氬 process.exit 杩涜杞婚噺鍖呰锛屾墦鍗拌皟鐢ㄦ爤浠ュ畾浣嶈皝瑙﹀彂浜嗛€€鍑恒€?// 璋冭瘯瀹屾垚鍚庝細绉婚櫎姝や唬鐮併€?// (Removed temporary process.exit wrapper used for debugging)
// Load local .env in development (optional). Ensure .env is in .gitignore.

// 鍦ㄥ簲鐢ㄥ惎鍔ㄥ墠楠岃瘉鐜鍙橀噺
const { validateEnvironment } = require('./lib/validateEnv');
try {
  validateEnvironment(true); // true 琛ㄧず寮€鍚弗鏍兼ā寮忥紙鎺ㄨ崘閰嶇疆涔熶細妫€鏌ワ級
} catch (err) {
  console.error(err.message);
  process.exit(1);
}

// Global error handlers for easier diagnosis
process.on('uncaughtException', (err) => {
  console.error('UNCAUGHT EXCEPTION:', err && err.stack ? err.stack : err);
});
process.on('unhandledRejection', (reason) => {
  console.error('UNHANDLED REJECTION:', reason && reason.stack ? reason.stack : reason);
});

// (Removed temporary exit/signal debug handlers)
// Validate AI keys/models on startup and print concise status
const { validateAll } = require('./lib/validateAi');

async function runStartupValidations() {
  try {
    const res = await validateAll();
    if (res.text) {
      if (res.text.ok) console.log('鉁?Text AI key & model validated');
      else console.log('鈿狅笍 Text AI validation:', res.text.reason);
    }
    if (res.vision) {
      if (res.vision.ok) console.log(`鉁?Vision AI validated (${res.vision.provider || 'unknown'}${res.vision.model ? `/${res.vision.model}` : ''})`);
      else console.log('鈿狅笍 Vision AI validation:', res.vision.reason);
    }
  } catch (e) {
    console.error('AI validation failed:', e && e.stack ? e.stack : e);
  }
}

const express = require('express');
const path = require('path');
const projectsRouter = require('./routes/projects');
const photosRouter = require('./routes/photos');
const uploadRouter = require('./routes/upload');
const usersRouter = require('./routes/users');
const aiNewsRouter = require('./routes/ai_news');
const orgsRouter = require('./routes/organizations');
const shareRouter = require('./routes/share');
const similarityRouter = require('./routes/similarity_groups');
const facesRouter = require('./routes/faces');
const imageProxyRouter = require('./routes/image_proxy');
const wxImageProxyRouter = require('./routes/wx_image_proxy');
const wechatStyleRouter = require('./routes/wechat_style');
const wechatPreviewRouter = require('./routes/wechat_preview');
const wechatCompositionsRouter = require('./routes/wechat_compositions');
const userFavoritesRouter = require('./routes/user_favorites');

const app = express();

// 9mb：给 JSON 包裹开销（字段名/引号/花括号等）留余量，让路由自身的内容上限校验真正能命中，
// 而不是被这里的通用限制提前拦截掉（body-parser 超限直接抛 Express 内置 413，绕过路由的
// 自定义错误结构）。目前最大的内容上限来自 /api/wechat-compositions 的 doc（8MB，画布整篇
// DocBlock[] 快照，raw 块可能含图片编辑器导出的 data URL）；/api/wechat-preview 的 2MB html
// 上限同样在此范围内。
app.use(express.json({ limit: '9mb' }));
app.use(express.urlencoded({ extended: true, limit: '9mb' }));

// ============ CORS ============
const configuredCorsOrigins = String(process.env.CORS_ORIGIN || '')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);
const defaultCorsOrigins = [
  'http://localhost:5173',
  'http://127.0.0.1:5173',
  'http://localhost:5188',
  'http://127.0.0.1:5188',
  'http://10.11.12.63:3000',
  'http://10.100.83.67:3000',
  'https://mamage.wenyuli.site',
  'https://lan.mamage.wenyuli.site',
  'https://lan.mamage.wenyuli.site:3443',
  'http://mamage.wenyuli.site',
];
const allowedCorsOrigins = new Set(configuredCorsOrigins.length
  ? configuredCorsOrigins
  : defaultCorsOrigins);
app.use((req, res, next) => {
  const origin = req.get('origin');
  const originAllowed = origin && allowedCorsOrigins.has(origin);
  if (originAllowed) {
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Vary', 'Origin');
    res.setHeader('Access-Control-Allow-Credentials', 'true');
    res.setHeader('Access-Control-Allow-Private-Network', 'true');
  }
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PUT,DELETE,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type,Authorization,X-Requested-With');
  if (req.method === 'OPTIONS') {
    return originAllowed || !origin ? res.status(204).end() : res.status(403).end();
  }
  next();
});

// ============ /uploads 闈欐€佹枃浠讹紙浣犲師鏉ョ殑閫昏緫锛?============
const keys = require('./config/keys');
const uploadsAbsDir = keys.UPLOAD_ABS_DIR || path.join(__dirname, 'uploads');

const staticUploadsDir = uploadsAbsDir.replace(/\\/g, '/').toLowerCase().endsWith('/uploads')
  ? uploadsAbsDir
  : path.join(uploadsAbsDir, 'uploads');

app.use('/api/image', imageProxyRouter);
app.use('/api/wx-img', wxImageProxyRouter);
app.use('/uploads', express.static(staticUploadsDir));
// ============ 鏃ュ織 ============
app.use((req, res, next) => {
  if (process.env.REQUEST_LOGS !== '0') console.log(`${req.method} ${req.url}`);
  next();
});

// ============ API 璺敱 ============
app.use('/api/projects', projectsRouter);
app.use('/api/photos', photosRouter);
app.use('/api/upload', uploadRouter);
app.use('/api/users', usersRouter);
app.use('/api/ai/news', aiNewsRouter);
app.use('/api/wechat-style', wechatStyleRouter);
app.use('/api/wechat-preview', wechatPreviewRouter);
app.use('/api/wechat-compositions', wechatCompositionsRouter);
app.use('/api/favorites', userFavoritesRouter);
app.use('/api/organizations', orgsRouter);
app.use('/api/auth', require('./routes/auth_dingtalk'));
app.use('/api/share', shareRouter);
app.use('/api/similarity', similarityRouter);
app.use('/api', facesRouter);

app.get('/api/health', (req, res) => {
  res.json({ status: 'ok' });
});
app.get('/', (req, res) => {
  res.type('html').send(
    "<!doctype html><html><head><meta charset='utf-8'><title>MaMage API</title></head><body><h1>MaMage API Server</h1><p>This backend serves API only.</p><p>Health: <a href='/api/health'>/api/health</a></p></body></html>"
  );
});
// ============ 鍚姩鏈嶅姟 ============
const PORT = Number(process.env.PORT) || 8000; // 鎴?process.env.PORT || 52367;

async function startup() {
  // perform AI validations and then start server
  try {
    await runStartupValidations();
  } catch (e) {
    console.error('Startup validation error (non-fatal):', e && e.stack ? e.stack : e);
  }

  app.listen(PORT, () => {
    console.log(`API server listening on http://localhost:${PORT}`);
  });

  // AI 打标队列是纯内存的：重启后把 pending/running 孤儿重新入队。
  // 延迟执行避开启动高峰；AI_REQUEUE_ON_BOOT=0 可关闭。
  if (String(process.env.AI_REQUEUE_ON_BOOT || '1') !== '0') {
    setTimeout(() => {
      try {
        require('./lib/ai_tags_worker').requeueStuckPhotos({ limit: Number(process.env.AI_REQUEUE_LIMIT) || 200 });
      } catch (e) {
        console.warn('AI requeue on boot failed:', e && e.message ? e.message : e);
      }
    }, 15000);

    // 运行中的服务也要兜底扫描：上传过程中短暂重启、内存队列异常或模型断连后，
    // 遗留的 pending/running 任务能自行回到队列，不必等待下一次部署重启。
    const requeueIntervalMs = Math.max(30000, Math.min(3600000, Number(process.env.AI_REQUEUE_INTERVAL_MS) || 120000));
    const requeueTimer = setInterval(() => {
      try {
        require('./lib/ai_tags_worker').requeueStuckPhotos({ limit: Number(process.env.AI_REQUEUE_LIMIT) || 200 });
      } catch (e) {
        console.warn('AI periodic requeue failed:', e && e.message ? e.message : e);
      }
    }, requeueIntervalMs);
    if (typeof requeueTimer.unref === 'function') requeueTimer.unref();
  }
}

startup();
