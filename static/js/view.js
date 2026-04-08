/**
 * view.js — Public display client (macOS Sequoia Aesthetic)
 * No interactive elements. High-res camera and dual-polling info board.
 */

const RECOGNIZE_INTERVAL = 800;
const LAST_REC_INTERVAL = 1500;
const RECENT_INTERVAL = 3000;

const LERP_FACTOR = 0.35;
const HOLD_FRAMES = 4;

const video = document.getElementById('video');
const canvas = document.getElementById('canvas');
const starting = document.getElementById('camera-starting');
const clock = document.getElementById('clock');
const lastRecognizedCard = document.getElementById('last-recognized-card');
const recentList = document.getElementById('recent-list');

let stream = null;
let lastTimestampRendered = null;
let lastEntriesRenderedHash = "";

let trackedFaces = [];

// ── Boot ─────────────────────────────────────────────────

(async function boot() {
    updateClock();
    setInterval(updateClock, 1000);

    try {
        stream = await navigator.mediaDevices.getUserMedia({
            video: { width: { ideal: 1920 }, height: { ideal: 1080 }, facingMode: 'user' }
        });
        video.srcObject = stream;
        video.addEventListener('loadeddata', () => {
            canvas.width = video.videoWidth;
            canvas.height = video.videoHeight;
            starting.classList.add('hidden');

            runCameraLoop();
            pollLastRecognized();
            pollRecentEntries();

            setInterval(pollLastRecognized, LAST_REC_INTERVAL);
            setInterval(pollRecentEntries, RECENT_INTERVAL);
        }, { once: true });
    } catch (e) {
        starting.querySelector('p').textContent = 'Camera unavailable';
        console.error(e);
    }
})();

// ── Camera Feed Loop ─────────────────────────────────────

function runCameraLoop() {
    setInterval(async () => {
        const frame = captureFrame();
        if (!frame) return;

        try {
            const res = await fetch('/api/recognize', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ image: frame }),
            });
            const data = await res.json();
            updateTrackedFaces(data.faces || []);
            drawOverlay();
        } catch (_) {}
    }, RECOGNIZE_INTERVAL);
}

function captureFrame() {
    if (!video.videoWidth) return null;
    const c = document.createElement('canvas');
    c.width = video.videoWidth;
    c.height = video.videoHeight;
    c.getContext('2d').drawImage(video, 0, 0);
    return c.toDataURL('image/jpeg', 0.7);
}

// ── Smoothing Engine ─────────────────────────────────────

function lerp(a, b, t) { return a + (b - a) * t; }

function updateTrackedFaces(newFaces) {
    const cw = canvas.width;
    const ch = canvas.height;
    const vw = video.videoWidth;
    const vh = video.videoHeight;
    const sx = cw / vw, sy = ch / vh;

    const incoming = newFaces.map(f => {
        const [top, right, bottom, left] = f.location;
        return {
            x: left * sx,
            y: top * sy,
            w: (right - left) * sx,
            h: (bottom - top) * sy,
            name: f.name,
            status: f.status,
            confidence: f.confidence,
        };
    });

    const used = new Set();
    for (const t of trackedFaces) {
        let bestIdx = -1, bestDist = Infinity;
        for (let i = 0; i < incoming.length; i++) {
            if (used.has(i)) continue;
            const dx = (t.x + t.w / 2) - (incoming[i].x + incoming[i].w / 2);
            const dy = (t.y + t.h / 2) - (incoming[i].y + incoming[i].h / 2);
            const dist = Math.sqrt(dx * dx + dy * dy);
            if (dist < bestDist) { bestDist = dist; bestIdx = i; }
        }
        const diagThresh = Math.sqrt(cw * cw + ch * ch) * 0.3;
        if (bestIdx >= 0 && bestDist < diagThresh) {
            used.add(bestIdx);
            const n = incoming[bestIdx];
            t.x = lerp(t.x, n.x, LERP_FACTOR);
            t.y = lerp(t.y, n.y, LERP_FACTOR);
            t.w = lerp(t.w, n.w, LERP_FACTOR);
            t.h = lerp(t.h, n.h, LERP_FACTOR);
            t.name = n.name;
            t.status = n.status;
            t.confidence = n.confidence;
            t.missedFrames = 0;
            t.alpha = Math.min(1, t.alpha + 0.15);
        } else {
            t.missedFrames++;
        }
    }

    for (let i = 0; i < incoming.length; i++) {
        if (!used.has(i)) {
            trackedFaces.push({ ...incoming[i], alpha: 0.1, missedFrames: 0 });
        }
    }

    trackedFaces = trackedFaces.filter(t => {
        if (t.missedFrames > 0) {
            t.alpha = Math.max(0, t.alpha - (1 / HOLD_FRAMES));
        }
        return t.missedFrames <= HOLD_FRAMES;
    });
}

// ── Drawing ──────────────────────────────────────────────

