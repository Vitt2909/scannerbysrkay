/**
 * app.js — FaceLog client
 * Webcam capture, recognition, registration, attendance, toasts.
 * Canvas overlay: thin rounded rects with semi-transparent fill.
 */

const state = {
    cameraStream: null,
    recognitionInterval: null,
    recognitionActive: true,
    capturedImages: [],
    activityLog: [],
    mirrorVideo: false, // toggle for selfie-style mirror
};

const RECOGNITION_INTERVAL = 800;
const LERP_FACTOR = 0.35;
const HOLD_FRAMES = 4;

let adminTrackedFaces = [];

const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => document.querySelectorAll(sel);

const dom = {
    video: $('#webcam-video'),
    canvas: $('#overlay-canvas'),
    placeholder: $('#camera-placeholder'),
    btnStart: $('#btn-start-camera'),
    btnStop: $('#btn-stop-camera'),
    toggleRecognition: $('#toggle-recognition'),
    fpsDisplay: $('#fps-display'),
    detectionsList: $('#detections-list'),
    detectionCount: $('#detection-count'),
    activityFeed: $('#activity-feed'),

    registerVideo: $('#register-video'),
    registerPlaceholder: $('#register-camera-placeholder'),
    btnCapture: $('#btn-capture'),
    captureCount: $('#capture-count'),
    capturedPreviews: $('#captured-previews'),
    registerName: $('#register-name'),
    btnRegister: $('#btn-register'),
    btnClearCaptures: $('#btn-clear-captures'),
    registerStatus: $('#register-status'),

    attendanceDate: $('#attendance-date'),
    attendanceTbody: $('#attendance-tbody'),
    attendanceSummary: $('#attendance-summary'),
    btnRefreshAttendance: $('#btn-refresh-attendance'),

    peopleGrid: $('#people-grid'),
    btnRefreshPeople: $('#btn-refresh-people'),

    systemStatus: $('#system-status'),
    statusText: $('.status-text'),
    faceCountNumber: $('.count-number'),

    tabs: $$('.nav-tab'),
    panels: $$('.tab-panel'),
    toastContainer: $('#toast-container'),
};

// ── Init ─────────────────────────────────────────────────

document.addEventListener('DOMContentLoaded', () => {
    initTabs();
    initMonitor();
    initRegister();
    initAttendance();
    initPeople();
    checkSystemStatus();
    setTodayDate();
});

function setTodayDate() {
    dom.attendanceDate.value = new Date().toISOString().split('T')[0];
}

async function checkSystemStatus() {
    try {
        const res = await fetch('/api/status');
        const data = await res.json();
        dom.systemStatus.classList.add('online');
        dom.statusText.textContent = 'Online';
        dom.faceCountNumber.textContent = data.registered_people;
    } catch {
        dom.statusText.textContent = 'Offline';
    }
}

// ── Tabs ─────────────────────────────────────────────────

function initTabs() {
    dom.tabs.forEach(tab => {
        tab.addEventListener('click', () => {
            const target = tab.dataset.tab;
            dom.tabs.forEach(t => t.classList.remove('active'));
            dom.panels.forEach(p => p.classList.remove('active'));
            tab.classList.add('active');
            $(`#panel-${target}`).classList.add('active');
            if (target === 'register') startRegisterCamera();
            if (target === 'attendance') loadAttendance();
            if (target === 'people') loadPeople();
        });
    });
}

// ── Monitor ──────────────────────────────────────────────

function initMonitor() {
    dom.btnStart.addEventListener('click', startCamera);
    dom.btnStop.addEventListener('click', stopCamera);
    dom.toggleRecognition.addEventListener('change', (e) => {
        state.recognitionActive = e.target.checked;
        if (!state.recognitionActive) { clearCanvas(); updateDetections([]); }
    });

    // Mirror toggle — selfie-style flip (admin-only)
    const mirrorToggle = document.getElementById('toggle-mirror');
    if (mirrorToggle) {
        mirrorToggle.addEventListener('change', (e) => {
            state.mirrorVideo = e.target.checked;
            const scaleVal = state.mirrorVideo ? 'scaleX(-1)' : '';
            dom.video.style.transform = scaleVal;
            dom.canvas.style.transform = scaleVal;
            if (dom.registerVideo) dom.registerVideo.style.transform = scaleVal;
        });
    }
}

