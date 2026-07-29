// ecosystem.config.js
// PM2 生态配置文件
// 在 ECS 上使用此配置可以自动从系统环境变量读取密钥并注入到应用进程
const path = require('path');
require('dotenv').config({ path: path.resolve(__dirname, '.env') });

module.exports = {
  apps: [
    {
      name: 'mamage-server',
      script: './app.js',
      instances: 1,
      exec_mode: 'cluster',
      watch: false,
      max_memory_restart: '500M',
      
      // ===== 关键：环境变量注入 =====
      // PM2 会在启动时从系统环境变量读取这些值并传给应用进程
      // 确保在 ECS 启动脚本或 systemd service 中设置了这些环境变量
      env: {
        NODE_ENV: 'production',
        PORT: process.env.PORT || '8080',
        // 数据库配置
        DB_HOST: process.env.DB_HOST || 'localhost',
        DB_PORT: process.env.DB_PORT || '3306',
        DB_USER: process.env.DB_USER || 'root',
        DB_PASSWORD: process.env.DB_PASSWORD || '',
        DB_NAME: process.env.DB_NAME || 'mamage',
        
        // JWT
        JWT_SECRET: process.env.JWT_SECRET || '',
        
        // COS 配置（可选）
        UPLOAD_BASE_URL: process.env.UPLOAD_BASE_URL || '',
        COS_SECRET_ID: process.env.COS_SECRET_ID || '',
        COS_SECRET_KEY: process.env.COS_SECRET_KEY || '',
        COS_BUCKET: process.env.COS_BUCKET || '',
        COS_REGION: process.env.COS_REGION || '',
        COS_BASE_URL: process.env.COS_BASE_URL || '',
        COS_FORCE_PATH_STYLE: process.env.COS_FORCE_PATH_STYLE || '1',
        COS_TLS_REJECT_UNAUTHORIZED: process.env.COS_TLS_REJECT_UNAUTHORIZED || '1',
        MEDIA_URL_SIGNING: process.env.MEDIA_URL_SIGNING || '1',
        MEDIA_URL_SECRET: process.env.MEDIA_URL_SECRET || '',
        MEDIA_URL_TTL_DAYS: process.env.MEDIA_URL_TTL_DAYS || '8',
        IMAGE_PROXY_KEY_PREFIXES: process.env.IMAGE_PROXY_KEY_PREFIXES || 'uploads/',

        // 视频编辑器：临时工作目录必须位于代码目录之外
        VIDEO_WORK_DIR: process.env.VIDEO_WORK_DIR || path.join(process.env.HOME || __dirname, 'mamage-data', 'video-work'),
        VIDEO_WORK_MAX_AGE_MS: process.env.VIDEO_WORK_MAX_AGE_MS || '86400000',
        VIDEO_UPLOAD_MAX_MB: process.env.VIDEO_UPLOAD_MAX_MB || '5120',
        VIDEO_DIRECT_UPLOAD_TTL_MINUTES: process.env.VIDEO_DIRECT_UPLOAD_TTL_MINUTES || '30',
        VIDEO_DIRECT_UPLOAD_MAX_EXPIRES_SECONDS: process.env.VIDEO_DIRECT_UPLOAD_MAX_EXPIRES_SECONDS || '21600',
        VIDEO_DIRECT_UPLOAD_ESTIMATED_BYTES_PER_SECOND: process.env.VIDEO_DIRECT_UPLOAD_ESTIMATED_BYTES_PER_SECOND || '786432',
        VIDEO_RENDER_CONCURRENCY: process.env.VIDEO_RENDER_CONCURRENCY || '1',
        VIDEO_RENDER_RECOVER_ON_BOOT: process.env.VIDEO_RENDER_RECOVER_ON_BOOT || '1',
        FFMPEG_PATH: process.env.FFMPEG_PATH || 'ffmpeg',
        FFPROBE_PATH: process.env.FFPROBE_PATH || 'ffprobe',
        
        // 本地上传目录（可选）
        UPLOAD_ABS_DIR: process.env.UPLOAD_ABS_DIR || '',
        UPLOAD_SKIP_LOCAL_FILE_CHECK: process.env.UPLOAD_SKIP_LOCAL_FILE_CHECK || '1',
        
        // AI 配置（可选）
        DASHSCOPE_API_KEY: process.env.DASHSCOPE_API_KEY || '',
        AI_VISION_API_KEY: process.env.AI_VISION_API_KEY || '',
        DASHSCOPE_BASE_URL: process.env.DASHSCOPE_BASE_URL || '',
        OPENAI_API_KEY: process.env.OPENAI_API_KEY || '',
        AI_TEXT_API_KEY: process.env.AI_TEXT_API_KEY || '',
        AI_TEXT_BASE_URL: process.env.AI_TEXT_BASE_URL || '',
        AI_TEXT_MODEL: process.env.AI_TEXT_MODEL || '',
        AI_VIDEO_MODEL: process.env.AI_VIDEO_MODEL || '',
        VIDEO_AI_REQUIRE_MODEL: process.env.VIDEO_AI_REQUIRE_MODEL || '0',
        AI_VISION_PROVIDER: process.env.AI_VISION_PROVIDER || 'dashscope',
        AI_VISION_MODEL: process.env.AI_VISION_MODEL || 'qwen2-vl-72b-instruct',
        AI_VISION_FALLBACK_PROVIDER: process.env.AI_VISION_FALLBACK_PROVIDER || '',
        AI_REQUEST_TIMEOUT_MS: process.env.AI_REQUEST_TIMEOUT_MS || '60000',
        OLLAMA_BASE_URL: process.env.OLLAMA_BASE_URL || 'http://127.0.0.1:11434',
        OLLAMA_VISION_MODEL: process.env.OLLAMA_VISION_MODEL || 'qwen2.5vl:3b',
        OLLAMA_REQUEST_TIMEOUT_MS: process.env.OLLAMA_REQUEST_TIMEOUT_MS || '120000',
        
        // CORS
        CORS_ORIGIN: process.env.CORS_ORIGIN || [
          'http://localhost:5173',
          'http://127.0.0.1:5173',
          'http://localhost:5188',
          'http://127.0.0.1:5188',
          'http://10.100.65.147:3000',
          'http://10.100.83.67:3000',
          'https://mamage.wenyuli.site',
          'https://lan.mamage.wenyuli.site',
          'https://lan.mamage.wenyuli.site:3443',
          'http://mamage.wenyuli.site',
        ].join(',')
      },
      
      // ===== 日志配置 =====
      output: path.join(__dirname, 'logs', 'out.log'),
      error: path.join(__dirname, 'logs', 'error.log'),
      log_date_format: 'YYYY-MM-DD HH:mm:ss Z',
      
      // ===== 自动重启策略 =====
      autorestart: true,
      max_restarts: 10,
      min_uptime: '10s',
      
      // ===== 优雅关闭 =====
      kill_timeout: 5000,
      wait_ready: false,
      
      // ===== 监听特定端口以判断应用是否就绪 =====
      listen_timeout: 10000
    }
  ],

  // ===== 部署配置（可选） =====
  deploy: {
    production: {
      user: process.env.DEPLOY_USER || 'liwy',
      host: process.env.DEPLOY_HOST || 'your-ecs-ip',
      port: process.env.DEPLOY_PORT || '22',
      ref: 'origin/main',
      repo: 'https://github.com/liwenyu2002/mamage-server.git',
      path: '/home/liwy/mamage-server',
      
      'post-deploy': `npm install --omit=dev && \
                      pm2 restart ecosystem.config.js --env production && \
                      pm2 save`
    }
  }
};
