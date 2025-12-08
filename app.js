// app.js（节选）
// Load local .env in development (optional). Ensure .env is in .gitignore.
try { require('dotenv').config(); } catch (e) {}
const express = require('express');
const path = require('path');
const projectsRouter = require('./routes/projects');
const photosRouter = require('./routes/photos');
const uploadRouter = require('./routes/upload'); // ✨ 一会儿会新建这个文件
const usersRouter = require('./routes/users');

const app = express();

app.use(express.json());
app.use(express.urlencoded({ extended: true })); 
// 简单 CORS 中间件：开发时允许来自前端开发服务器的跨域请求
// 可通过环境变量 `CORS_ORIGIN` 覆盖（例如: http://localhost:5173 或 *）
const corsOrigin = process.env.CORS_ORIGIN || 'http://localhost:5173';
app.use((req, res, next) => {
  const origin = req.get('origin');
  // 如果显式配置了 CORS_ORIGIN，则使用它；否则使用请求的 Origin 或默认值
  const allow = process.env.CORS_ORIGIN || origin || corsOrigin;
  if (allow) res.setHeader('Access-Control-Allow-Origin', allow);
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PUT,DELETE,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type,Authorization');
  res.setHeader('Access-Control-Allow-Credentials', 'true');
  if (req.method === 'OPTIONS') return res.status(204).end();
  next();
});
// 静态文件：对外暴露 /uploads
// 支持用环境变量或 config/keys 指定本地 uploads 的绝对目录（例如 Windows: C:/ALL/MaMage/Photo_Base）
const keys = require('./config/keys');
const uploadsAbsDir = keys.UPLOAD_ABS_DIR || path.join(__dirname, 'uploads');
// 如果用户传入的是父目录（例如 C:/ALL/MaMage/Photo_Base），常见情况是实际文件在其下的 'uploads' 子目录。
// 这里做兼容：如果路径已经以 'uploads' 结尾则直接使用，否则使用其下的 'uploads' 子目录。
const staticUploadsDir = uploadsAbsDir.replace(/\\/g, '/').toLowerCase().endsWith('/uploads')
  ? uploadsAbsDir
  : path.join(uploadsAbsDir, 'uploads');
app.use('/uploads', express.static(staticUploadsDir));

// (已移除临时调试路由)

// 日志
app.use((req, res, next) => {
  console.log(`${req.method} ${req.url}`);
  next();
});

// 路由挂载
app.use('/api/projects', projectsRouter);
app.use('/api/photos', photosRouter);
app.use('/api/upload', uploadRouter);  // ✨ 上传相关接口
app.use('/api/users', usersRouter);

app.get('/api/health', (req, res) => {
  res.json({ status: 'ok' });
});

const PORT = 3000;
app.listen(PORT, () => {
  console.log(`API server listening on port ${PORT}`);
});
