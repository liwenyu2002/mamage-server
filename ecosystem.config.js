// ecosystem.config.js
// PM2 生态配置文件
// 在 ECS 上使用此配置可以自动从系统环境变量读取密钥并注入到应用进程

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
        // 数据库配置
        DB_HOST: process.env.DB_HOST || '127.0.0.1',
        DB_PORT: process.env.DB_PORT || '3306',
        DB_USER: process.env.DB_USER || 'user',
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
        
        // 本地上传目录（可选）
        UPLOAD_ABS_DIR: process.env.UPLOAD_ABS_DIR || '',
        UPLOAD_SKIP_LOCAL_FILE_CHECK: process.env.UPLOAD_SKIP_LOCAL_FILE_CHECK || '1',
        
        // AI 配置（可选）
        DASHSCOPE_API_KEY: process.env.DASHSCOPE_API_KEY || '',
        OPENAI_API_KEY: process.env.OPENAI_API_KEY || '',
        AI_VISION_MODEL: process.env.AI_VISION_MODEL || 'qwen2-vl-72b-instruct',
        
        // CORS
        CORS_ORIGIN: process.env.CORS_ORIGIN || 'http://localhost:5173'
      },
      
      // ===== 日志配置 =====
      output: '/var/log/mamage-server/out.log',
      error: '/var/log/mamage-server/error.log',
      log_date_format: 'YYYY-MM-DD HH:mm:ss Z',
      
      // ===== 自动重启策略 =====
      autorestart: true,
      max_restarts: 10,
      min_uptime: '10s',
      
      // ===== 优雅关闭 =====
      kill_timeout: 5000,
      wait_ready: true,
      
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
