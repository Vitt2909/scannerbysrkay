"""
database.py — SQLite database operations for face registration and attendance logging.

Tables:
  - registered_faces: stores person name, face encoding (as bytes), image path, created timestamp
  - attendance_log: stores attendance events with person reference, timestamp, confidence, status
"""

import sqlite3
import os
import pickle
import numpy as np
from datetime import datetime, timedelta

DB_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), "data")
DB_PATH = os.path.join(DB_DIR, "attendance.db")


def get_connection():
    """Get a thread-safe SQLite connection with WAL mode for concurrent reads."""
    os.makedirs(DB_DIR, exist_ok=True)
    conn = sqlite3.connect(DB_PATH, check_same_thread=False)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA journal_mode=WAL")
    conn.execute("PRAGMA foreign_keys=ON")
    return conn


def init_db():
    """Create tables if they don't exist."""
    conn = get_connection()
    cursor = conn.cursor()

    cursor.execute("""
        CREATE TABLE IF NOT EXISTS registered_faces (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            name TEXT NOT NULL,
            encoding BLOB NOT NULL,
            image_path TEXT,
            created_at TEXT NOT NULL DEFAULT (datetime('now', 'localtime'))
        )
    """)

    # Setup new schema fields safely without wiping the DB
    try:
        cursor.execute("ALTER TABLE registered_faces ADD COLUMN turma TEXT")
    except sqlite3.OperationalError:
        pass
        
    try:
        cursor.execute("ALTER TABLE registered_faces ADD COLUMN matricula TEXT")
    except sqlite3.OperationalError:
        pass


    cursor.execute("""
        CREATE TABLE IF NOT EXISTS attendance_log (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            person_id INTEGER,
            name TEXT NOT NULL,
            timestamp TEXT NOT NULL DEFAULT (datetime('now', 'localtime')),
            confidence REAL NOT NULL,
            status TEXT NOT NULL DEFAULT 'recognized',
            FOREIGN KEY (person_id) REFERENCES registered_faces(id) ON DELETE SET NULL
        )
    """)

    cursor.execute("""
        CREATE INDEX IF NOT EXISTS idx_attendance_timestamp
        ON attendance_log(timestamp)
    """)

    cursor.execute("""
        CREATE INDEX IF NOT EXISTS idx_attendance_name
        ON attendance_log(name)
    """)

    conn.commit()
    conn.close()


# ─── Registered Faces CRUD ──────────────────────────────────────────────────

def register_face(name: str, encoding: np.ndarray, image_path: str = None) -> int:
    """Register a new face encoding. Returns the row ID."""
    conn = get_connection()
    cursor = conn.cursor()
    encoding_blob = pickle.dumps(encoding)
    cursor.execute(
        "INSERT INTO registered_faces (name, encoding, image_path) VALUES (?, ?, ?)",
        (name, encoding_blob, image_path)
    )
    conn.commit()
    row_id = cursor.lastrowid
    conn.close()
    return row_id


def get_all_registered_faces():
    """Return all registered faces as a list of dicts with decoded encodings."""
    conn = get_connection()
    cursor = conn.cursor()
    cursor.execute("SELECT id, name, encoding, image_path, created_at FROM registered_faces")
    rows = cursor.fetchall()
    conn.close()

    faces = []
    for row in rows:
        faces.append({
            "id": row["id"],
            "name": row["name"],
            "encoding": pickle.loads(row["encoding"]),
            "image_path": row["image_path"],
            "created_at": row["created_at"],
        })
    return faces


def get_registered_people():
    """Return distinct registered people (grouped by name) with count of encodings."""
    conn = get_connection()
    cursor = conn.cursor()
    cursor.execute("""
        SELECT name, COUNT(*) as encoding_count, MIN(created_at) as first_registered,
               MIN(id) as first_id
        FROM registered_faces
        GROUP BY name
        ORDER BY name
    """)
    rows = cursor.fetchall()
    conn.close()
    return [dict(row) for row in rows]


def delete_registered_person(name: str) -> int:
    """Delete all face encodings for a given name. Returns number of rows deleted."""
    conn = get_connection()
    cursor = conn.cursor()
    cursor.execute("DELETE FROM registered_faces WHERE name = ?", (name,))
    conn.commit()
    deleted = cursor.rowcount
    conn.close()
    return deleted


def person_exists(name: str) -> bool:
    """Check if a person with the given name is already registered."""
    conn = get_connection()
    cursor = conn.cursor()
    cursor.execute("SELECT COUNT(*) as cnt FROM registered_faces WHERE name = ?", (name,))
    row = cursor.fetchone()
    conn.close()
    return row["cnt"] > 0


# ─── Attendance Log CRUD ────────────────────────────────────────────────────

def log_attendance(person_id: int, name: str, confidence: float, status: str = "recognized") -> int:
    """Log an attendance event. Returns the row ID."""
    conn = get_connection()
    cursor = conn.cursor()
    cursor.execute(
        "INSERT INTO attendance_log (person_id, name, confidence, status) VALUES (?, ?, ?, ?)",
        (person_id, name, confidence, status)
    )
    conn.commit()
    row_id = cursor.lastrowid
    conn.close()
    return row_id


def get_recent_log_for_person(name: str, cooldown_minutes: int = 30) -> dict:
    """Check if a person was logged within the cooldown window. Returns the log entry or None."""
    conn = get_connection()
    cursor = conn.cursor()
    cutoff = (datetime.now() - timedelta(minutes=cooldown_minutes)).strftime("%Y-%m-%d %H:%M:%S")
    cursor.execute(
        "SELECT * FROM attendance_log WHERE name = ? AND timestamp > ? ORDER BY timestamp DESC LIMIT 1",
        (name, cutoff)
    )
    row = cursor.fetchone()
    conn.close()
    return dict(row) if row else None


def get_today_attendance():
    """Return all attendance entries for today."""
    conn = get_connection()
    cursor = conn.cursor()
    today = datetime.now().strftime("%Y-%m-%d")
    cursor.execute("""
        SELECT a.id, a.person_id, a.name, a.timestamp, a.confidence, a.status, r.image_path as photo_url
        FROM attendance_log a
        LEFT JOIN registered_faces r ON a.person_id = r.id
        WHERE date(a.timestamp) = ? 
        ORDER BY a.timestamp DESC
    """, (today,))
    rows = cursor.fetchall()
    conn.close()
    return [dict(row) for row in rows]

def get_last_recognized():
    """Return the single most recent recognized attendance event with person details."""
    conn = get_connection()
    cursor = conn.cursor()
    cursor.execute("""
        SELECT a.name, a.timestamp, a.confidence, r.image_path as photo_url, r.turma, r.matricula
        FROM attendance_log a
        LEFT JOIN registered_faces r ON a.person_id = r.id
        WHERE a.status = 'recognized'
        ORDER BY a.timestamp DESC LIMIT 1
    """)
    row = cursor.fetchone()
    conn.close()
    return dict(row) if row else None


def get_attendance_by_date(date_str: str):
    """Return all attendance entries for a specific date (YYYY-MM-DD)."""
    conn = get_connection()
    cursor = conn.cursor()
    cursor.execute(
        "SELECT id, person_id, name, timestamp, confidence, status FROM attendance_log WHERE date(timestamp) = ? ORDER BY timestamp DESC",
        (date_str,)
    )
    rows = cursor.fetchall()
    conn.close()
    return [dict(row) for row in rows]
