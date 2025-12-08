-- MySQL dump 10.13  Distrib 9.5.0, for macos26.0 (arm64)
--
-- Host: localhost    Database: MaMage
-- ------------------------------------------------------
-- Server version	9.5.0

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
SET @MYSQLDUMP_TEMP_LOG_BIN = @@SESSION.SQL_LOG_BIN;
SET @@SESSION.SQL_LOG_BIN= 0;

--
-- GTID state at the beginning of the backup 
--

SET @@GLOBAL.GTID_PURGED=/*!80000 '+'*/ 'c43ae98e-beaa-11f0-ad6e-24cc937aacee:1-213';

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
  `local_path` varchar(255) DEFAULT NULL COMMENT '服务器本地文件路径',
  `title` varchar(200) DEFAULT NULL COMMENT '标题',
  `tags` json DEFAULT NULL COMMENT '标签 JSON，比如 ["毕业","合影"]',
  `type` varchar(50) NOT NULL DEFAULT 'normal' COMMENT '类型，如 normal/cover 等',
  `created_at` datetime NOT NULL DEFAULT CURRENT_TIMESTAMP COMMENT '创建时间',
  `updated_at` datetime NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP COMMENT '更新时间',
  `capture_time` date DEFAULT NULL,
  `photographer_id` int unsigned DEFAULT NULL COMMENT '上传该照片的摄影师用户id，关联 users.id',
  PRIMARY KEY (`id`),
  UNIQUE KEY `uk_photos_uuid` (`uuid`),
  KEY `idx_photos_project_id` (`project_id`),
  KEY `idx_photos_created_at` (`created_at`),
  CONSTRAINT `fk_photos_project` FOREIGN KEY (`project_id`) REFERENCES `projects` (`id`) ON DELETE SET NULL ON UPDATE CASCADE
) ENGINE=InnoDB AUTO_INCREMENT=44 DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;
/*!40101 SET character_set_client = @saved_cs_client */;

--
-- Dumping data for table `photos`
--

