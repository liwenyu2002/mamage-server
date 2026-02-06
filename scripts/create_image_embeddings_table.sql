-- scripts/create_image_embeddings_table.sql
CREATE TABLE IF NOT EXISTS ai_image_embeddings (
    id INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    photo_id INT UNSIGNED NOT NULL,
    model_name VARCHAR(128) NOT NULL DEFAULT 'mobileclip_s0_image',
    embedding JSON NOT NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    INDEX (photo_id)
);