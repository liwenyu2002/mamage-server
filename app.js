// backend/app.js锛堝畬鏁寸ず渚嬶級
// Load local .env in development (optional). Ensure .env is in .gitignore.
try { require('dotenv').config(); } catch (e) { }
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
      if (res.vision.ok) console.log('鉁?Vision AI key & model validated');
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

const app = express();

app.use(express.json({ limit: '2mb' }));
app.use(express.urlencoded({ extended: true, limit: '2mb' }));

// ============ CORS锛堜繚鐣欎綘鐨勯€昏緫锛?============
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

// ============ /uploads 闈欐€佹枃浠讹紙浣犲師鏉ョ殑閫昏緫锛?============
const keys = require('./config/keys');
const uploadsAbsDir = keys.UPLOAD_ABS_DIR || path.join(__dirname, 'uploads');

const staticUploadsDir = uploadsAbsDir.replace(/\\/g, '/').toLowerCase().endsWith('/uploads')
  ? uploadsAbsDir
  : path.join(uploadsAbsDir, 'uploads');

app.use('/uploads', express.static(staticUploadsDir));
// ============ 鏃ュ織 ============
app.use((req, res, next) => {
  console.log(`${req.method} ${req.url}`);
  next();
});

// ============ API 璺敱 ============
app.use('/api/projects', projectsRouter);
app.use('/api/photos', photosRouter);
app.use('/api/upload', uploadRouter);
app.use('/api/users', usersRouter);
app.use('/api/ai/news', aiNewsRouter);
app.use('/api/organizations', orgsRouter);
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
}

startup();