LOCK TABLES `photos` WRITE;
/*!40000 ALTER TABLE `photos` DISABLE KEYS */;
INSERT INTO `photos` VALUES (4,'23beed08-c2c3-11f0-84b5-9cfc1e9cb6bd',3,'/uploads/2025/11/16/wolong1.jpg','/uploads/2025/11/16/wolong1.jpg','/Users/liwenyu/imgmgr-api/uploads/2025/11/16/wolong1.jpg','卧龙村社会实践 1','[\"卧龙村\", \"社会实践\"]','normal','2025-11-16 16:06:22','2025-11-16 16:06:22',NULL,NULL),(5,'23bef8ca-c2c3-11f0-84b5-9cfc1e9cb6bd',3,'/uploads/2025/11/16/wolong2.jpg','/uploads/2025/11/16/wolong2.jpg','/Users/liwenyu/imgmgr-api/uploads/2025/11/16/wolong2.jpg','卧龙村社会实践 2','[\"卧龙村\", \"社会实践\"]','normal','2025-11-16 16:06:22','2025-11-16 16:06:22',NULL,NULL),(6,'23befba4-c2c3-11f0-84b5-9cfc1e9cb6bd',3,'/uploads/2025/11/16/wolong3.jpg','/uploads/2025/11/16/wolong3.jpg','/Users/liwenyu/imgmgr-api/uploads/2025/11/16/wolong3.jpg','卧龙村社会实践 3','[\"卧龙村\", \"社会实践\"]','normal','2025-11-16 16:06:22','2025-11-16 16:06:22',NULL,NULL),(7,'23befd48-c2c3-11f0-84b5-9cfc1e9cb6bd',3,'/uploads/2025/11/16/wolong4.jpg','/uploads/2025/11/16/wolong4.jpg','/Users/liwenyu/imgmgr-api/uploads/2025/11/16/wolong4.jpg','卧龙村社会实践 4','[\"卧龙村\", \"社会实践\"]','normal','2025-11-16 16:06:22','2025-11-16 16:06:22',NULL,NULL),(8,'f4406998-c2c3-11f0-84b5-9cfc1e9cb6bd',4,'/uploads/2025/11/16/xinli1.jpg','/uploads/2025/11/16/xinli1.jpg','/Users/liwenyu/imgmgr-api/uploads/2025/11/16/xinli1.jpg','心理健康文化节知识问答 1','[\"心理健康文化节\", \"知识问答\"]','normal','2025-11-16 16:12:12','2025-11-16 16:12:12',NULL,NULL),(9,'f4407334-c2c3-11f0-84b5-9cfc1e9cb6bd',4,'/uploads/2025/11/16/xinli2.jpg','/uploads/2025/11/16/xinli2.jpg','/Users/liwenyu/imgmgr-api/uploads/2025/11/16/xinli2.jpg','心理健康文化节知识问答 2','[\"心理健康文化节\", \"知识问答\"]','normal','2025-11-16 16:12:12','2025-11-16 16:12:12',NULL,NULL),(36,'e05b09fc-c42a-11f0-9bf7-cc533e3b6d74',5,'/uploads/2025/11/18/3cefa1a9-5cb8-4dfa-bf58-1ab818325ff3.png','/uploads/2025/11/18/thumbs/thumb_3cefa1a9-5cb8-4dfa-bf58-1ab818325ff3.png','/Users/liwenyu/imgmgr-api/uploads/2025/11/18/3cefa1a9-5cb8-4dfa-bf58-1ab818325ff3.png','',NULL,'normal','2025-11-18 11:01:28','2025-11-18 11:01:28',NULL,NULL),(39,'a16ce14a-c42d-11f0-9bf7-cc533e3b6d74',1,'/uploads/scenery/14b935b4-fe7f-4044-a461-8a625abe3e15.jpg','/uploads/scenery/thumbs/thumb_14b935b4-fe7f-4044-a461-8a625abe3e15.jpg','/Users/liwenyu/imgmgr-api/uploads/scenery/14b935b4-fe7f-4044-a461-8a625abe3e15.jpg','',NULL,'normal','2025-11-18 11:21:10','2025-11-18 11:21:10',NULL,NULL),(40,'f27fe412-c471-11f0-9bf7-cc533e3b6d74',1,'/uploads/scenery/a7c18fab-e053-42f5-9ac5-5cfff90cbad1.jpg','/uploads/scenery/thumbs/thumb_a7c18fab-e053-42f5-9ac5-5cfff90cbad1.jpg','/Users/liwenyu/imgmgr-api/uploads/scenery/a7c18fab-e053-42f5-9ac5-5cfff90cbad1.jpg','',NULL,'normal','2025-11-18 19:30:12','2025-11-18 19:30:12',NULL,NULL),(41,'fce8a3c6-c471-11f0-9bf7-cc533e3b6d74',1,'/uploads/scenery/2b161c86-764e-4e06-8dc9-6ec48b1e311d.jpg','/uploads/scenery/thumbs/thumb_2b161c86-764e-4e06-8dc9-6ec48b1e311d.jpg','/Users/liwenyu/imgmgr-api/uploads/scenery/2b161c86-764e-4e06-8dc9-6ec48b1e311d.jpg','',NULL,'normal','2025-11-18 19:30:30','2025-11-18 19:30:30',NULL,NULL),(42,'0399a1de-c472-11f0-9bf7-cc533e3b6d74',1,'/uploads/scenery/adb2d3c2-5d3d-4a00-8f7c-9a3a168b0408.jpg','/uploads/scenery/thumbs/thumb_adb2d3c2-5d3d-4a00-8f7c-9a3a168b0408.jpg','/Users/liwenyu/imgmgr-api/uploads/scenery/adb2d3c2-5d3d-4a00-8f7c-9a3a168b0408.jpg','',NULL,'normal','2025-11-18 19:30:41','2025-11-18 19:30:41',NULL,NULL),(43,'1249eee6-c472-11f0-9bf7-cc533e3b6d74',1,'/uploads/scenery/0ffadc87-bbb6-43a2-96bc-7f94590e9581.jpg','/uploads/scenery/thumbs/thumb_0ffadc87-bbb6-43a2-96bc-7f94590e9581.jpg','/Users/liwenyu/imgmgr-api/uploads/scenery/0ffadc87-bbb6-43a2-96bc-7f94590e9581.jpg','',NULL,'normal','2025-11-18 19:31:06','2025-11-18 19:31:06',NULL,NULL);
/*!40000 ALTER TABLE `photos` ENABLE KEYS */;
UNLOCK TABLES;

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
  `created_at` datetime NOT NULL DEFAULT CURRENT_TIMESTAMP COMMENT '创建时间',
  `updated_at` datetime NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP COMMENT '更新时间',
  `admin_id` int unsigned DEFAULT NULL COMMENT '管理员用户id，关联 users.id',
  PRIMARY KEY (`id`),
  UNIQUE KEY `uk_projects_uuid` (`uuid`)
) ENGINE=InnoDB AUTO_INCREMENT=8 DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;
/*!40101 SET character_set_client = @saved_cs_client */;

