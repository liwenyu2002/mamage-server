// lib/validateEnv.js
// 在应用启动前检查必需的环境变量
// 如果缺少关键配置，应用拒绝启动并打印清晰的错误提示

const requiredEnvVars = [
  'JWT_SECRET',
  'DB_HOST',
  'DB_PORT',
  'DB_USER',
  'DB_PASSWORD',
  'DB_NAME'
];

const optionalButRecommended = [
  'UPLOAD_BASE_URL',
  'COS_SECRET_ID',
  'COS_SECRET_KEY',
  'COS_BUCKET',
  'COS_REGION'
];

const aiRelated = [
  'DASHSCOPE_API_KEY'
];

/**
 * 验证环境变量
 * @param {boolean} strict - 如果为 true，缺少推荐变量也会发出警告
 * @throws {Error} 如果缺少必需的环境变量
 */
function validateEnvironment(strict = false) {
  const missing = [];
  const warnings = [];

  // 检查必需变量
  for (const key of requiredEnvVars) {
    const val = process.env[key];
    if (!val || String(val).trim() === '') {
      missing.push(key);
    }
  }

  // 检查推荐变量
  if (strict) {
    for (const key of optionalButRecommended) {
      const val = process.env[key];
      if (!val || String(val).trim() === '') {
        warnings.push(`⚠ 推荐配置 ${key}（用于 COS 对象存储）`);
      }
    }

    // 如果启用了 AI，检查 DASHSCOPE_API_KEY
    const cosConfigured = process.env.COS_SECRET_ID && process.env.COS_SECRET_KEY;
    if (!cosConfigured) {
      for (const key of aiRelated) {
        const val = process.env[key];
        if (!val || String(val).trim() === '') {
          warnings.push(`⚠ 如需 AI 图像分析，请配置 ${key}`);
        }
      }
    }
  }

  // 如果有缺失的必需变量，抛出错误
  if (missing.length > 0) {
    const errorMsg = `
❌ 应用启动失败：缺少必需的环境变量

缺失项：
${missing.map(k => `  - ${k}`).join('\n')}

解决方案：
1. 本地开发：复制 .env.example 为 .env 并填写所有值
2. 部署到 ECS：
   - 在 ECS 环境变量中设置上述值
   - 或在启动脚本中导出这些变量
   - 或使用 PM2 ecosystem.config.js 注入

示例 .env 文件：
  JWT_SECRET=your-secret-key
  DB_HOST=127.0.0.1
  DB_PORT=3306
  DB_USER=user
  DB_PASSWORD=320911
  DB_NAME=mamage
  UPLOAD_BASE_URL=https://your-cos-bucket.cos.ap-beijing.myqcloud.com

更多详情见 .env.example 和 README.md
    `.trim();
    throw new Error(errorMsg);
  }

  // 打印警告（如果有）
  if (warnings.length > 0) {
    console.warn('\n📋 环境配置警告：');
    warnings.forEach(w => console.warn(w));
    console.warn('');
  }

  // 打印成功信息
  console.log('✅ 环境变量检查通过');
  console.log(`   - JWT_SECRET: 已配置`);
  console.log(`   - 数据库: ${process.env.DB_USER}@${process.env.DB_HOST}:${process.env.DB_PORT}/${process.env.DB_NAME}`);
  if (process.env.UPLOAD_BASE_URL) {
    console.log(`   - COS 基础 URL: ${process.env.UPLOAD_BASE_URL}`);
  }
  if (process.env.DASHSCOPE_API_KEY) {
    console.log(`   - AI 分析: 已启用`);
  }
}

module.exports = { validateEnvironment };
