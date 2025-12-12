// scripts/check_env_vars.js
// 安全检查脚本：只检查关键 env 变量是否存在并显示长度（不泄露完整密钥）
require('dotenv').config();
const keys = [
  'AI_TEXT_API_KEY', 'OPENAI_API_KEY', 'AI_TEXT_MODEL', 'OPENAI_MODEL',
  'DASHSCOPE_API_KEY', 'AI_VISION_API_KEY', 'AI_VISION_MODEL',
  'COS_SECRET_ID', 'COS_SECRET_KEY', 'COS_BUCKET'
];

function safeInfo(val) {
  if (val === undefined || val === null) return { present: false };
  const s = String(val);
  return { present: true, len: s.length, startsWith: s.slice(0,4) };
}

const out = {};
for (const k of keys) {
  out[k] = safeInfo(process.env[k]);
}

console.log('Env check (present/length/startsWith(4)):');
for (const k of keys) {
  const v = out[k];
  if (!v.present) console.log(`${k}: MISSING`);
  else console.log(`${k}: PRESENT (len=${v.len}, startsWith='${v.startsWith.replace(/\n/g,'\\n')}')`);
}

console.log('\nNote: This script does NOT print secret values.');
console.log('If a variable is MISSING, ensure you edited .env and restarted the Node process.');
