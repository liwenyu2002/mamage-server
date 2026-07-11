-- OCR 文字检索：视觉模型提取的画面文字（横幅/海报/证书/记分牌等），入语义搜索
ALTER TABLE photos ADD COLUMN ocr_text TEXT NULL AFTER description;