async function startCamera() {
    try {
        state.cameraStream = await navigator.mediaDevices.getUserMedia({
            video: { width: { ideal: 640 }, height: { ideal: 480 }, facingMode: 'user' }
        });
        dom.video.srcObject = state.cameraStream;
        dom.placeholder.classList.add('hidden');
        dom.btnStart.disabled = true;
        dom.btnStop.disabled = false;
        dom.video.addEventListener('loadeddata', () => {
            dom.canvas.width = dom.video.videoWidth;
            dom.canvas.height = dom.video.videoHeight;
            startRecognitionLoop();
        }, { once: true });
    } catch (err) {
        showToast('error', `Camera: ${err.message}`);
    }
}

function stopCamera() {
    if (state.cameraStream) {
        state.cameraStream.getTracks().forEach(t => t.stop());
        state.cameraStream = null;
    }
    if (state.recognitionInterval) {
        clearInterval(state.recognitionInterval);
        state.recognitionInterval = null;
    }
    dom.video.srcObject = null;
    dom.placeholder.classList.remove('hidden');
    dom.btnStart.disabled = false;
    dom.btnStop.disabled = true;
    clearCanvas();
    updateDetections([]);
    dom.fpsDisplay.textContent = '';
}

function startRecognitionLoop() {
    if (state.recognitionInterval) clearInterval(state.recognitionInterval);
    state.recognitionInterval = setInterval(async () => {
        if (!state.recognitionActive || !state.cameraStream) return;
        const start = performance.now();
        const frame = captureFrame(dom.video);
        if (!frame) return;
        try {
            const res = await fetch('/api/recognize', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ image: frame }),
            });
            const data = await res.json();
            const ms = Math.round(performance.now() - start);
            dom.fpsDisplay.textContent = `${ms}ms`;
            if (data.faces) {
                drawFaceBoxes(data.faces);
                updateDetections(data.faces);
                processActivityFeed(data.faces);
            }
        } catch (err) {
            console.error('Recognition error:', err);
        }
    }, RECOGNITION_INTERVAL);
}

function captureFrame(videoEl) {
    if (!videoEl.videoWidth) return null;
    const c = document.createElement('canvas');
    c.width = videoEl.videoWidth;
    c.height = videoEl.videoHeight;
    c.getContext('2d').drawImage(videoEl, 0, 0);
    return c.toDataURL('image/jpeg', 0.7);
}

// ── Canvas — Smoothed Corner-Only Boxes ──────────────────

function lerpVal(a, b, t) { return a + (b - a) * t; }

function updateAdminTrackedFaces(newFaces) {
    const cw = dom.canvas.width;
    const ch = dom.canvas.height;
    const vw = dom.video.videoWidth;
    const vh = dom.video.videoHeight;
    const sx = cw / vw, sy = ch / vh;

    const incoming = newFaces.map(f => {
        const [top, right, bottom, left] = f.location;
        return {
            x: left * sx, y: top * sy,
            w: (right - left) * sx, h: (bottom - top) * sy,
            name: f.name, status: f.status, confidence: f.confidence,
        };
    });

    const used = new Set();
    for (const t of adminTrackedFaces) {
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
            t.x = lerpVal(t.x, n.x, LERP_FACTOR);
            t.y = lerpVal(t.y, n.y, LERP_FACTOR);
            t.w = lerpVal(t.w, n.w, LERP_FACTOR);
            t.h = lerpVal(t.h, n.h, LERP_FACTOR);
            t.name = n.name; t.status = n.status; t.confidence = n.confidence;
            t.missedFrames = 0;
            t.alpha = Math.min(1, t.alpha + 0.15);
        } else {
            t.missedFrames++;
        }
    }

    for (let i = 0; i < incoming.length; i++) {
        if (!used.has(i)) {
            adminTrackedFaces.push({ ...incoming[i], alpha: 0.1, missedFrames: 0 });
        }
    }

    adminTrackedFaces = adminTrackedFaces.filter(t => {
        if (t.missedFrames > 0) t.alpha = Math.max(0, t.alpha - (1 / HOLD_FRAMES));
        return t.missedFrames <= HOLD_FRAMES;
    });
}

