"""
app.py — Flask server for the Facial Recognition Attendance System.

Two interfaces:
  /view   — Public display (read-only, auto-refreshing, no controls)
  /admin  — Protected panel (registration, attendance, people management)

Auth: Session-based password. Set via FACELOG_ADMIN_PASSWORD env var or default.
"""

import os
import secrets
from datetime import datetime
from functools import wraps
from flask import Flask, render_template, request, jsonify, session, redirect, url_for, send_from_directory

import database as db
import face_engine as engine

# ─── Configuration ───────────────────────────────────────────────────────────

app = Flask(__name__)
app.config["MAX_CONTENT_LENGTH"] = 16 * 1024 * 1024  # 16MB max

# Session secret key — generated per-run, or set via env for persistence across restarts
app.secret_key = os.environ.get("FACELOG_SECRET_KEY", secrets.token_hex(32))

# Admin password — set via environment variable, fallback to default
ADMIN_PASSWORD = os.environ.get("FACELOG_ADMIN_PASSWORD", "admin123")

# Attendance cooldown in minutes
ATTENDANCE_COOLDOWN = 30


# ─── Auth Decorator ──────────────────────────────────────────────────────────

def admin_required(f):
    """Decorator that protects a route — redirects to login if not authenticated."""
    @wraps(f)
    def decorated(*args, **kwargs):
        if not session.get("admin_authenticated"):
            if request.is_json or request.content_type == "application/json":
                return jsonify({"error": "Unauthorized"}), 401
            return redirect(url_for("admin_login"))
        return f(*args, **kwargs)
    return decorated


# ─── Startup ─────────────────────────────────────────────────────────────────

def initialize():
    """Initialize database and load known faces into memory."""
    db.init_db()
    faces = db.get_all_registered_faces()
    engine.load_known_faces(faces)
    print(f"[INIT] Loaded {engine.get_known_count()} face encodings.")
    print(f"[AUTH] Admin password: {'(from env)' if os.environ.get('FACELOG_ADMIN_PASSWORD') else ADMIN_PASSWORD}")


# ─── Page Routes ─────────────────────────────────────────────────────────────

@app.route("/")
def index():
    """Root redirects to public view."""
    return redirect(url_for("public_view"))


@app.route("/view")
def public_view():
    """Public display — read-only, auto-refreshing, no controls."""
    return render_template("view.html")


@app.route("/admin")
@admin_required
def admin_panel():
    """Admin panel — registration, attendance, people management."""
    return render_template("admin.html")


@app.route("/admin/login", methods=["GET", "POST"])
def admin_login():
    """Login gate for admin panel."""
    if request.method == "POST":
        password = request.form.get("password", "")
        if password == ADMIN_PASSWORD:
            session["admin_authenticated"] = True
            session.permanent = True
            return redirect(url_for("admin_panel"))
        return render_template("login.html", error="Invalid password")
    return render_template("login.html", error=None)


@app.route("/admin/logout")
def admin_logout():
    """Clear admin session."""
    session.pop("admin_authenticated", None)
    return redirect(url_for("public_view"))


@app.route("/known_faces/<path:filename>")
def serve_known_faces(filename):
    """Serve registered face images."""
    return send_from_directory("known_faces", filename)


# ─── Public API (no auth) ───────────────────────────────────────────────────

@app.route("/api/recognize", methods=["POST"])
def api_recognize():
    """Accept a base64 frame, run face recognition, log attendance."""
    data = request.get_json(silent=True)
    if not data or "image" not in data:
        return jsonify({"error": "Missing 'image' field"}), 400

    try:
        image = engine.base64_to_image(data["image"])
    except Exception as e:
        return jsonify({"error": f"Invalid image: {str(e)}"}), 400

    results = engine.recognize_faces(image)

    response_faces = []
    for face in results:
        face_data = {
            "location": list(face["location"]),
            "name": face["name"],
            "confidence": face["confidence"],
            "status": face["status"],
            "logged": False,
            "message": "",
        }

        if face["status"] == "recognized":
            recent = db.get_recent_log_for_person(face["name"], ATTENDANCE_COOLDOWN)
            if recent is None:
                db.log_attendance(
                    person_id=face["person_id"],
                    name=face["name"],
                    confidence=face["confidence"],
                    status="recognized"
                )
                face_data["logged"] = True
                face_data["message"] = f"Logged at {datetime.now().strftime('%H:%M:%S')}"
            else:
                face_data["message"] = f"Already logged at {recent['timestamp']}"
        else:
            recent_unknown = db.get_recent_log_for_person("Unknown", cooldown_minutes=5)
            if recent_unknown is None:
                db.log_attendance(
                    person_id=None,
                    name="Unknown",
                    confidence=face["confidence"],
                    status="unknown"
                )
                face_data["logged"] = True
                face_data["message"] = "Unknown face flagged"
            else:
                face_data["message"] = "Unknown (recently flagged)"

        response_faces.append(face_data)

    return jsonify({"faces": response_faces, "count": len(response_faces)})


