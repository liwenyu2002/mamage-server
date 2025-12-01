-- Migration: add email, avatar_url, nickname to users table
-- Run this after backing up your database.

ALTER TABLE `users`
  ADD COLUMN `email` varchar(255) DEFAULT NULL COMMENT '用户邮箱' AFTER `student_no`,
  ADD COLUMN `avatar_url` varchar(255) DEFAULT NULL COMMENT '用户头像 URL' AFTER `email`,
  ADD COLUMN `nickname` varchar(100) DEFAULT NULL COMMENT '用户昵称' AFTER `avatar_url`;

-- Notes:
-- 1) This adds nullable columns so it is safe for existing rows.
-- 2) If you want `email` to be unique, run:
--    ALTER TABLE `users` ADD UNIQUE KEY `uk_users_email` (`email`);
--    but ensure existing data does not violate uniqueness first.