function drawFaceBoxes(faces) {
    updateAdminTrackedFaces(faces);
    const ctx = dom.canvas.getContext('2d');
    const cw = dom.canvas.width;
    const ch = dom.canvas.height;
    ctx.clearRect(0, 0, cw, ch);

    if (adminTrackedFaces.length === 0) {
        ctx.font = '300 13px Inter, sans-serif';
        ctx.fillStyle = 'rgba(255,255,255,0.12)';
        ctx.textAlign = 'center';
        ctx.fillText('Scanning...', cw / 2, ch / 2);
        ctx.textAlign = 'start';
        return;
    }

    for (const f of adminTrackedFaces) {
        const { x, y, w, h, status, name, confidence, alpha } = f;
        const ok = status === 'recognized';
        const [r, g, b] = ok ? [0, 212, 170] : [255, 120, 140];

        const cornerLen = Math.min(w, h) * 0.22;
        ctx.lineCap = 'round';
        ctx.lineWidth = 2;
        ctx.strokeStyle = `rgba(${r},${g},${b},${0.7 * alpha})`;
        ctx.shadowColor = `rgba(${r},${g},${b},${0.35 * alpha})`;
        ctx.shadowBlur = 12;

        drawAdminCorners(ctx, x, y, w, h, cornerLen, 6);

        ctx.shadowColor = 'transparent';
        ctx.shadowBlur = 0;

        const pct = (confidence * 100).toFixed(1) + '%';
        const label = ok ? `${name}  ${pct}` : 'Unknown';
        ctx.font = '400 12px Inter, -apple-system, sans-serif';
        const tw = ctx.measureText(label).width;
        const pillH = 24, pillW = tw + 18;
        const pillX = x, pillY = y - pillH - 8;

        ctx.fillStyle = `rgba(${r},${g},${b},${0.12 * alpha})`;
        ctx.beginPath(); ctx.roundRect(pillX, pillY, pillW, pillH, 12); ctx.fill();
        ctx.strokeStyle = `rgba(${r},${g},${b},${0.25 * alpha})`;
        ctx.lineWidth = 0.5; ctx.stroke();
        ctx.fillStyle = `rgba(${r},${g},${b},${0.92 * alpha})`;
        ctx.fillText(label, pillX + 9, pillY + 16);
    }
}

function drawAdminCorners(ctx, x, y, w, h, len, cr) {
    ctx.beginPath(); ctx.moveTo(x, y + len); ctx.arcTo(x, y, x + len, y, cr); ctx.lineTo(x + len, y); ctx.stroke();
    ctx.beginPath(); ctx.moveTo(x + w - len, y); ctx.arcTo(x + w, y, x + w, y + len, cr); ctx.lineTo(x + w, y + len); ctx.stroke();
    ctx.beginPath(); ctx.moveTo(x, y + h - len); ctx.arcTo(x, y + h, x + len, y + h, cr); ctx.lineTo(x + len, y + h); ctx.stroke();
    ctx.beginPath(); ctx.moveTo(x + w - len, y + h); ctx.arcTo(x + w, y + h, x + w, y + h - len, cr); ctx.lineTo(x + w, y + h - len); ctx.stroke();
}

function clearCanvas() {
    const ctx = dom.canvas.getContext('2d');
    ctx.clearRect(0, 0, dom.canvas.width, dom.canvas.height);
    adminTrackedFaces = [];
}


// ── Detections ───────────────────────────────────────────

