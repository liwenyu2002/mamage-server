// backend/app.js（完整示例）
// Load local .env in development (optional). Ensure .env is in .gitignore.
try { require('dotenv').config(); } catch (e) { }
// 临时调试：对 process.exit 进行轻量包装，打印调用栈以定位谁触发了退出。
// 调试完成后会移除此代码。
// (Removed temporary process.exit wrapper used for debugging)
// Load local .env in development (optional). Ensure .env is in .gitignore.

// 在应用启动前验证环境变量
const { validateEnvironment } = require('./lib/validateEnv');
try {
  validateEnvironment(true); // true 表示开启严格模式（推荐配置也会检查）
} catch (err) {
  console.error(err.message);
  process.exit(1);
}

// 全局错误捕获，便于诊断短时退出问题
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
      if (res.text.ok) console.log('✅ Text AI key & model validated');
      else console.log('⚠️ Text AI validation:', res.text.reason);
    }
    if (res.vision) {
      if (res.vision.ok) console.log('✅ Vision AI key & model validated');
      else console.log('⚠️ Vision AI validation:', res.vision.reason);
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

const app = express();

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// ============ CORS（保留你的逻辑） ============
const corsOrigin = process.env.CORS_ORIGIN || 'http://localhost:5173';
app.use((req, res, next) => {
  const origin = req.get('origin');
  const allow = process.env.CORS_ORIGIN || origin || corsOrigin;
  if (allow) res.setHeader('Access-Control-Allow-Origin', allow);
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PUT,DELETE,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type,Authorization');
  res.setHeader('Access-Control-Allow-Credentials', 'true');
  if (req.method === 'OPTIONS') return res.status(204).end();
  next();
});

// ============ /uploads 静态文件（你原来的逻辑） ============
const keys = require('./config/keys');
const uploadsAbsDir = keys.UPLOAD_ABS_DIR || path.join(__dirname, 'uploads');

const staticUploadsDir = uploadsAbsDir.replace(/\\/g, '/').toLowerCase().endsWith('/uploads')
  ? uploadsAbsDir
  : path.join(uploadsAbsDir, 'uploads');

app.use('/uploads', express.static(staticUploadsDir));

// ============ ★ 新增：静态托管 dist ============
/**
 * 这里假设 dist 在项目根目录：
 *   MaMage_Web/
 *     backend/app.js  （当前文件）
 *     dist/           （npm run build 生成）
 */
const distPath = path.join(__dirname, '..', 'MaMage_Web', 'dist');

// 1）把 dist 里的静态文件暴露出来：/index.html、/bundle.js、/favicon.ico 等
app.use(express.static(distPath));

// ============ 日志 ============
app.use((req, res, next) => {
  console.log(`${req.method} ${req.url}`);
  next();
});

// ============ API 路由 ============
app.use('/api/projects', projectsRouter);
app.use('/api/photos', photosRouter);
app.use('/api/upload', uploadRouter);
app.use('/api/users', usersRouter);
app.use('/api/ai/news', aiNewsRouter);
app.use('/api/organizations', orgsRouter);
app.use('/api/share', shareRouter);
app.use('/api/similarity', similarityRouter);

app.get('/api/health', (req, res) => {
  res.json({ status: 'ok' });
});

// ============ ★ 新增：SPA 回退路由 ============
/**
 * 除了 /api 和 /uploads 开头的请求外，其它所有 GET 请求，都返回 dist/index.html，
 * 让 React Router 自己在前端接管路由。
 */
// Use a wildcard that matches any path not starting with /api or /uploads.
// SPA fallback: any GET not under /api or /uploads should return index.html
app.use((req, res, next) => {
  if (req.method !== 'GET') return next();
  if (req.path.startsWith('/api') || req.path.startsWith('/uploads')) return next();
  const indexFile = path.join(distPath, 'index.html');
  res.sendFile(indexFile, (err) => {
    if (err) return next();
  });
});

// ============ 启动服务 ============
const PORT = 8000; // 或 process.env.PORT || 52367;

async function startup() {
  // perform AI validations and then start server
  try {
    await runStartupValidations();
  } catch (e) {
    console.error('Startup validation error (non-fatal):', e && e.stack ? e.stack : e);
  }

  app.listen(PORT, () => {
    console.log(`API & Web server listening on http://localhost:${PORT}`);
  });
}

startup();
