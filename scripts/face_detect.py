#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
Face detector runner for MaMage.

Output JSON schema:
{
  "backend": "insightface" | "opencv_haar",
  "modelName": "...",
  "modelVersion": "...",
  "imageWidth": 1234,
  "imageHeight": 900,
  "faces": [
    {
      "faceNo": 1,
      "bbox": {"left": 0.1, "top": 0.2, "width": 0.3, "height": 0.4, "normalized": true, "unit": "ratio"},
      "score": 0.99,
      "embedding": [...],                 # optional
      "normalizedEmbedding": [...],       # optional
      "extra": {...}                      # optional
    }
  ]
}
"""

import json
import os
import sys
import io
import contextlib


def emit_error(code: str, error: str, detail: str = "", install_hint: str = ""):
    payload = {
        "code": code,
        "error": error,
        "detail": detail or None,
        "installHint": install_hint or None,
    }
    sys.stdout.write(json.dumps(payload, ensure_ascii=False))
    sys.stdout.flush()


def clamp01(v: float) -> float:
    if v < 0:
        return 0.0
    if v > 1:
        return 1.0
    return v


def read_image_unicode_compatible(img_path: str):
    # cv2.imread has path encoding issues on Windows for non-ASCII paths.
    # Use np.fromfile + cv2.imdecode to make Chinese paths work reliably.
    import cv2
    import numpy as np

    data = np.fromfile(img_path, dtype=np.uint8)
    if data is None or data.size == 0:
        return None
    return cv2.imdecode(data, cv2.IMREAD_COLOR)


def normalize_box(x, y, w, h, img_w, img_h):
    if img_w <= 0 or img_h <= 0:
        return None
    left = clamp01(float(x) / float(img_w))
    top = clamp01(float(y) / float(img_h))
    width = clamp01(float(w) / float(img_w))
    height = clamp01(float(h) / float(img_h))
    if width <= 0 or height <= 0:
        return None
    return {
        "left": round(left, 6),
        "top": round(top, 6),
        "width": round(width, 6),
        "height": round(height, 6),
        "normalized": True,
        "unit": "ratio",
    }


def detect_with_insightface(img_path: str):
    import cv2  # noqa: F401

    model_name = os.environ.get("FACE_DETECTOR_MODEL_NAME", "buffalo_sc")
    det_size = int(os.environ.get("FACE_DETECTOR_DET_SIZE", "640"))

    img = read_image_unicode_compatible(img_path)
    if img is None:
        raise RuntimeError("cv2 failed to read image")

    h, w = img.shape[:2]
    # Suppress third-party noisy logs/progress so stdout remains clean JSON.
    with contextlib.redirect_stdout(io.StringIO()), contextlib.redirect_stderr(io.StringIO()):
        from insightface.app import FaceAnalysis
        app = FaceAnalysis(name=model_name, providers=["CPUExecutionProvider"])
        app.prepare(ctx_id=0, det_size=(det_size, det_size))
        faces = app.get(img)

    out = []
    for idx, face in enumerate(faces):
        bbox = getattr(face, "bbox", None)
        if bbox is None or len(bbox) < 4:
            continue

        x1, y1, x2, y2 = [float(v) for v in bbox[:4]]
        box = normalize_box(x1, y1, x2 - x1, y2 - y1, w, h)
        if not box:
            continue

        embedding = None
        normed = None
        if hasattr(face, "embedding") and face.embedding is not None:
            emb = face.embedding.tolist() if hasattr(face.embedding, "tolist") else list(face.embedding)
            embedding = [round(float(v), 6) for v in emb]
        if hasattr(face, "normed_embedding") and face.normed_embedding is not None:
            ne = face.normed_embedding.tolist() if hasattr(face.normed_embedding, "tolist") else list(face.normed_embedding)
            normed = [round(float(v), 6) for v in ne]

        out.append(
            {
                "faceNo": idx + 1,
                "bbox": box,
                "score": round(float(getattr(face, "det_score", 0.0) or 0.0), 6),
                "embedding": embedding,
                "normalizedEmbedding": normed,
            }
        )

    return {
        "backend": "insightface",
        "modelName": model_name,
        "modelVersion": None,
        "imageWidth": int(w),
        "imageHeight": int(h),
        "faces": out,
    }


def detect_with_opencv_haar(img_path: str):
    import cv2

    img = read_image_unicode_compatible(img_path)
    if img is None:
        raise RuntimeError("cv2 failed to read image")

    gray = cv2.cvtColor(img, cv2.COLOR_BGR2GRAY)
    h, w = gray.shape[:2]

    cascade_path = os.environ.get("FACE_DETECTOR_HAAR_PATH", "").strip()
    if not cascade_path:
        cascade_path = os.path.join(cv2.data.haarcascades, "haarcascade_frontalface_default.xml")

    if not os.path.exists(cascade_path):
        raise RuntimeError(f"haar cascade not found: {cascade_path}")

    detector = cv2.CascadeClassifier(cascade_path)
    if detector.empty():
        raise RuntimeError(f"failed to load haar cascade: {cascade_path}")

    # Tuned for better recall under CPU constraints.
    boxes = detector.detectMultiScale(
        gray,
        scaleFactor=1.1,
        minNeighbors=5,
        minSize=(24, 24),
    )

    out = []
    for idx, (x, y, bw, bh) in enumerate(boxes):
        box = normalize_box(x, y, bw, bh, w, h)
        if not box:
            continue
        out.append(
            {
                "faceNo": idx + 1,
                "bbox": box,
                "score": None,
            }
        )

    return {
        "backend": "opencv_haar",
        "modelName": "haarcascade_frontalface_default",
        "modelVersion": None,
        "imageWidth": int(w),
        "imageHeight": int(h),
        "faces": out,
    }


def main():
    if len(sys.argv) < 2:
        emit_error(
            "FACE_DETECT_INVALID_INPUT",
            "image path is required",
            "usage: python scripts/face_detect.py <image_path>",
        )
        return 2

    img_path = sys.argv[1]
    if not os.path.exists(img_path):
        emit_error("FACE_DETECT_IMAGE_NOT_FOUND", "image file not found", img_path)
        return 2

    prefer_backend = os.environ.get("FACE_DETECTOR_BACKEND", "auto").strip().lower()
    tried = []

    if prefer_backend in ("auto", "insightface"):
        tried.append("insightface")
        try:
            result = detect_with_insightface(img_path)
            sys.stdout.write(json.dumps(result, ensure_ascii=False))
            sys.stdout.flush()
            return 0
        except Exception as e:
            if prefer_backend == "insightface":
                emit_error(
                    "FACE_DETECT_INSIGHTFACE_FAILED",
                    "insightface detector failed",
                    str(e),
                    "pip install insightface onnxruntime opencv-python-headless",
                )
                return 3

    if prefer_backend in ("auto", "opencv", "opencv_haar"):
        tried.append("opencv_haar")
        try:
            result = detect_with_opencv_haar(img_path)
            sys.stdout.write(json.dumps(result, ensure_ascii=False))
            sys.stdout.flush()
            return 0
        except Exception as e:
            emit_error(
                "FACE_DETECT_OPENCV_FAILED",
                "opencv detector failed",
                str(e),
                "pip install opencv-python-headless",
            )
            return 3

    emit_error(
        "FACE_DETECTOR_BACKEND_INVALID",
        "invalid FACE_DETECTOR_BACKEND",
        f"value={prefer_backend}, tried={','.join(tried)}",
    )
    return 2


if __name__ == "__main__":
    sys.exit(main())