function updateDetections(faces) {
    dom.detectionCount.textContent = faces.length;
    if (faces.length === 0) {
        dom.detectionsList.innerHTML = '<div class="empty-state"><span>No faces in frame</span></div>';
        return;
    }
    dom.detectionsList.innerHTML = faces.map(face => {
        const ok = face.status === 'recognized';
        const pct = Math.round(face.confidence * 100);
        const cls = pct >= 75 ? 'high' : pct >= 50 ? 'medium' : 'low';
        const initial = ok ? face.name.charAt(0).toUpperCase() : '?';
        return `
            <div class="detection-card ${face.status}">
                <div class="detection-avatar">${initial}</div>
                <div class="detection-info">
                    <div class="detection-name">${ok ? face.name : 'Unknown'}</div>
                    <div class="detection-meta">
                        <span>${pct}%</span>
                        <div class="confidence-bar">
                            <div class="confidence-fill ${cls}" style="width:${pct}%"></div>
                        </div>
                    </div>
                </div>
            </div>`;
    }).join('');
}

function processActivityFeed(faces) {
    const t = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
    faces.forEach(face => {
        if (!face.logged) return;
        state.activityLog.unshift({ name: face.name, status: face.status, time: t, message: face.message });
        if (state.activityLog.length > 20) state.activityLog.pop();
        if (face.status === 'recognized') {
            showToast('success', `${face.name} — logged`);
        } else {
            showToast('warning', 'Unknown face flagged');
        }
        checkSystemStatus();
    });
    renderActivityFeed();
}

function renderActivityFeed() {
    if (!state.activityLog.length) {
        dom.activityFeed.innerHTML = '<div class="empty-state"><span>Waiting...</span></div>';
        return;
    }
    dom.activityFeed.innerHTML = state.activityLog.map(i => `
        <div class="activity-item ${i.status}">
            <span class="activity-dot"></span>
            <span>${i.status === 'recognized' ? i.name : 'Unknown'}</span>
            <span class="activity-time">${i.time}</span>
        </div>
    `).join('');
}

// ── Register ─────────────────────────────────────────────

function initRegister() {
    dom.btnCapture.addEventListener('click', captureRegistrationShot);
    dom.btnRegister.addEventListener('click', registerPerson);
    dom.btnClearCaptures.addEventListener('click', clearCaptures);
    dom.registerName.addEventListener('input', updateRegisterButton);
}

async function startRegisterCamera() {
    try {
        if (!state.cameraStream) {
            state.cameraStream = await navigator.mediaDevices.getUserMedia({
                video: { width: { ideal: 640 }, height: { ideal: 480 }, facingMode: 'user' }
            });
        }
        dom.registerVideo.srcObject = state.cameraStream;
        dom.registerPlaceholder.classList.add('hidden');
        dom.btnCapture.disabled = false;
    } catch (err) {
        showToast('error', `Camera: ${err.message}`);
    }
}

function captureRegistrationShot() {
    if (state.capturedImages.length >= 5) return;
    const frame = captureFrame(dom.registerVideo);
    if (!frame) { showToast('error', 'Camera not ready'); return; }
    state.capturedImages.push(frame);
    updateCapturedPreviews();
    updateRegisterButton();
    showToast('info', `Shot ${state.capturedImages.length}/5`);
}

function updateCapturedPreviews() {
    dom.captureCount.textContent = state.capturedImages.length;
    let html = '';
    for (let i = 0; i < 5; i++) {
        if (i < state.capturedImages.length) {
            html += `<div class="captured-preview">
                <img src="${state.capturedImages[i]}" alt="Shot ${i + 1}">
                <button class="preview-remove" onclick="removeCapture(${i})">×</button>
            </div>`;
        } else {
            html += '<div class="preview-slot">+</div>';
        }
    }
    dom.capturedPreviews.innerHTML = html;
    dom.btnCapture.disabled = state.capturedImages.length >= 5;
}

window.removeCapture = function(i) {
    state.capturedImages.splice(i, 1);
    updateCapturedPreviews();
    updateRegisterButton();
};

function updateRegisterButton() {
    dom.btnRegister.disabled = !(dom.registerName.value.trim() && state.capturedImages.length);
}

