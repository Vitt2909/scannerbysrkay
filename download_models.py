"""
download_models.py — Download YuNet (face detection) and SFace (face recognition) ONNX models.

These are lightweight models from the OpenCV Zoo that work with
cv2.FaceDetectorYN and cv2.FaceRecognizerSF, no TensorFlow/dlib needed.
"""

import os
import urllib.request
import sys

MODELS_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), "models")

MODELS = {
    "face_detection_yunet_2023mar.onnx": {
        "url": "https://github.com/opencv/opencv_zoo/raw/main/models/face_detection_yunet/face_detection_yunet_2023mar.onnx",
        "description": "YuNet face detection model (~227KB)",
    },
    "face_recognition_sface_2021dec.onnx": {
        "url": "https://github.com/opencv/opencv_zoo/raw/main/models/face_recognition_sface/face_recognition_sface_2021dec.onnx",
        "description": "SFace face recognition/embedding model (~36MB)",
    },
}


def download_file(url: str, dest: str, description: str):
    """Download a file with progress indicator."""
    if os.path.exists(dest):
        print(f"  [OK] Already exists: {os.path.basename(dest)}")
        return True

    print(f"  [DL] Downloading {description}...")
    print(f"    URL: {url}")

    try:
        def progress_hook(block_num, block_size, total_size):
            downloaded = block_num * block_size
            if total_size > 0:
                percent = min(100, downloaded * 100 // total_size)
                bar = "#" * (percent // 2) + "." * (50 - percent // 2)
                print(f"\r    [{bar}] {percent}%", end="", flush=True)

        urllib.request.urlretrieve(url, dest, reporthook=progress_hook)
        print(f"\n  [OK] Saved: {os.path.basename(dest)}")
        return True
    except Exception as e:
        print(f"\n  [FAIL] Error: {e}")
        if os.path.exists(dest):
            os.remove(dest)
        return False


def main():
    print("=" * 50)
    print("  FaceLog — Model Downloader")
    print("=" * 50)
    print()

    os.makedirs(MODELS_DIR, exist_ok=True)

    all_ok = True
    for filename, info in MODELS.items():
        dest = os.path.join(MODELS_DIR, filename)
        ok = download_file(info["url"], dest, info["description"])
        if not ok:
            all_ok = False
        print()

    if all_ok:
        print("[OK] All models downloaded successfully!")
        print(f"  Location: {MODELS_DIR}")
    else:
        print("[FAIL] Some models failed to download. Check your internet connection.")
        sys.exit(1)


if __name__ == "__main__":
    main()
