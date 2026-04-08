# FaceLog — Facial Recognition Attendance System

A fully local, real-time facial recognition attendance system. Captures faces via webcam, identifies individuals against a registered database, and logs attendance with timestamps and confidence scores. Unknown faces are flagged, not ignored.

![Python](https://img.shields.io/badge/Python-3.10+-3776AB?style=flat&logo=python&logoColor=white)
![Flask](https://img.shields.io/badge/Flask-3.0+-000000?style=flat&logo=flask&logoColor=white)
![OpenCV](https://img.shields.io/badge/OpenCV-4.8+-5C3EE8?style=flat&logo=opencv&logoColor=white)
![SQLite](https://img.shields.io/badge/SQLite-Database-003B57?style=flat&logo=sqlite&logoColor=white)

---

## Features

- **Real-time face recognition** via webcam with bounding boxes and confidence labels
- **Live registration** — add new people without restarting the server
- **Attendance logging** — automatically logs name, time, and confidence score
- **Unknown face flagging** — unrecognized faces are highlighted and recorded
- **Persistent storage** — SQLite database survives restarts
- **Cooldown system** — prevents duplicate entries (30-min window)
- **Multi-face support** — detects and identifies all faces in frame simultaneously
- **Beautiful dark UI** — premium glassmorphism design
- **Zero compilation** — no C++ build tools needed; pure pip install

---

## Setup Instructions (Windows)

### Prerequisites

- **Python 3.10+** (tested on Python 3.14)
  - Download from [python.org](https://www.python.org/downloads/)
  - Check "Add Python to PATH" during installation

That's it! No Visual Studio Build Tools or CMake required.

### Installation

```powershell
# 1. Navigate to the project directory
cd c:\Users\userr\scannerbysrkay

# 2. Create a virtual environment
python -m venv venv
.\venv\Scripts\Activate.ps1

# 3. Install dependencies
pip install -r requirements.txt

# 4. Download face detection & recognition models (~37MB total)
python download_models.py
```

### Start the Server

```powershell
# Activate the virtual environment
.\venv\Scripts\Activate.ps1

# Run the server
python app.py
```

Then open **http://127.0.0.1:5000** in your browser (Chrome or Edge recommended).

---

## How to Use

### 1. Register a New Face

1. Click the **"Register Face"** tab (+ icon)
2. Enter the person's **full name**
3. Look at the camera and click **"Capture Shot"** — take up to 5 photos from slightly different angles
4. Click **"Register Person"**
5. The system extracts face embeddings and stores them immediately
6. Recognition starts working for that person right away — no restart needed

### 2. Monitor Attendance

1. Click the **"Live Monitor"** tab
2. Click **"Start Camera"**
3. The system will:
   - Draw green bounding boxes around recognized faces with name + confidence %
   - Draw red dashed boxes around unknown faces with "UNKNOWN" label
   - Automatically log attendance the first time a person is seen
   - Show real-time detection cards and activity feed

### 3. View Attendance Log

1. Click the **"Attendance Log"** tab
2. Today's entries are shown by default
3. Use the date picker to view past dates
4. Each entry shows: name, time, confidence %, and status (recognized/unknown)

### 4. Manage Registered People

1. Click the **"People"** tab
2. View all registered people with their encoding counts
3. Click **"Remove"** to delete a person and all their encodings

---

## Architecture

```
Browser (Webcam via getUserMedia)
    |
    | Base64 JPEG frame every 800ms
    v
Flask Server (app.py)
    |
    |--- face_engine.py
    |      |-- YuNet (ONNX) -- face detection
    |      |-- SFace (ONNX) -- 128-d face embedding
    |      |-- Cosine similarity matching
    |
    |--- database.py
           |-- registered_faces table (SQLite)
           |-- attendance_log table (SQLite)
```

### Tech Stack

| Component | Technology | Why |
|-----------|-----------|-----|
| **Backend** | Python + Flask | Best ML ecosystem; lightweight web framework |
| **Face Detection** | YuNet (OpenCV DNN) | Fast, lightweight (~227KB), works on CPU |
| **Face Recognition** | SFace (OpenCV DNN) | 128-d embeddings, ~36MB model, no GPU needed |
| **Webcam** | Browser getUserMedia | Avoids OS permissions issues; modern UX |
| **Database** | SQLite (WAL mode) | Zero-config, file-based, concurrent reads |
| **Frontend** | Vanilla HTML/CSS/JS | No build step, fast load, premium design |
| **Matching** | Cosine similarity | Standard metric for face embeddings |

### Key Design Decisions

| Decision | Rationale |
|----------|-----------|
| OpenCV YuNet+SFace over dlib | Works on Python 3.14, no C++ compilation needed |
| Browser webcam over OpenCV capture | Avoids Windows webcam permission issues |
| In-memory embedding cache | Avoids DB reads per frame; reloaded on registration |
| 800ms frame interval | Balances responsiveness with CPU load |
| Cosine threshold 0.363 | Recommended by OpenCV Zoo for SFace model |

---

## Project Structure

```
scannerbysrkay/
├── app.py                  # Flask server + API routes
├── face_engine.py          # Face detection & recognition (YuNet + SFace)
├── database.py             # SQLite operations
├── download_models.py      # Model downloader script
├── requirements.txt        # Python dependencies
├── README.md               # This file
├── models/                 # ONNX models (downloaded automatically)
│   ├── face_detection_yunet_2023mar.onnx
│   └── face_recognition_sface_2021dec.onnx
├── known_faces/            # Saved face images (auto-created)
├── data/
│   └── attendance.db       # SQLite database (auto-created)
├── static/
│   ├── css/style.css       # Premium dark UI stylesheet
│   └── js/app.js           # Client-side webcam & UI logic
└── templates/
    └── index.html          # Single-page application
```

---

## Troubleshooting

| Issue | Solution |
|-------|---------|
| "Model not found" error | Run `python download_models.py` to download ONNX models |
| Camera not starting | Allow camera permissions in browser; close other apps using webcam |
| No face detected | Ensure good lighting; face the camera directly; avoid heavy occlusion |
| Low confidence matches | Register more photos (5 from different angles); the SFace model works best with clear, well-lit photos |
| Server won't start | Check port 5000 isn't in use; activate venv first |
| `pip install` errors | Ensure Python 3.10+ is installed and pip is up to date |

---

## License

MIT — Use freely for personal and commercial projects.
