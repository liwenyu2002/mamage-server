-- MySQL dump 10.13  Distrib 8.0.44, for Win64 (x86_64)
--
-- Host: 127.0.0.1    Database: mamage
-- ------------------------------------------------------
-- Server version	8.0.44

/*!40101 SET @OLD_CHARACTER_SET_CLIENT=@@CHARACTER_SET_CLIENT */;
/*!40101 SET @OLD_CHARACTER_SET_RESULTS=@@CHARACTER_SET_RESULTS */;
/*!40101 SET @OLD_COLLATION_CONNECTION=@@COLLATION_CONNECTION */;
/*!50503 SET NAMES utf8mb4 */;
/*!40103 SET @OLD_TIME_ZONE=@@TIME_ZONE */;
/*!40103 SET TIME_ZONE='+00:00' */;
/*!40014 SET @OLD_UNIQUE_CHECKS=@@UNIQUE_CHECKS, UNIQUE_CHECKS=0 */;
/*!40014 SET @OLD_FOREIGN_KEY_CHECKS=@@FOREIGN_KEY_CHECKS, FOREIGN_KEY_CHECKS=0 */;
/*!40101 SET @OLD_SQL_MODE=@@SQL_MODE, SQL_MODE='NO_AUTO_VALUE_ON_ZERO' */;
/*!40111 SET @OLD_SQL_NOTES=@@SQL_NOTES, SQL_NOTES=0 */;

--
-- Table structure for table `ai_audit_log`
--

