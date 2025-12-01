// app.js（节选）
const express = require('express');
const path = require('path');
const projectsRouter = require('./routes/projects');
const photosRouter = require('./routes/photos');
const uploadRouter = require('./routes/upload'); // ✨ 一会儿会新建这个文件
const usersRouter = require('./routes/users');

const app = express();

app.use(express.json());
app.use(express.urlencoded({ extended: true })); 
// 静态文件：对外暴露 /uploads
// 支持用环境变量指定本地 uploads 的绝对目录（例如 Windows: C:/ALL/MaMage/Photo_Base）
const uploadsAbsDir = process.env.UPLOAD_ABS_DIR || path.join(__dirname, 'uploads');
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
