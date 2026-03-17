#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
Face detect + embedding + in-memory ANN service for MaMage.

Run:
  uvicorn scripts.face_embed_service:app --host 0.0.0.0 --port 8009
"""

import os
import threading
from typing import Dict, List, Optional

import cv2
import hnswlib
import numpy as np
import requests
from fastapi import FastAPI, HTTPException
from pydantic import BaseModel, Field


def _env_int(name: str, default: int) -> int:
    raw = os.environ.get(name, "").strip()
    if not raw:
        return default
    try:
        n = int(raw)
    except Exception:
        return default
    return n if n > 0 else default


def _clamp01(x: float) -> float:
    return 0.0 if x < 0 else (1.0 if x > 1 else x)


def _normalize(v: np.ndarray) -> np.ndarray:
    if v is None:
        return v
    n = float(np.linalg.norm(v))
    if n <= 0:
        return v
    return v / n


class DetectRequest(BaseModel):
    imageUrl: Optional[str] = None
    imagePath: Optional[str] = None
    backend: str = "auto"
    modelName: Optional[str] = None


class SearchRequest(BaseModel):
    vector: List[float]
    k: int = Field(default=5, ge=1, le=50)


class AddVectorItem(BaseModel):
    vectorId: int
    personId: Optional[int] = None
    vector: List[float]


class AddVectorsRequest(BaseModel):
    items: List[AddVectorItem]


class ResetIndexRequest(BaseModel):
    dim: int = Field(default=512, ge=64, le=2048)
    maxElements: int = Field(default=1_000_000, ge=1000, le=20_000_000)
    efConstruction: int = Field(default=200, ge=16, le=2000)
    M: int = Field(default=16, ge=4, le=128)


class FaceRuntime:
    def __init__(self):
        self._face_lock = threading.Lock()
        self._face_app = None
        self._face_model_name = None

        self._idx_lock = threading.Lock()
        self._index = None
        self._index_dim = 512
        self._index_max = 1_000_000
        self._index_count = 0
        self._vector_id_to_person: Dict[int, Optional[int]] = {}

    def _load_face_app(self, model_name: str):
        from insightface.app import FaceAnalysis

        if self._face_app is not None and self._face_model_name == model_name:
            return self._face_app

        with self._face_lock:
            if self._face_app is not None and self._face_model_name == model_name:
                return self._face_app
            providers = ["CPUExecutionProvider"]
            if os.environ.get("FACE_SERVICE_USE_GPU", "").strip() in ("1", "true", "yes"):
                providers = ["CUDAExecutionProvider", "CPUExecutionProvider"]
            app = FaceAnalysis(name=model_name, providers=providers)
            det_size = _env_int("FACE_DETECTOR_DET_SIZE", 640)
            app.prepare(ctx_id=0, det_size=(det_size, det_size))
            self._face_app = app
            self._face_model_name = model_name
            return app

    def _read_image(self, req: DetectRequest):
        if req.imagePath:
            p = req.imagePath
            if not os.path.exists(p):
                raise HTTPException(status_code=404, detail=f"imagePath not found: {p}")
            data = np.fromfile(p, dtype=np.uint8)
            img = cv2.imdecode(data, cv2.IMREAD_COLOR)
            if img is None:
                raise HTTPException(status_code=400, detail="failed to decode imagePath")
            return img, p, "path"

        if req.imageUrl:
            timeout_sec = max(3, _env_int("FACE_SERVICE_FETCH_TIMEOUT_MS", 20_000) // 1000)
            r = requests.get(req.imageUrl, timeout=timeout_sec)
            if r.status_code < 200 or r.status_code >= 300:
                raise HTTPException(status_code=400, detail=f"fetch imageUrl failed: {r.status_code}")
            arr = np.frombuffer(r.content, dtype=np.uint8)
            img = cv2.imdecode(arr, cv2.IMREAD_COLOR)
            if img is None:
                raise HTTPException(status_code=400, detail="failed to decode imageUrl content")
            return img, req.imageUrl, "url"

        raise HTTPException(status_code=400, detail="imageUrl or imagePath is required")

    def detect(self, req: DetectRequest):
        model_name = (req.modelName or os.environ.get("FACE_DETECTOR_MODEL_NAME") or "buffalo_l").strip()
        img, source, source_type = self._read_image(req)
        h, w = img.shape[:2]

        backend = (req.backend or "auto").strip().lower()
        faces = []
        used_backend = None

        if backend in ("auto", "insightface"):
            try:
                app = self._load_face_app(model_name)
                raw_faces = app.get(img)
                for idx, face in enumerate(raw_faces):
                    bbox = getattr(face, "bbox", None)
                    if bbox is None or len(bbox) < 4:
                        continue
                    x1, y1, x2, y2 = [float(v) for v in bbox[:4]]
                    bw = max(0.0, x2 - x1)
                    bh = max(0.0, y2 - y1)
                    if bw <= 0 or bh <= 0:
                        continue

                    emb = getattr(face, "embedding", None)
                    nemb = getattr(face, "normed_embedding", None)
                    emb_arr = np.array(emb, dtype=np.float32) if emb is not None else None
                    nemb_arr = np.array(nemb, dtype=np.float32) if nemb is not None else None
                    if nemb_arr is None and emb_arr is not None:
                        nemb_arr = _normalize(emb_arr.copy())

                    faces.append(
                        {
                            "faceNo": idx + 1,
                            "bbox": {
                                "left": round(_clamp01(x1 / float(w)), 6),
                                "top": round(_clamp01(y1 / float(h)), 6),
                                "width": round(_clamp01(bw / float(w)), 6),
                                "height": round(_clamp01(bh / float(h)), 6),
                                "normalized": True,
                                "unit": "ratio",
                            },
                            "score": round(float(getattr(face, "det_score", 0.0) or 0.0), 6),
                            "embedding": emb_arr.tolist() if emb_arr is not None else None,
                            "normalizedEmbedding": nemb_arr.tolist() if nemb_arr is not None else None,
                        }
                    )
                used_backend = "insightface"
            except Exception:
                if backend == "insightface":
                    raise

        if used_backend is None:
            gray = cv2.cvtColor(img, cv2.COLOR_BGR2GRAY)
            cascade_path = os.path.join(cv2.data.haarcascades, "haarcascade_frontalface_default.xml")
            detector = cv2.CascadeClassifier(cascade_path)
            boxes = detector.detectMultiScale(gray, scaleFactor=1.1, minNeighbors=5, minSize=(24, 24))
            for idx, (x, y, bw, bh) in enumerate(boxes):
                faces.append(
                    {
                        "faceNo": idx + 1,
                        "bbox": {
                            "left": round(_clamp01(float(x) / float(w)), 6),
                            "top": round(_clamp01(float(y) / float(h)), 6),
                            "width": round(_clamp01(float(bw) / float(w)), 6),
                            "height": round(_clamp01(float(bh) / float(h)), 6),
                            "normalized": True,
                            "unit": "ratio",
                        },
                        "score": None,
                        "embedding": None,
                        "normalizedEmbedding": None,
                    }
                )
            used_backend = "opencv_haar"

        return {
            "backend": used_backend,
            "modelName": model_name,
            "modelVersion": None,
            "imageWidth": int(w),
            "imageHeight": int(h),
            "faces": faces,
            "source": source,
            "sourceType": source_type,
        }

    def reset_index(self, req: ResetIndexRequest):
        with self._idx_lock:
            idx = hnswlib.Index(space="ip", dim=req.dim)
            idx.init_index(max_elements=req.maxElements, ef_construction=req.efConstruction, M=req.M)
            idx.set_ef(max(50, req.efConstruction))
            self._index = idx
            self._index_dim = req.dim
            self._index_max = req.maxElements
            self._index_count = 0
            self._vector_id_to_person = {}
        return {"ok": True, "dim": req.dim, "maxElements": req.maxElements}

    def add_vectors(self, req: AddVectorsRequest):
        with self._idx_lock:
            if self._index is None:
                self.reset_index(ResetIndexRequest())
            ids = []
            vecs = []
            for item in req.items:
                arr = np.array(item.vector, dtype=np.float32)
                if arr.ndim != 1 or arr.shape[0] != self._index_dim:
                    continue
                arr = _normalize(arr)
                ids.append(int(item.vectorId))
                vecs.append(arr)
                self._vector_id_to_person[int(item.vectorId)] = (int(item.personId) if item.personId is not None else None)
            if ids:
                self._index.add_items(np.vstack(vecs), np.array(ids, dtype=np.int64))
                self._index_count += len(ids)
        return {"ok": True, "added": len(req.items), "indexCount": self._index_count}

    def search(self, req: SearchRequest):
        with self._idx_lock:
            if self._index is None or self._index_count <= 0:
                return {"items": []}
            vec = np.array(req.vector, dtype=np.float32)
            if vec.ndim != 1 or vec.shape[0] != self._index_dim:
                raise HTTPException(status_code=400, detail=f"vector dim mismatch, expect {self._index_dim}")
            vec = _normalize(vec)
            labels, distances = self._index.knn_query(vec, k=min(req.k, self._index_count))
            items = []
            for i in range(len(labels[0])):
                vid = int(labels[0][i])
                score = float(distances[0][i])
                items.append({
                    "vectorId": vid,
                    "personId": self._vector_id_to_person.get(vid),
                    "score": score,
                })
            return {"items": items}


runtime = FaceRuntime()
app = FastAPI(title="MaMage Face Service", version="0.1.0")


@app.get("/health")
def health():
    return {"ok": True}


@app.post("/detect")
def detect(req: DetectRequest):
    try:
        return runtime.detect(req)
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@app.post("/index/reset")
def index_reset(req: ResetIndexRequest):
    return runtime.reset_index(req)


@app.post("/index/add")
def index_add(req: AddVectorsRequest):
    return runtime.add_vectors(req)


@app.post("/index/search")
def index_search(req: SearchRequest):
    return runtime.search(req)
