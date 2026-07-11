-- 钉钉登录：unionId 绑定列（同一钉钉企业内用户的稳定标识）
ALTER TABLE users
  ADD COLUMN dingtalk_union_id VARCHAR(64) NULL AFTER email,
  ADD UNIQUE KEY uq_users_dingtalk_union (dingtalk_union_id);
