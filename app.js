// backend/app.js（完整示例）
// Load local .env in development (optional). Ensure .env is in .gitignore.
try { require('dotenv').config(); } catch (e) {}

const express = require('express');
const path = require('path');
const projectsRouter = require('./routes/projects');
const photosRouter = require('./routes/photos');
const uploadRouter = require('./routes/upload');
const usersRouter = require('./routes/users');

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
const distPath = path.join(__dirname, '..',  'MaMage_Web', 'dist');

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

app.get('/api/health', (req, res) => {
  res.json({ status: 'ok' });
});

// ============ ★ 新增：SPA 回退路由 ============
/**
 * 除了 /api 和 /uploads 开头的请求外，其它所有 GET 请求，都返回 dist/index.html，
 * 让 React Router 自己在前端接管路由。
 */
app.get('/{*splat}', (req, res, next) => {
  if (req.path.startsWith('/api') || req.path.startsWith('/uploads')) {
    return next(); // 交给上面的路由或 404 处理
  }
  res.sendFile(path.join(distPath, 'index.html'));
});

// ============ 启动服务 ============
const PORT = 52367; // 或 process.env.PORT || 52367;
app.listen(PORT, () => {
  console.log(`API & Web server listening on http://localhost:${PORT}`);
});
