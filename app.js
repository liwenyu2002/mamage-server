// app.js（节选）
const express = require('express');
const path = require('path');
const projectsRouter = require('./routes/projects');
const photosRouter = require('./routes/photos');
const uploadRouter = require('./routes/upload'); // ✨ 一会儿会新建这个文件

const app = express();

app.use(express.json());
app.use(express.urlencoded({ extended: true })); 
// 静态文件：对外暴露 /uploads
app.use('/uploads', express.static(path.join(__dirname, 'uploads')));

// 日志
app.use((req, res, next) => {
  console.log(`${req.method} ${req.url}`);
  next();
});

// 路由挂载
app.use('/api/projects', projectsRouter);
app.use('/api/photos', photosRouter);
app.use('/api/upload', uploadRouter);  // ✨ 上传相关接口

app.get('/api/health', (req, res) => {
  res.json({ status: 'ok' });
});

const PORT = 3000;
app.listen(PORT, () => {
  console.log(`API server listening on port ${PORT}`);
});
