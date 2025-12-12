# AI 表说明（`ai_templates`、`ai_audit_log`）

本文档解释仓库中两个与 AI 功能相关的表：`ai_templates` 与 `ai_audit_log`，并给出使用建议与示例。

## ai_templates — 用途
- 存放可复用的 Prompt 模板（用于生成新闻稿、图题、摘要等）。
- 每条模板包含：模板名、描述、prompt 文本、变量占位说明、可见性（全局/项目）、是否启用等。
- 作用场景：
  - 后端在 `routes/ai_news.js` 或其它 AI 路由中，根据业务类型选择模板并以 `variables` 填充后发送给模型。
  - 方便 A/B 测试不同提示词、保存运营常用模板、回溯生成来源。

### 推荐字段（说明）
- `id`：主键。
- `name`：模板短名，例如 `news_json_onepot`。
- `description`：模板用途简述。
- `prompt`：模板主体文本（可包含占位符，如 `{{eventName}}`、`{{photos}}`）。
- `variables_schema`：可选，JSON 字段，描述必须提供哪些变量及其类型（方便前端/后端校验）。
- `created_by`、`created_at`、`updated_at`：审计字段。
- `is_active`：是否启用。
- `visibility`：`global` 或 `project`，若为 `project` 则需要 `project_id` 关联。

## ai_audit_log — 用途
- 记录每次调用 AI 的审计信息与元数据，用于排查、计费估算、安全与合规。
- 常用于：记录请求/响应摘要、模型/提供商、消耗 tokens、异常 stack、request_id、job_id 等。

### 推荐字段（说明）
- `id`：主键。
- `job_id`：若为由 ai_jobs 发起的调用，关联该作业 ID。
- `user_id`：触发请求的用户 ID（或 null）。
- `event_type`：调用类型，例如 `text_generation`、`vision_tagging`、`system_validation`。
- `provider`：例如 `openai`、`dashscope`、`mock`。
- `model`：模型名或版本，例如 `gpt-4o-mini`。
- `request_payload`：请求体的 JSON（短小或已脱敏）。
- `response_summary`：对响应的简短摘要或关键字段（title、markdown 长度、photos count 等）。
- `tokens_used`、`cost`：若可用，记录消耗。
- `status`：`succeeded`、`failed`、`timeout`。
- `error`：若失败，记录错误信息或代码路径（注意敏感信息脱敏）。
- `created_at`：时间戳。

## 使用建议
- 模板：后端读取 `ai_templates`，用模板引擎（例如简单的 replace 或 mustache）替换变量并形成最终 prompt。
- 审计：每次调用模型前后都写一条 `ai_audit_log`；成功时记录 summary 与 tokens；失败时记录 error 并关联 job。
- 隐私：`request_payload` 中不要写入明文密钥、完整 PII（可脱敏或仅存 hash/标识）。

## 示例：模板示例意图（摘录）
- `news_json_onepot`：要求模型输出纯 JSON，遵守 `title, markdown, photos[]` schema（photos 中 id/url/alt）。
- `news_markdown_fallback`：如果 JSON 失败，生成标准 Markdown（内含 `![图注](PHOTO:<id>)` 占位），便于后端回退解析。


---

文件：`db/seed_ai_templates.sql` 与 `db/seed_ai_audit_log.sql` 提供创建/示例插入 SQL。请根据你的生产/测试环境审查并执行。