@app.route("/api/attendance", methods=["GET"])
def api_attendance():
    """Return attendance log — public read access."""
    date_str = request.args.get("date")
    entries = db.get_attendance_by_date(date_str) if date_str else db.get_today_attendance()
    return jsonify({"entries": entries, "count": len(entries)})


@app.route("/api/last_recognized", methods=["GET"])
def api_last_recognized():
    """Return the most recently recognized person for the view display."""
    last = db.get_last_recognized()
    if last:
        # Convert absolute/relative image path to a url path format if possible.
        # But image_path usually looks like: "known_faces/Joao/0.jpg". We'll just prefix "/" 
        # so frontend will cleanly hit our serving route.
        photo_url = None
        if last.get("photo_url"):
            # Normalize path slashes
            photo_url = "/" + last["photo_url"].replace("\\", "/")
            
        return jsonify({
            "name": last.get("name"),
            "photo_url": photo_url,
            "timestamp": last.get("timestamp"),
            "confidence": last.get("confidence"),
            "turma": last.get("turma"),
            "matricula": last.get("matricula")
        })
    return jsonify({"error": "No recognized faces yet"}), 404


@app.route("/api/status", methods=["GET"])
def api_status():
    """System status — public."""
    return jsonify({
        "status": "online",
        "known_faces": engine.get_known_count(),
        "registered_people": len(db.get_registered_people()),
    })


# ─── Admin API (auth required) ──────────────────────────────────────────────

@app.route("/api/register", methods=["POST"])
@admin_required
def api_register():
    """Register a new face — admin only."""
    data = request.get_json(silent=True)
    if not data or "name" not in data or "images" not in data:
        return jsonify({"error": "Missing 'name' or 'images' field"}), 400

    name = data["name"].strip()
    images = data["images"]

    if not name:
        return jsonify({"error": "Name cannot be empty"}), 400
    if not images or len(images) == 0:
        return jsonify({"error": "At least one image is required"}), 400

    encodings_added = 0
    errors = []

    for i, img_b64 in enumerate(images):
        try:
            image = engine.base64_to_image(img_b64)
            encoding, location, status = engine.encode_single_face(image)
            if encoding is None:
                errors.append(f"Image {i+1}: No face detected")
                continue
            image_path = engine.save_face_image(image, name, i)
            db.register_face(name, encoding, image_path)
            encodings_added += 1
        except Exception as e:
            errors.append(f"Image {i+1}: {str(e)}")

    if encodings_added > 0:
        faces = db.get_all_registered_faces()
        engine.load_known_faces(faces)
        msg = f"Registered '{name}' with {encodings_added} encoding(s)"
        if errors:
            msg += f" ({len(errors)} skipped)"
        return jsonify({"success": True, "name": name, "encodings_added": encodings_added, "errors": errors, "message": msg})
    else:
        return jsonify({"success": False, "name": name, "encodings_added": 0, "errors": errors,
                        "message": "No faces registered. Ensure clear, well-lit photos."}), 400


@app.route("/api/registered", methods=["GET"])
@admin_required
def api_registered():
    """List registered people — admin only."""
    people = db.get_registered_people()
    return jsonify({"people": people, "count": len(people)})


@app.route("/api/registered/<name>", methods=["DELETE"])
@admin_required
def api_delete_registered(name):
    """Delete a registered person — admin only."""
    deleted = db.delete_registered_person(name)
    if deleted > 0:
        faces = db.get_all_registered_faces()
        engine.load_known_faces(faces)
        return jsonify({"success": True, "message": f"Deleted '{name}' ({deleted} encoding(s))"})
    return jsonify({"success": False, "message": f"'{name}' not found"}), 404


# ─── Main ────────────────────────────────────────────────────────────────────

if __name__ == "__main__":
    initialize()
    print("\n" + "=" * 60)
    print("  FACELOG -- Attendance System")
    print("  /view   -> Public display     (no auth)")
    print("  /admin  -> Admin panel        (password protected)")
    print("  " + "-" * 56)
    print(f"  Open http://127.0.0.1:5000")
    print("=" * 60 + "\n")
    app.run(host="127.0.0.1", port=5000, debug=True, use_reloader=False)