--
-- Dumping data for table `projects`
--

LOCK TABLES `projects` WRITE;
/*!40000 ALTER TABLE `projects` DISABLE KEYS */;
INSERT INTO `projects` VALUES (1,'c6c7f2a8-c2bc-11f0-84b5-9cfc1e9cb6bd','校园风光','校园风景专栏','1970-06-07','{\"category\": \"news\"}',NULL,'2025-11-16 15:20:49','2025-11-17 20:00:31',NULL),(3,'c63217ba-c2c1-11f0-84b5-9cfc1e9cb6bd','卧龙村社会实践','卧龙村暑期社会实践活动照片集',NULL,'{\"year\": 2025, \"category\": \"社会实践\", \"location\": \"卧龙村\"}',NULL,'2025-11-16 15:56:35','2025-11-16 15:56:35',NULL),(4,'b70a77bc-c2c3-11f0-84b5-9cfc1e9cb6bd','心理健康文化节知识问答','大学生心理健康文化节之“医片阳光，心生欢喜”中医知识问答活动','2024-05-25','{\"year\": 2024, \"category\": \"文体活动\", \"location\": \"学校\"}',NULL,'2025-11-16 16:10:29','2025-11-17 16:06:04',NULL),(5,'c76c4eaa-c363-11f0-9bf7-cc533e3b6d74','软件工程课堂','测试项目','2025-11-18','{\"deadline\": null, \"deadlineDate\": null, \"deadlineTime\": null}',NULL,'2025-11-17 11:16:16','2025-11-17 16:52:09',NULL);
/*!40000 ALTER TABLE `projects` ENABLE KEYS */;
UNLOCK TABLES;

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
-- Dumping data for table `tags_master`
--

LOCK TABLES `tags_master` WRITE;
/*!40000 ALTER TABLE `tags_master` DISABLE KEYS */;
/*!40000 ALTER TABLE `tags_master` ENABLE KEYS */;
UNLOCK TABLES;

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
  `role` enum('admin','photographer','bc') NOT NULL DEFAULT 'photographer' COMMENT '权限角色',
  `wechat_openid` varchar(64) DEFAULT NULL COMMENT '微信 openid，将来小程序登录用',
  `created_at` datetime NOT NULL DEFAULT CURRENT_TIMESTAMP COMMENT '创建时间',
  `updated_at` datetime NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP COMMENT '更新时间',
  PRIMARY KEY (`id`),
  UNIQUE KEY `uk_users_student_no` (`student_no`)
) ENGINE=InnoDB AUTO_INCREMENT=3 DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci COMMENT='系统用户表';
/*!40101 SET character_set_client = @saved_cs_client */;

--
-- Dumping data for table `users`
--

LOCK TABLES `users` WRITE;
/*!40000 ALTER TABLE `users` DISABLE KEYS */;
INSERT INTO `users` VALUES (1,'24B928036','李文宇','生命科学和医学学部','admin',NULL,'2025-11-17 20:53:43','2025-11-17 20:53:43'),(2,'P0000001','测试摄影师','生命科学和医学学部','photographer',NULL,'2025-11-17 20:54:22','2025-11-17 20:54:22');
/*!40000 ALTER TABLE `users` ENABLE KEYS */;
UNLOCK TABLES;
SET @@SESSION.SQL_LOG_BIN = @MYSQLDUMP_TEMP_LOG_BIN;
/*!40103 SET TIME_ZONE=@OLD_TIME_ZONE */;

/*!40101 SET SQL_MODE=@OLD_SQL_MODE */;
/*!40014 SET FOREIGN_KEY_CHECKS=@OLD_FOREIGN_KEY_CHECKS */;
/*!40014 SET UNIQUE_CHECKS=@OLD_UNIQUE_CHECKS */;
/*!40101 SET CHARACTER_SET_CLIENT=@OLD_CHARACTER_SET_CLIENT */;
/*!40101 SET CHARACTER_SET_RESULTS=@OLD_CHARACTER_SET_RESULTS */;
/*!40101 SET COLLATION_CONNECTION=@OLD_COLLATION_CONNECTION */;
/*!40111 SET SQL_NOTES=@OLD_SQL_NOTES */;

-- Dump completed on 2025-11-18 23:31:26
