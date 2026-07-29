# MaMage Server 更新说明

## 2026-07-26 生产整合版（待发布）

本版本将联调阶段的独立视频后端能力合并进现有 MaMage Server。图库、真实项目、视频工程、AI 粗剪、对象存储和 FFmpeg 渲染现在由同一套生产后端提供。

### 视频工程 API

- 新增 `/api/video-projects`，提供工程的创建、读取、更新、删除和用户隔离。
- 新增视频素材上传、素材列表和媒体信息分析接口。
- 新增渲染任务创建、状态查询和取消接口。
- 所有视频工程接口继续使用现有 JWT，并要求 `ai.generate` 权限。
- 前端统一通过同源 `/api` 访问，不再需要 `/local-api` 或第二套视频服务。

### AI 自动粗剪

- 新增 `POST /api/ai/video/rough-cut`，根据提示词、目标时长、风格、项目上下文和素材元数据生成剪辑方案。
- 复用生产环境文本模型配置，支持通过 `AI_VIDEO_MODEL` 单独指定视频编排模型。
- 生产环境可通过 `VIDEO_AI_REQUIRE_MODEL=1` 强制要求真实模型可用，防止部署后静默使用本地兜底方案。
- AI 接口复用现有 `ai.generate` 权限和用户身份。

### 数据库和用户隔离

- 新增 `video_projects`、`video_editor_assets` 和 `video_render_jobs` 表。
- 工程时间线和剪辑参数保存在 `video_projects.project_json`，不依赖服务器本地工程文件。
- 工程、素材和渲染任务均按当前 `user_id` 查询和更新。
- 数据库迁移位于 `scripts/migrations/20260723_001_video_editor.sql`，可通过 `npm run db:migrate` 执行。

### 对象存储和媒体访问

- 视频源素材写入 `uploads/video-editor/assets/<org>/<user>/...`。
- 渲染结果写入 `uploads/video-editor/renders/<org>/<user>/<project>/<job>.mp4`。
- 支持 S3 兼容对象存储和现有 COS 配置方式。
- 媒体访问复用 `/api/image/*` 同源代理，并支持 HTTP Range，浏览器可以拖动视频播放时间。
- 支持签名媒体地址，避免前端长期保存可失效或可越权复用的对象地址。

### FFmpeg 渲染

- 服务端按时间线下载云端源文件、生成 FFmpeg 滤镜和拼接任务，并将 MP4 上传回对象存储。
- 支持普通视频片段、速度调整、静音处理以及不限时长的黑场留白片段。
- 新增可配置并发渲染队列、进度状态、任务取消和服务重启后的任务恢复。
- 每个任务使用独立的 `VIDEO_WORK_DIR` 临时目录，完成或失败后清理临时素材和输出文件。
- 可通过 `FFMPEG_PATH` 和 `FFPROBE_PATH` 指定生产服务器二进制文件。

### 部署与安全

- 新增生产环境变量示例，覆盖数据库、JWT、对象存储、媒体签名、FFmpeg、临时目录和 AI 模型。
- 新增 `npm run video:validate` 生产前置检查和 `npm run test:video` 视频逻辑测试。
- GitHub Actions 在数据库迁移和服务重启前执行视频生产配置检查。
- 提供 Nginx 配置示例，用于同源静态前端、`/api` 反向代理和视频 Range 转发。
- Access Key、Secret Key、数据库密码、JWT 密钥和模型密钥只允许写入服务器 `.env`，不得提交到仓库。

### 发布顺序

```bash
npm ci --omit=dev
npm run video:validate
npm run db:migrate
npm start
```

部署前应备份生产数据库，并确认 FFmpeg、对象存储读写权限和 `VIDEO_WORK_DIR` 可写。服务启动后需要检查 `/api/health`，再使用两个不同测试账号验证工程、素材和渲染任务之间的用户隔离。