function drawOverlay() {
    const ctx = canvas.getContext('2d');
    ctx.clearRect(0, 0, canvas.width, canvas.height);

    for (const f of trackedFaces) {
        const { x, y, w, h, status, name, alpha } = f;
        const ok = status === 'recognized';
        
        const strokeColor = ok ? `rgba(255, 255, 255, ${0.6 * alpha})` : `rgba(255, 255, 255, ${0.25 * alpha})`;

        // Corner-only bracket
        const cornerLen = Math.min(w, h) * 0.22;
        const cr = 0; // The prompt said "draw 4 L-shaped corners", sharp corners fit macOS best unless specified
        ctx.lineCap = 'square';
        ctx.lineWidth = 1.5;
        ctx.strokeStyle = strokeColor;

        drawCorners(ctx, x, y, w, h, cornerLen, cr);

        // Label pill
        const label = ok ? name : 'Unknown';
        ctx.font = '11px Inter, -apple-system, sans-serif';
        const tw = ctx.measureText(label).width;
        const pillH = 20, pillW = tw + 16;
        const pillX = x + (w / 2) - (pillW / 2), pillY = y - pillH - 6;

        ctx.fillStyle = `rgba(0, 0, 0, ${0.5 * alpha})`;
        ctx.beginPath();
        ctx.roundRect(pillX, pillY, pillW, pillH, 10);
        ctx.fill();

        ctx.fillStyle = `rgba(255, 255, 255, ${1 * alpha})`;
        ctx.fillText(label, pillX + 8, pillY + 14);
    }
}

function drawCorners(ctx, x, y, w, h, len, cr) {
    // Sharp L shaped corners as per standard macOS styles
    // Top-left
    ctx.beginPath();
    ctx.moveTo(x, y + len);
    ctx.lineTo(x, y);
    ctx.lineTo(x + len, y);
    ctx.stroke();

    // Top-right
    ctx.beginPath();
    ctx.moveTo(x + w - len, y);
    ctx.lineTo(x + w, y);
    ctx.lineTo(x + w, y + len);
    ctx.stroke();

    // Bottom-left
    ctx.beginPath();
    ctx.moveTo(x, y + h - len);
    ctx.lineTo(x, y + h);
    ctx.lineTo(x + len, y + h);
    ctx.stroke();

    // Bottom-right
    ctx.beginPath();
    ctx.moveTo(x + w - len, y + h);
    ctx.lineTo(x + w, y + h);
    ctx.lineTo(x + w, y + h - len);
    ctx.stroke();
}

// ── Polling Right Panel ──────────────────────────────────

async function pollLastRecognized() {
    try {
        const res = await fetch('/api/last_recognized');
        if (!res.ok) return;
        const data = await res.json();

        if (data.timestamp === lastTimestampRendered) return;
        lastTimestampRendered = data.timestamp;

        class PlaceholderSVG {
            static get(initial) {
                return `data:image/svg+xml;utf8,<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 56 56"><rect width="56" height="56" fill="%231a1a24"/><text x="28" y="34" font-family="-apple-system, sans-serif" font-size="20" font-weight="400" fill="%23ffffff" text-anchor="middle" opacity="0.5">${initial}</text></svg>`;
            }
        }

        const photo = data.photo_url || PlaceholderSVG.get(data.name.charAt(0).toUpperCase());
        const matchPct = Math.round(data.confidence * 100) + "%";

        const pieces = [];
        if (data.turma) pieces.push(data.turma);
        if (data.matricula) pieces.push(data.matricula);
        pieces.push(data.timestamp.split(' ').pop());

        const metaText = pieces.join(' · ');

        lastRecognizedCard.innerHTML = `
            <img src="${photo}" class="block-avatar" onerror="this.src=''; this.style.opacity=0">
            <div class="block-details">
                <div class="block-name">${data.name}</div>
                <div class="block-meta">${metaText}</div>
            </div>
            <div class="block-confidence">${matchPct}</div>
        `;

        lastRecognizedCard.classList.remove('anim-fade');
        void lastRecognizedCard.offsetWidth;
        lastRecognizedCard.classList.add('anim-fade');

    } catch (e) {
        console.log("Polling last recognized failed:", e);
    }
}

async function pollRecentEntries() {
    try {
        const res = await fetch('/api/attendance');
        if (!res.ok) return;
        const data = await res.json();

        if (!data.entries || data.entries.length === 0) return;

        const top = data.entries.slice(0, 8); // Display fewer to match clean spacing
        const hash = top.map(e => e.id).join(',');

        if (hash === lastEntriesRenderedHash) return;
        lastEntriesRenderedHash = hash;

        class PlaceholderSVGList {
            static get(initial) {
                return `data:image/svg+xml;utf8,<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 40 40"><rect width="40" height="40" fill="%231a1a24"/><text x="20" y="25" font-family="-apple-system, sans-serif" font-size="14" font-weight="400" fill="%23ffffff" text-anchor="middle" opacity="0.5">${initial}</text></svg>`;
            }
        }

        recentList.innerHTML = top.map(e => {
            const ok = e.status === 'recognized';
            const photo = ok && e.photo_url ? e.photo_url : PlaceholderSVGList.get(e.name.charAt(0).toUpperCase());
            return `
                <div class="recent-item">
                    <img src="${photo}" class="recent-avatar" onerror="this.style.opacity=0">
                    <span class="recent-name">${e.name}</span>
                    <span class="recent-time">${e.timestamp.split(' ').pop()}</span>
                </div>
            `;
        }).join('');

    } catch (e) {
        console.log("Polling attendance failed:", e);
    }
}

// ── Clock ────────────────────────────────────────────────

function updateClock() {
    const now = new Date();
    clock.textContent = now.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
}
