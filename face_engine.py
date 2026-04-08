"""
face_engine.py — Core face detection, encoding, and comparison engine.

Uses OpenCV's built-in high-level APIs:
  - cv2.FaceDetectorYN (YuNet model) for face detection
  - cv2.FaceRecognizerSF (SFace model) for 128-d face embedding
  - Cosine similarity for matching

No TensorFlow, dlib, or heavy ML framework needed.
Works on Python 3.14+ with just opencv-python.
"""

import cv2
import numpy as np
import base64
import os
from io import BytesIO
from PIL import Image

# ─── Model paths ────────────────────────────────────────────────
MODELS_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), "models")
DETECTION_MODEL = os.path.join(MODELS_DIR, "face_detection_yunet_2023mar.onnx")
RECOGNITION_MODEL = os.path.join(MODELS_DIR, "face_recognition_sface_2021dec.onnx")

# Cosine similarity threshold for matching (higher = stricter)
# SFace cosine similarity: >0.363 = same person (recommended by OpenCV Zoo)
COSINE_THRESHOLD = 0.363

# Module-level detector and recognizer (initialized lazily)
_detector = None
_recognizer = None

# In-memory cache of known face embeddings
_known_embeddings = []   # list of numpy arrays (128-d each)
_known_names = []        # corresponding names
_known_ids = []          # corresponding DB IDs


def _get_detector(width=640, height=480):
    """Get or create the YuNet face detector."""
    global _detector
    if _detector is None:
        if not os.path.exists(DETECTION_MODEL):
            raise FileNotFoundError(
                f"Face detection model not found at {DETECTION_MODEL}.\n"
                f"Run: python download_models.py"
            )
        _detector = cv2.FaceDetectorYN.create(
            model=DETECTION_MODEL,
            config="",
            input_size=(width, height),
            score_threshold=0.6,
            nms_threshold=0.3,
            top_k=10,
        )
    _detector.setInputSize((width, height))
    return _detector


def _get_recognizer():
    """Get or create the SFace face recognizer."""
    global _recognizer
    if _recognizer is None:
        if not os.path.exists(RECOGNITION_MODEL):
            raise FileNotFoundError(
                f"Face recognition model not found at {RECOGNITION_MODEL}.\n"
                f"Run: python download_models.py"
            )
        _recognizer = cv2.FaceRecognizerSF.create(
            model=RECOGNITION_MODEL,
            config="",
        )
    return _recognizer


# ─── Known Faces Cache ──────────────────────────────────────────

def load_known_faces(db_faces: list):
    """
    Load registered face embeddings into memory for fast comparison.
    Called on startup and after each new registration.
    """
    global _known_embeddings, _known_names, _known_ids
    _known_embeddings = [f["encoding"] for f in db_faces]
    _known_names = [f["name"] for f in db_faces]
    _known_ids = [f["id"] for f in db_faces]


def get_known_count() -> int:
    """Return the number of known face embeddings loaded in memory."""
    return len(_known_embeddings)


# ─── Image Conversion ──────────────────────────────────────────

def base64_to_image(base64_str: str) -> np.ndarray:
    """Convert a base64-encoded image string to a BGR numpy array (for OpenCV)."""
    if "," in base64_str:
        base64_str = base64_str.split(",", 1)[1]

    image_bytes = base64.b64decode(base64_str)
    pil_image = Image.open(BytesIO(image_bytes)).convert("RGB")
    rgb = np.array(pil_image)
    bgr = cv2.cvtColor(rgb, cv2.COLOR_RGB2BGR)
    return bgr


# ─── Detection & Embedding ──────────────────────────────────────

def detect_faces(image: np.ndarray):
    """
    Detect all faces in a BGR image using YuNet.

    Returns:
        numpy array of shape (N, 15) where each row contains:
        [x, y, w, h, x_re, y_re, x_le, y_le, x_nt, y_nt, x_rcm, y_rcm, x_lcm, y_lcm, score]
        or None if no faces detected.
    """
    h, w = image.shape[:2]
    detector = _get_detector(w, h)
    _, faces = detector.detect(image)
    return faces


def get_face_embedding(image: np.ndarray, face: np.ndarray) -> np.ndarray:
    """
    Extract a 128-d face embedding using SFace.

    Args:
        image: BGR numpy array
        face: single face detection row from YuNet (14+ values)

    Returns:
        128-dimensional normalized embedding vector
    """
    recognizer = _get_recognizer()
    aligned = recognizer.alignCrop(image, face)
    embedding = recognizer.feature(aligned)
    return embedding.flatten()


