-- SQL 示例：创建 `ai_templates` 与 `ai_audit_log`（如果尚不存在），并插入若干示例template与audit记录

-- 创建 ai_templates 表（仅示例，按实际 schema 调整）
CREATE TABLE IF NOT EXISTS ai_templates (
  id INT AUTO_INCREMENT PRIMARY KEY,
  name VARCHAR(200) NOT NULL UNIQUE,
  description TEXT,
  prompt TEXT NOT NULL,
  variables_schema JSON DEFAULT NULL,
  visibility ENUM('global','project') DEFAULT 'global',
  project_id INT DEFAULT NULL,
  is_active TINYINT(1) DEFAULT 1,
  created_by INT DEFAULT NULL,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
);

-- 创建 ai_audit_log 表（仅示例）
CREATE TABLE IF NOT EXISTS ai_audit_log (
  id INT AUTO_INCREMENT PRIMARY KEY,
  job_id INT DEFAULT NULL,
  user_id INT DEFAULT NULL,
  event_type VARCHAR(100) NOT NULL,
  provider VARCHAR(100) DEFAULT NULL,
  model VARCHAR(200) DEFAULT NULL,
  request_payload JSON DEFAULT NULL,
  response_summary TEXT DEFAULT NULL,
  tokens_used INT DEFAULT NULL,
  cost DECIMAL(12,6) DEFAULT NULL,
  status VARCHAR(50) DEFAULT 'unknown',
  error TEXT DEFAULT NULL,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- 示例：插入若干 template
INSERT INTO ai_templates (name, description, prompt, variables_schema, visibility, is_active)
VALUES
('news_json_onepot', '新闻稿：强制输出 JSON（title, markdown, photos）的一锅出模板',
 -- prompt 样例（请按需要调整、escape）
 '请根据以下信息生成新闻稿并仅输出 JSON，schema: {"title","markdown","photos"}。photos 为数组，每项包含 {"id","url","alt","caption"}。markdown 中请用占位 PHOTO:id 表示图片位置，例如 ![图注](PHOTO:123)。若无法生成可用内容请返回 {"title":"","markdown":"","photos":[]}。',
 JSON_OBJECT('eventName','string','selectedPhotos','array'), 'global', 1),

('news_markdown_fallback', '若无法输出 JSON 时的 Markdown 回退模板（供后端回退解析）',
 '请根据以下信息生成一篇 Markdown 新闻稿，正文中以内嵌形式插入图片占位，格式为 ![图注](PHOTO:<id>)。第一行应为标题（以 # 开头）。不要输出额外的解释。',
 NULL, 'global', 1),

('image_caption_template', '只生成图题（若需要单独生成图题）',
 '请为所列图片生成每张图片的一句话图题（不超过20字），仅描述画面或意境，不能包含地点/时间/人名/具体数字。输出 JSON: [{"id":"123","caption":"..."}, ...]。',
 NULL, 'global', 1)
ON DUPLICATE KEY UPDATE updated_at = CURRENT_TIMESTAMP;

-- 示例：插入 ai_audit_log 的两条记录（成功与失败）
INSERT INTO ai_audit_log (job_id, user_id, event_type, provider, model, request_payload, response_summary, tokens_used, cost, status)
VALUES
(101, 12, 'text_generation', 'openai', 'gpt-4o-mini', JSON_OBJECT('prompt','<redacted>','max_tokens',1200), 'title: 测试活动; markdown_len: 234; photos: 3', 850, 0.0125, 'succeeded'),
(102, 12, 'text_generation', 'openai', 'gpt-4o-mini', JSON_OBJECT('prompt','<redacted>','max_tokens',1200), 'timeout after 15000ms', NULL, NULL, 'timeout');

-- 注意：示例 SQL 仅供参考，请在执行前在测试库验证。若已有表结构，请手动合并字段。

COMMIT;
