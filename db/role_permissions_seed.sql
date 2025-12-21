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
-- Dumping data for table `role_permissions`
--
-- ORDER BY:  `id`

LOCK TABLES `role_permissions` WRITE;
/*!40000 ALTER TABLE `role_permissions` DISABLE KEYS */;
INSERT INTO `role_permissions` VALUES (1,'visitor','projects.home','2025-12-07 03:46:53');
INSERT INTO `role_permissions` VALUES (2,'visitor','projects.list','2025-12-07 03:46:53');
INSERT INTO `role_permissions` VALUES (3,'visitor','projects.view','2025-12-07 03:46:53');
INSERT INTO `role_permissions` VALUES (4,'visitor','projects.search','2025-12-07 03:46:53');
INSERT INTO `role_permissions` VALUES (5,'visitor','photos.view','2025-12-07 03:46:53');
INSERT INTO `role_permissions` VALUES (7,'visitor','photos.zip','2025-12-07 03:46:53');
INSERT INTO `role_permissions` VALUES (8,'visitor','users.register','2025-12-07 03:46:53');
INSERT INTO `role_permissions` VALUES (9,'visitor','users.login','2025-12-07 03:46:53');
INSERT INTO `role_permissions` VALUES (10,'visitor','users.me.read','2025-12-07 03:46:53');
INSERT INTO `role_permissions` VALUES (12,'visitor','users.me.invite','2025-12-07 03:46:53');
INSERT INTO `role_permissions` VALUES (13,'photographer','projects.home','2025-12-07 03:46:53');
INSERT INTO `role_permissions` VALUES (14,'photographer','projects.list','2025-12-07 03:46:53');
INSERT INTO `role_permissions` VALUES (15,'photographer','projects.view','2025-12-07 03:46:53');
INSERT INTO `role_permissions` VALUES (16,'photographer','photos.view','2025-12-07 03:46:53');
INSERT INTO `role_permissions` VALUES (18,'photographer','photos.zip','2025-12-07 03:46:53');
INSERT INTO `role_permissions` VALUES (19,'photographer','upload.photo','2025-12-07 03:46:53');
INSERT INTO `role_permissions` VALUES (20,'photographer','users.register','2025-12-07 03:46:53');
INSERT INTO `role_permissions` VALUES (21,'photographer','users.login','2025-12-07 03:46:53');
INSERT INTO `role_permissions` VALUES (22,'photographer','users.me.read','2025-12-07 03:46:53');
INSERT INTO `role_permissions` VALUES (23,'photographer','users.me.update','2025-12-07 03:46:53');
INSERT INTO `role_permissions` VALUES (24,'photographer','users.me.invite','2025-12-07 03:46:53');
INSERT INTO `role_permissions` VALUES (25,'admin','projects.home','2025-12-07 03:46:53');
INSERT INTO `role_permissions` VALUES (26,'admin','projects.list','2025-12-07 03:46:53');
INSERT INTO `role_permissions` VALUES (27,'admin','projects.view','2025-12-07 03:46:53');
INSERT INTO `role_permissions` VALUES (28,'admin','projects.create','2025-12-07 03:46:53');
INSERT INTO `role_permissions` VALUES (29,'admin','projects.update','2025-12-07 03:46:53');
INSERT INTO `role_permissions` VALUES (30,'admin','projects.delete','2025-12-07 03:46:53');
INSERT INTO `role_permissions` VALUES (31,'admin','photos.view','2025-12-07 03:46:53');
INSERT INTO `role_permissions` VALUES (32,'admin','photos.delete','2025-12-07 03:46:53');
INSERT INTO `role_permissions` VALUES (33,'admin','photos.zip','2025-12-07 03:46:53');
INSERT INTO `role_permissions` VALUES (34,'admin','upload.photo','2025-12-07 03:46:53');
INSERT INTO `role_permissions` VALUES (35,'admin','users.register','2025-12-07 03:46:53');
INSERT INTO `role_permissions` VALUES (36,'admin','users.login','2025-12-07 03:46:53');
INSERT INTO `role_permissions` VALUES (37,'admin','users.me.read','2025-12-07 03:46:53');
INSERT INTO `role_permissions` VALUES (38,'admin','users.me.update','2025-12-07 03:46:53');
INSERT INTO `role_permissions` VALUES (39,'admin','users.invitations.create','2025-12-07 03:46:53');
INSERT INTO `role_permissions` VALUES (40,'admin','users.me.invite','2025-12-07 03:46:53');
INSERT INTO `role_permissions` VALUES (41,'admin','photos.edit','2025-12-08 03:41:29');
INSERT INTO `role_permissions` VALUES (42,'admin','ai.generate','2025-12-11 06:50:36');
/*!40000 ALTER TABLE `role_permissions` ENABLE KEYS */;
UNLOCK TABLES;
/*!40103 SET TIME_ZONE=@OLD_TIME_ZONE */;

/*!40101 SET SQL_MODE=@OLD_SQL_MODE */;
/*!40014 SET FOREIGN_KEY_CHECKS=@OLD_FOREIGN_KEY_CHECKS */;
/*!40014 SET UNIQUE_CHECKS=@OLD_UNIQUE_CHECKS */;
/*!40101 SET CHARACTER_SET_CLIENT=@OLD_CHARACTER_SET_CLIENT */;
/*!40101 SET CHARACTER_SET_RESULTS=@OLD_CHARACTER_SET_RESULTS */;
/*!40101 SET COLLATION_CONNECTION=@OLD_COLLATION_CONNECTION */;
/*!40111 SET SQL_NOTES=@OLD_SQL_NOTES */;

-- Dump completed
