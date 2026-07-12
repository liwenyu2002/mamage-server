-- 收藏新增 snippet 类型（画布框选保存的元素片段）。kind 是 ENUM，加值必须 ALTER 扩枚举，
-- 否则 INSERT 'snippet' 会被 MySQL 静默截断（Data truncated for column 'kind'）。
ALTER TABLE user_favorites
  MODIFY COLUMN kind ENUM('styleBlock','photo','snippet') NOT NULL;