DROP TABLE IF EXISTS `ai_audit_log`;
/*!40101 SET @saved_cs_client     = @@character_set_client */;
/*!50503 SET character_set_client = utf8mb4 */;
CREATE TABLE `ai_audit_log` (
  `id` bigint NOT NULL AUTO_INCREMENT,
  `job_id` bigint DEFAULT NULL,
  `action` varchar(255) DEFAULT NULL,
  `actor` varchar(255) DEFAULT NULL,
  `note` text,
  `timestamp` datetime DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  KEY `job_id` (`job_id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;
/*!40101 SET character_set_client = @saved_cs_client */;

--
-- Table structure for table `ai_jobs`
--

DROP TABLE IF EXISTS `ai_jobs`;
/*!40101 SET @saved_cs_client     = @@character_set_client */;
/*!50503 SET character_set_client = utf8mb4 */;
CREATE TABLE `ai_jobs` (
  `id` bigint NOT NULL AUTO_INCREMENT,
  `user_id` bigint DEFAULT NULL,
  `project_id` bigint DEFAULT NULL,
  `status` varchar(32) NOT NULL DEFAULT 'pending',
  `model` varchar(128) DEFAULT NULL,
  `prompt_text` longtext,
  `options` json DEFAULT NULL,
  `client_request_id` varchar(255) DEFAULT NULL,
  `tokens_used` bigint DEFAULT NULL,
  `cost_estimate` decimal(18,6) DEFAULT NULL,
  `error` text,
  `started_at` datetime DEFAULT NULL,
  `finished_at` datetime DEFAULT NULL,
  `created_at` datetime DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  KEY `user_id` (`user_id`),
  KEY `project_id` (`project_id`),
  KEY `status` (`status`)
) ENGINE=InnoDB AUTO_INCREMENT=51 DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;
/*!40101 SET character_set_client = @saved_cs_client */;

--
-- Table structure for table `ai_results`
--

DROP TABLE IF EXISTS `ai_results`;
/*!40101 SET @saved_cs_client     = @@character_set_client */;
/*!50503 SET character_set_client = utf8mb4 */;
CREATE TABLE `ai_results` (
  `id` bigint NOT NULL AUTO_INCREMENT,
  `job_id` bigint NOT NULL,
  `title` varchar(255) DEFAULT NULL,
  `subtitle` varchar(255) DEFAULT NULL,
  `markdown` longtext,
  `html` longtext,
  `placeholders` json DEFAULT NULL,
  `created_at` datetime DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  KEY `job_id` (`job_id`)
) ENGINE=InnoDB AUTO_INCREMENT=50 DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;
/*!40101 SET character_set_client = @saved_cs_client */;

--
-- Table structure for table `ai_templates`
--

DROP TABLE IF EXISTS `ai_templates`;
/*!40101 SET @saved_cs_client     = @@character_set_client */;
/*!50503 SET character_set_client = utf8mb4 */;
CREATE TABLE `ai_templates` (
  `id` bigint NOT NULL AUTO_INCREMENT,
  `org_id` bigint DEFAULT NULL,
  `name` varchar(255) NOT NULL,
  `template_text` longtext,
  `created_at` datetime DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;
/*!40101 SET character_set_client = @saved_cs_client */;

--
-- Table structure for table `invitations`
--

DROP TABLE IF EXISTS `invitations`;
/*!40101 SET @saved_cs_client     = @@character_set_client */;
/*!50503 SET character_set_client = utf8mb4 */;
CREATE TABLE `invitations` (
  `id` int NOT NULL AUTO_INCREMENT,
  `code` varchar(128) COLLATE utf8mb4_unicode_ci NOT NULL,
  `role` varchar(50) COLLATE utf8mb4_unicode_ci NOT NULL,
  `created_by` int DEFAULT NULL,
  `created_at` datetime DEFAULT CURRENT_TIMESTAMP,
  `expires_at` datetime DEFAULT NULL,
  `max_uses` int DEFAULT '1',
  `uses` int DEFAULT '0',
  `revoked` tinyint(1) DEFAULT '0',
  `note` varchar(255) COLLATE utf8mb4_unicode_ci DEFAULT NULL,
  PRIMARY KEY (`id`),
  UNIQUE KEY `code` (`code`)
) ENGINE=InnoDB AUTO_INCREMENT=3 DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
/*!40101 SET character_set_client = @saved_cs_client */;

--
-- Table structure for table `organizations`
--

DROP TABLE IF EXISTS `organizations`;
/*!40101 SET @saved_cs_client     = @@character_set_client */;
/*!50503 SET character_set_client = utf8mb4 */;
CREATE TABLE `organizations` (
  `id` int unsigned NOT NULL AUTO_INCREMENT,
  `name` varchar(150) NOT NULL,
  `slug` varchar(100) DEFAULT NULL,
  `created_at` datetime NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uk_organizations_slug` (`slug`)
) ENGINE=InnoDB AUTO_INCREMENT=3 DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;
/*!40101 SET character_set_client = @saved_cs_client */;

--
-- Table structure for table `photos`
--

DROP TABLE IF EXISTS `photos`;
/*!40101 SET @saved_cs_client     = @@character_set_client */;
/*!50503 SET character_set_client = utf8mb4 */;
CREATE TABLE `photos` (
  `id` int unsigned NOT NULL AUTO_INCREMENT COMMENT '照片主键ID',
  `uuid` char(36) NOT NULL COMMENT '照片对外 UUID',
  `project_id` int unsigned DEFAULT NULL COMMENT '关联项目ID，指向 projects.id',
  `url` varchar(255) NOT NULL COMMENT '原图相对 URL',
  `thumb_url` varchar(255) DEFAULT NULL COMMENT '缩略图相对 URL',
  `title` varchar(200) DEFAULT NULL COMMENT '标题',
  `tags` json DEFAULT NULL COMMENT '标签 JSON，比如 ["毕业","合影"]',
  `type` varchar(50) NOT NULL DEFAULT 'normal' COMMENT '类型，如 normal/cover 等',
  `created_at` datetime NOT NULL DEFAULT CURRENT_TIMESTAMP COMMENT '创建时间',
  `updated_at` datetime NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP COMMENT '更新时间',
  `capture_time` date DEFAULT NULL,
  `photographer_id` int unsigned DEFAULT NULL COMMENT '上传该照片的摄影师用户id，关联 users.id',
  `description` text,
  `organization_id` int unsigned NOT NULL,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uk_photos_uuid` (`uuid`),
  KEY `idx_photos_project_id` (`project_id`),
  KEY `idx_photos_created_at` (`created_at`),
  KEY `idx_photos_org` (`organization_id`),
  CONSTRAINT `fk_photos_project` FOREIGN KEY (`project_id`) REFERENCES `projects` (`id`) ON DELETE SET NULL ON UPDATE CASCADE
) ENGINE=InnoDB AUTO_INCREMENT=269 DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;
/*!40101 SET character_set_client = @saved_cs_client */;

--
-- Table structure for table `projects`
--

DROP TABLE IF EXISTS `projects`;
/*!40101 SET @saved_cs_client     = @@character_set_client */;
/*!50503 SET character_set_client = utf8mb4 */;
CREATE TABLE `projects` (
  `id` int unsigned NOT NULL AUTO_INCREMENT COMMENT '项目自增主键',
  `uuid` char(36) NOT NULL COMMENT '项目 UUID',
  `name` varchar(200) NOT NULL COMMENT '项目名称',
  `description` text COMMENT '项目描述',
  `event_date` date DEFAULT NULL,
  `meta` json DEFAULT NULL COMMENT '额外元数据，JSON',
  `photo_ids` json DEFAULT NULL COMMENT '照片 id 列表（冗余字段，可选）',
  `tags` text,
  `created_at` datetime NOT NULL DEFAULT CURRENT_TIMESTAMP COMMENT '创建时间',
  `updated_at` datetime NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP COMMENT '更新时间',
  `admin_id` int unsigned DEFAULT NULL COMMENT '管理员用户id，关联 users.id',
  `organization_id` int unsigned NOT NULL,
  `type` varchar(255) DEFAULT NULL,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uk_projects_uuid` (`uuid`),
  KEY `idx_projects_org` (`organization_id`)
) ENGINE=InnoDB AUTO_INCREMENT=41 DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;
/*!40101 SET character_set_client = @saved_cs_client */;

--
-- Table structure for table `role_permissions`
--

DROP TABLE IF EXISTS `role_permissions`;
/*!40101 SET @saved_cs_client     = @@character_set_client */;
/*!50503 SET character_set_client = utf8mb4 */;
CREATE TABLE `role_permissions` (
  `id` int NOT NULL AUTO_INCREMENT,
  `role` varchar(64) NOT NULL,
  `permission` varchar(128) NOT NULL,
  `created_at` timestamp NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_role_permission` (`role`,`permission`)
) ENGINE=InnoDB AUTO_INCREMENT=44 DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;
/*!40101 SET character_set_client = @saved_cs_client */;

--
-- Table structure for table `share_link_items`
--

DROP TABLE IF EXISTS `share_link_items`;
/*!40101 SET @saved_cs_client     = @@character_set_client */;
/*!50503 SET character_set_client = utf8mb4 */;
CREATE TABLE `share_link_items` (
  `id` int unsigned NOT NULL AUTO_INCREMENT,
  `share_id` int unsigned NOT NULL,
  `photo_id` int unsigned NOT NULL,
  `sort_order` int unsigned NOT NULL DEFAULT '0',
  `created_at` datetime NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uk_share_link_items_share_photo` (`share_id`,`photo_id`),
  KEY `idx_share_link_items_share_id` (`share_id`),
  KEY `idx_share_link_items_photo_id` (`photo_id`),
  CONSTRAINT `fk_share_link_items_photo` FOREIGN KEY (`photo_id`) REFERENCES `photos` (`id`) ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT `fk_share_link_items_share` FOREIGN KEY (`share_id`) REFERENCES `share_links` (`id`) ON DELETE CASCADE ON UPDATE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;
/*!40101 SET character_set_client = @saved_cs_client */;

--
-- Table structure for table `share_links`
--

DROP TABLE IF EXISTS `share_links`;
/*!40101 SET @saved_cs_client     = @@character_set_client */;
/*!50503 SET character_set_client = utf8mb4 */;
CREATE TABLE `share_links` (
  `id` int unsigned NOT NULL AUTO_INCREMENT,
  `code` varchar(64) NOT NULL,
  `share_type` varchar(32) NOT NULL COMMENT 'project | collection',
  `project_id` int unsigned DEFAULT NULL COMMENT 'share_type=project 时填写',
  `title` varchar(255) DEFAULT NULL,
  `note` varchar(255) DEFAULT NULL,
  `created_by` int unsigned NOT NULL,
  `organization_id` int unsigned NOT NULL,
  `expires_at` datetime DEFAULT NULL,
  `revoked_at` datetime DEFAULT NULL,
  `created_at` datetime NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at` datetime NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uk_share_links_code` (`code`),
  KEY `idx_share_links_org` (`organization_id`),
  KEY `idx_share_links_created_by` (`created_by`),
  KEY `idx_share_links_project_id` (`project_id`),
  KEY `idx_share_links_expires_at` (`expires_at`),
  KEY `idx_share_links_revoked_at` (`revoked_at`),
  CONSTRAINT `fk_share_links_created_by` FOREIGN KEY (`created_by`) REFERENCES `users` (`id`) ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT `fk_share_links_org` FOREIGN KEY (`organization_id`) REFERENCES `organizations` (`id`) ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT `fk_share_links_project` FOREIGN KEY (`project_id`) REFERENCES `projects` (`id`) ON DELETE SET NULL ON UPDATE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;
/*!40101 SET character_set_client = @saved_cs_client */;

--
-- Table structure for table `tags_master`
--

DROP TABLE IF EXISTS `tags_master`;
/*!40101 SET @saved_cs_client     = @@character_set_client */;
/*!50503 SET character_set_client = utf8mb4 */;
CREATE TABLE `tags_master` (
  `id` int unsigned NOT NULL AUTO_INCREMENT,
  `tag` varchar(64) NOT NULL,
  `usage_count` int unsigned NOT NULL DEFAULT '0',
  PRIMARY KEY (`id`),
  UNIQUE KEY `uk_tag` (`tag`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;
/*!40101 SET character_set_client = @saved_cs_client */;

--
-- Table structure for table `users`
--

DROP TABLE IF EXISTS `users`;
/*!40101 SET @saved_cs_client     = @@character_set_client */;
/*!50503 SET character_set_client = utf8mb4 */;
CREATE TABLE `users` (
  `id` int unsigned NOT NULL AUTO_INCREMENT COMMENT '用户自增主键',
  `student_no` varchar(32) NOT NULL COMMENT '学号，如 24B928036',
  `name` varchar(50) DEFAULT NULL COMMENT '姓名',
  `department` varchar(100) DEFAULT NULL COMMENT '所属单位/部门',
  `role` enum('visitor','photographer','admin','bc') NOT NULL DEFAULT 'visitor',
  `wechat_openid` varchar(64) DEFAULT NULL COMMENT '微信 openid，将来小程序登录用',
  `created_at` datetime NOT NULL DEFAULT CURRENT_TIMESTAMP COMMENT '创建时间',
  `updated_at` datetime NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP COMMENT '更新时间',
  `email` varchar(255) DEFAULT NULL,
  `avatar_url` varchar(512) DEFAULT NULL,
  `nickname` varchar(100) DEFAULT NULL,
  `password_hash` varchar(255) DEFAULT NULL,
  `organization_id` int unsigned NOT NULL,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uk_users_student_no` (`student_no`),
  KEY `idx_users_org` (`organization_id`)
) ENGINE=InnoDB AUTO_INCREMENT=15 DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci COMMENT='系统用户表';
/*!40101 SET character_set_client = @saved_cs_client */;

--
-- Dumping events for database 'mamage'
--

--
-- Dumping routines for database 'mamage'
--
/*!40103 SET TIME_ZONE=@OLD_TIME_ZONE */;

/*!40101 SET SQL_MODE=@OLD_SQL_MODE */;
/*!40014 SET FOREIGN_KEY_CHECKS=@OLD_FOREIGN_KEY_CHECKS */;
/*!40014 SET UNIQUE_CHECKS=@OLD_UNIQUE_CHECKS */;
/*!40101 SET CHARACTER_SET_CLIENT=@OLD_CHARACTER_SET_CLIENT */;
/*!40101 SET CHARACTER_SET_RESULTS=@OLD_CHARACTER_SET_RESULTS */;
/*!40101 SET COLLATION_CONNECTION=@OLD_COLLATION_CONNECTION */;
/*!40111 SET SQL_NOTES=@OLD_SQL_NOTES */;

-- Dump completed