async function registerPerson() {
    const name = dom.registerName.value.trim();
    if (!name || !state.capturedImages.length) return;
    dom.btnRegister.disabled = true;
    dom.btnRegister.textContent = 'Registering...';
    dom.registerStatus.className = 'register-status';
    dom.registerStatus.style.display = 'none';

    try {
        const res = await fetch('/api/register', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ name, images: state.capturedImages }),
        });
        const data = await res.json();
        if (data.success) {
            dom.registerStatus.className = 'register-status success';
            dom.registerStatus.textContent = data.message;
            dom.registerStatus.style.display = 'block';
            showToast('success', `${name} registered`);
            clearCaptures();
            dom.registerName.value = '';
            checkSystemStatus();
        } else {
            dom.registerStatus.className = 'register-status error';
            dom.registerStatus.textContent = data.message;
            dom.registerStatus.style.display = 'block';
            showToast('error', data.message);
        }
    } catch (err) {
        dom.registerStatus.className = 'register-status error';
        dom.registerStatus.textContent = `Error: ${err.message}`;
        dom.registerStatus.style.display = 'block';
    }
    dom.btnRegister.textContent = 'Register';
    updateRegisterButton();
}

function clearCaptures() {
    state.capturedImages = [];
    updateCapturedPreviews();
    updateRegisterButton();
    dom.registerStatus.style.display = 'none';
}

// ── Attendance ───────────────────────────────────────────

function initAttendance() {
    dom.btnRefreshAttendance.addEventListener('click', loadAttendance);
    dom.attendanceDate.addEventListener('change', loadAttendance);
}

async function loadAttendance() {
    try {
        const res = await fetch(`/api/attendance?date=${dom.attendanceDate.value}`);
        const data = await res.json();
        renderAttendance(data.entries);
        dom.attendanceSummary.textContent = `${data.count} entries`;
    } catch { showToast('error', 'Failed to load'); }
}

function renderAttendance(entries) {
    if (!entries?.length) {
        dom.attendanceTbody.innerHTML = '<tr class="empty-row"><td colspan="5">No records</td></tr>';
        return;
    }
    dom.attendanceTbody.innerHTML = entries.map((e, i) => {
        const time = e.timestamp?.split(' ')[1] || e.timestamp || '';
        return `<tr>
            <td>${entries.length - i}</td>
            <td>${e.name}</td>
            <td>${time}</td>
            <td>${Math.round(e.confidence * 100)}%</td>
            <td><span class="status-badge ${e.status}">${e.status}</span></td>
        </tr>`;
    }).join('');
}

// ── People ───────────────────────────────────────────────

function initPeople() {
    dom.btnRefreshPeople.addEventListener('click', loadPeople);
}

async function loadPeople() {
    try {
        const res = await fetch('/api/registered');
        const data = await res.json();
        renderPeople(data.people);
    } catch { showToast('error', 'Failed to load'); }
}

function renderPeople(people) {
    if (!people?.length) {
        dom.peopleGrid.innerHTML = '<div class="empty-state"><p>No one registered yet</p></div>';
        return;
    }
    dom.peopleGrid.innerHTML = people.map(p => `
        <div class="person-card">
            <div class="person-avatar-lg">${p.name.charAt(0).toUpperCase()}</div>
            <div class="person-name">${p.name}</div>
            <div class="person-meta">${p.encoding_count} encoding(s)</div>
            <button class="btn btn-danger" onclick="deletePerson('${p.name.replace(/'/g, "\\'")}')">Remove</button>
        </div>
    `).join('');
}

window.deletePerson = async function(name) {
    if (!confirm(`Remove "${name}"?`)) return;
    try {
        const res = await fetch(`/api/registered/${encodeURIComponent(name)}`, { method: 'DELETE' });
        const data = await res.json();
        if (data.success) { showToast('success', data.message); loadPeople(); checkSystemStatus(); }
        else showToast('error', data.message);
    } catch (err) { showToast('error', err.message); }
};

// ── Toast ────────────────────────────────────────────────

function showToast(type, message, ms = 3500) {
    const t = document.createElement('div');
    t.className = `toast ${type}`;
    t.innerHTML = `<span class="toast-icon">${{success:'✓',error:'✕',warning:'!',info:'·'}[type]||'·'}</span><span>${message}</span>`;
    dom.toastContainer.appendChild(t);
    setTimeout(() => { t.classList.add('exiting'); setTimeout(() => t.remove(), 350); }, ms);
}