def cosine_similarity(a: np.ndarray, b: np.ndarray) -> float:
    """Compute cosine similarity between two vectors."""
    dot = np.dot(a, b)
    norm_a = np.linalg.norm(a)
    norm_b = np.linalg.norm(b)
    if norm_a == 0 or norm_b == 0:
        return 0.0
    return float(dot / (norm_a * norm_b))


# ─── Recognition Pipeline ──────────────────────────────────────

def recognize_faces(image: np.ndarray):
    """
    Full recognition pipeline: detect faces, encode, compare against known faces.

    Returns:
        list of dicts, one per detected face:
        {
            "location": (top, right, bottom, left),  # for canvas drawing
            "name": str or "Unknown",
            "person_id": int or None,
            "confidence": float (0.0–1.0, higher=better),
            "status": "recognized" | "unknown"
        }
    """
    faces = detect_faces(image)

    if faces is None or len(faces) == 0:
        return []

    results = []

    for face in faces:
        # Extract bounding box: YuNet gives [x, y, w, h, ...]
        x, y, w, h = int(face[0]), int(face[1]), int(face[2]), int(face[3])
        detection_score = float(face[14]) if len(face) > 14 else 0.0

        # Convert to (top, right, bottom, left) for frontend canvas
        top = y
        right = x + w
        bottom = y + h
        left = x

        if len(_known_embeddings) == 0:
            results.append({
                "location": (top, right, bottom, left),
                "name": "Unknown",
                "person_id": None,
                "confidence": 0.0,
                "status": "unknown",
            })
            continue

        # Get embedding for this face
        try:
            embedding = get_face_embedding(image, face)
        except Exception:
            results.append({
                "location": (top, right, bottom, left),
                "name": "Unknown",
                "person_id": None,
                "confidence": 0.0,
                "status": "unknown",
            })
            continue

        # Compare against all known faces using cosine similarity
        best_score = -1.0
        best_idx = -1

        for i, known_emb in enumerate(_known_embeddings):
            score = cosine_similarity(embedding, known_emb)
            if score > best_score:
                best_score = score
                best_idx = i

        # Normalize confidence to 0–1 range
        # SFace cosine similarity ranges roughly from -1 to 1
        # Map threshold region (0.2 to 0.6) to a more readable 0–1 scale
        confidence = max(0.0, min(1.0, (best_score + 1) / 2))
        confidence = round(confidence, 4)

        if best_score >= COSINE_THRESHOLD:
            results.append({
                "location": (top, right, bottom, left),
                "name": _known_names[best_idx],
                "person_id": _known_ids[best_idx],
                "confidence": confidence,
                "status": "recognized",
            })
        else:
            results.append({
                "location": (top, right, bottom, left),
                "name": "Unknown",
                "person_id": None,
                "confidence": confidence,
                "status": "unknown",
            })

    return results


# ─── Registration Helpers ──────────────────────────────────────

def encode_single_face(image: np.ndarray):
    """
    Detect and encode a single face for registration.

    Returns:
        (embedding, location, status_message)
        embedding: 128-d numpy array or None
        location: (top, right, bottom, left) or None
        status_message: "ok", "no_face", or "multiple_faces"
    """
    faces = detect_faces(image)

    if faces is None or len(faces) == 0:
        return None, None, "no_face"

    # If multiple faces, pick the largest one
    if len(faces) > 1:
        best = None
        best_area = 0
        for face in faces:
            area = int(face[2]) * int(face[3])  # w * h
            if area > best_area:
                best_area = area
                best = face
        face = best
        status = "multiple_faces"
    else:
        face = faces[0]
        status = "ok"

    try:
        embedding = get_face_embedding(image, face)
    except Exception as e:
        return None, None, f"encoding_error: {str(e)}"

    x, y, w, h = int(face[0]), int(face[1]), int(face[2]), int(face[3])
    location = (y, x + w, y + h, x)  # (top, right, bottom, left)

    return embedding, location, status


def save_face_image(image: np.ndarray, name: str, index: int) -> str:
    """
    Save a face image to the known_faces directory.
    Image should be BGR (OpenCV format).
    Returns the relative file path.
    """
    faces_dir = os.path.join(os.path.dirname(os.path.abspath(__file__)), "known_faces", name)
    os.makedirs(faces_dir, exist_ok=True)

    filename = f"{name}_{index}.jpg"
    filepath = os.path.join(faces_dir, filename)

    cv2.imwrite(filepath, image)

    return os.path.join("known_faces", name, filename)
