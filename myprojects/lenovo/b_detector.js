// detector.js — Goalpost / Rectangle Detector (v5 — SIMPLIFIED)
// ==============================================================
// ROI-CROPPED, simple geometry checks, no over-engineering
// ==============================================================

(function () {
    'use strict';

    const video = document.getElementById('webcam');
    const statusMsg = document.getElementById('status-msg');
    const scannerOvl = document.getElementById('scanner-overlay');
    const arScene = document.getElementById('ar-scene');
    const gameUI = document.getElementById('game-ui');
    const dbgCanvas = document.getElementById('debug-canvas');
    const dbgCtx = dbgCanvas.getContext('2d');

    let isDetecting = true;
    let cocoModel = null;
    let stabilityCounter = 0;
    let lastRect = null;
    let lastVideoTime = -1;
    const LOCK_TARGET = 15;

    // Debug HUD
    const hud = Object.assign(document.createElement('div'), { id: 'dbg-hud' });
    Object.assign(hud.style, {
        position: 'fixed', top: '4px', right: '4px', zIndex: '99999',
        color: '#0f0', fontFamily: 'monospace', fontSize: '10px', lineHeight: '1.3',
        background: 'rgba(0,0,0,0.7)', padding: '4px 8px', borderRadius: '4px',
        pointerEvents: 'none', whiteSpace: 'pre'
    });
    document.body.appendChild(hud);
    function hudUpdate(obj) {
        hud.textContent = Object.entries(obj).map(([k, v]) => `${k}: ${v}`).join('\n');
    }
    function log(msg) { console.log(`[Det] ${msg}`); }

    // ── Webcam ───────────────────────────────────────────────────
    async function setupWebcam() {
        const stream = await navigator.mediaDevices.getUserMedia({
            video: { facingMode: 'environment', width: { ideal: 640 }, height: { ideal: 480 } }
        });
        video.srcObject = stream;
        return new Promise(r => video.addEventListener('loadeddata', r, { once: true }));
    }

    // ── AI (label-only, no fallback) ─────────────────────────────
    async function loadAI() {
        try { cocoModel = await cocoSsd.load(); log('AI ✓'); }
        catch (e) { log('AI failed: ' + e.message); }
    }

    function waitForOpenCV() {
        return new Promise(r => {
            if (window.cvReady) { r(); return; }
            document.addEventListener('cvReady', r, { once: true });
        });
    }

    // ── Boot ─────────────────────────────────────────────────────
    async function boot() {
        statusMsg.textContent = 'Starting camera...';
        try { await setupWebcam(); } catch (e) { statusMsg.textContent = 'Camera Error!'; return; }
        statusMsg.textContent = 'Loading AI & OpenCV...';
        await Promise.all([loadAI(), waitForOpenCV()]);
        while (video.videoWidth === 0) await new Promise(r => setTimeout(r, 50));
        dbgCanvas.width = video.videoWidth;
        dbgCanvas.height = video.videoHeight;
        statusMsg.textContent = 'Point at a rectangular object';
        log(`Boot OK ${video.videoWidth}x${video.videoHeight}`);
        processVideo();
    }
    boot();

    // ── Main Loop ────────────────────────────────────────────────
    function processVideo() {
        if (!isDetecting) return;
        if (video.readyState < 4) { requestAnimationFrame(processVideo); return; }

        const vw = video.videoWidth, vh = video.videoHeight;
        if (dbgCanvas.width !== vw) { dbgCanvas.width = vw; dbgCanvas.height = vh; }
        dbgCtx.clearRect(0, 0, vw, vh);

        // Draw video
        dbgCtx.drawImage(video, 0, 0, vw, vh);

        // ROI box (landscape band: 95% wide, 16:7 aspect — matches CSS guide)
        const roiW = Math.floor(vw * 0.95);
        const roiH = Math.floor(roiW * 7 / 16);  // 16:7 aspect ratio
        const roiX = Math.floor((vw - roiW) / 2);
        const roiY = Math.floor((vh - roiH) / 2);

        // CV detection on ROI (BEFORE drawing overlay so edges don't pollute Canny)
        const cvResult = runCV(vw, vh, roiX, roiY, roiW, roiH);

        // Draw ROI outline AFTER CV extraction so it doesn't pollute edges
        dbgCtx.strokeStyle = 'rgba(255,255,255,0.5)';
        dbgCtx.lineWidth = 2;
        dbgCtx.strokeRect(roiX, roiY, roiW, roiH);

        // AI for labeling (async)
        if (cocoModel && video.currentTime !== lastVideoTime) {
            lastVideoTime = video.currentTime;
            cocoModel.detect(video).then(preds => finalize(cvResult, preds, vw, vh));
        } else {
            finalize(cvResult, [], vw, vh);
        }

        requestAnimationFrame(processVideo);
    }

    // ══════════════════════════════════════════════════════════════
    // CV DETECTION — SIMPLE GEOMETRY
    // ══════════════════════════════════════════════════════════════
    function runCV(vw, vh, roiX, roiY, roiW, roiH) {
        try {
            // Extract ROI pixels
            const roiData = dbgCtx.getImageData(roiX, roiY, roiW, roiH);
            const src = new cv.Mat(roiH, roiW, cv.CV_8UC4);
            src.data.set(roiData.data);

            // Gray → Blur → Canny → Close
            const gray = new cv.Mat(), blur = new cv.Mat();
            cv.cvtColor(src, gray, cv.COLOR_RGBA2GRAY);
            cv.GaussianBlur(gray, blur, new cv.Size(5, 5), 0);
            src.delete();

            const edges = new cv.Mat();
            cv.Canny(blur, edges, 50, 120);  // Higher thresholds: ignore weak edges (cables/shadows)
            gray.delete(); blur.delete();

            const kernel = cv.Mat.ones(3, 3, cv.CV_8U);  // Smaller kernel: don't merge separate objects
            const closed = new cv.Mat();
            cv.morphologyEx(edges, closed, cv.MORPH_CLOSE, kernel);
            kernel.delete();

            const contours = new cv.MatVector();
            const hierarchy = new cv.Mat();
            cv.findContours(closed, contours, hierarchy, cv.RETR_EXTERNAL, cv.CHAIN_APPROX_SIMPLE);

            let best = null, bestArea = 0;
            const minA = roiW * roiH * 0.05;  // 5% of ROI (ignore small noise)
            const maxA = roiW * roiH * 0.85;  // 85% of ROI
            let stats = { total: contours.size(), ok: 0, info: [] };

            for (let i = 0; i < contours.size(); i++) {
                const cnt = contours.get(i);
                const area = cv.contourArea(cnt);
                if (area < minA || area > maxA) continue;

                const br = cv.boundingRect(cnt);
                const brArea = br.width * br.height;
                if (brArea <= 0) continue;

                const fill = area / brArea;  // How rectangular (1.0 = perfect)

                // Convexity check: reject merged multi-object blobs
                const hull = new cv.Mat();
                cv.convexHull(cnt, hull);
                const hullArea = cv.contourArea(hull);
                const solidity = hullArea > 0 ? area / hullArea : 0;
                hull.delete();

                const peri = cv.arcLength(cnt, true);
                const approx = new cv.Mat();
                cv.approxPolyDP(cnt, approx, 0.04 * peri, true);
                const v = approx.rows;
                approx.delete();

                const aspect = br.width / br.height;

                // TIGHTER CHECK:
                //   4-8 vertices, fill > 0.3, solidity > 0.85, landscape aspect 1.2-4.0
                const ok = v >= 4 && v <= 8 && fill > 0.3 && solidity > 0.85 && aspect >= 1.2 && aspect <= 4.0;

                const tag = `v${v} f${fill.toFixed(2)} a${aspect.toFixed(1)}`;
                stats.info.push(tag + (ok ? ' ✓' : ''));

                // Draw all candidates in ROI-offset coords
                const fx = br.x + roiX, fy = br.y + roiY;
                dbgCtx.strokeStyle = ok ? 'rgba(0,255,0,0.6)' : 'rgba(255,165,0,0.3)';
                dbgCtx.lineWidth = ok ? 2 : 1;
                dbgCtx.strokeRect(fx, fy, br.width, br.height);
                dbgCtx.fillStyle = ok ? '#0f0' : 'rgba(255,165,0,0.5)';
                dbgCtx.font = '9px monospace';
                dbgCtx.fillText(tag, fx, fy - 2);

                if (ok) {
                    stats.ok++;
                    if (area > bestArea) {
                        bestArea = area;
                        best = {
                            x: fx, y: fy, w: br.width, h: br.height,
                            cx: Math.round(fx + br.width / 2),
                            cy: Math.round(fy + br.height / 2),
                            area, fill: fill.toFixed(2), vertices: v,
                            label: 'Object', source: 'CV'
                        };
                    }
                }
            }

            contours.delete(); hierarchy.delete(); edges.delete(); closed.delete();
            window._cvStats = stats;
            return best;
        } catch (e) {
            log('CV err: ' + e.message);
            return null;
        }
    }

    // ══════════════════════════════════════════════════════════════
    // FINALIZE: label with AI if available, then draw + lock
    // ══════════════════════════════════════════════════════════════
    function finalize(cvBest, aiPreds, vw, vh) {
        const aiInfo = aiPreds.length
            ? aiPreds.slice(0, 3).map(p => `${p.class} ${(p.score * 100) | 0}%`).join(', ')
            : '—';
        const cvS = window._cvStats || { total: 0, ok: 0, info: [] };

        let pick = cvBest;  // CV is primary source

        // If AI found something overlapping CV, use its label
        if (pick && aiPreds.length) {
            for (const p of aiPreds) {
                if (p.score < 0.4) continue;
                const [px, py, pw, ph] = p.bbox;
                const acx = px + pw / 2, acy = py + ph / 2;
                const dist = Math.hypot(acx - pick.cx, acy - pick.cy);
                if (dist < Math.min(pick.w, pick.h) * 0.6) {
                    pick.label = p.class;
                    pick.source = 'AI+CV';
                    break;
                }
            }
        }

        // If CV found nothing, let AI be an independent source (high confidence only)
        if (!pick && aiPreds.length) {
            // Recompute ROI bounds (same formula as processVideo)
            const _roiW = Math.floor(vw * 0.95);
            const _roiH = Math.floor(_roiW * 7 / 16);
            const _roiX = Math.floor((vw - _roiW) / 2);
            const _roiY = Math.floor((vh - _roiH) / 2);

            for (const p of aiPreds) {
                if (p.score < 0.6) continue;  // Need 60%+ confidence for AI-only
                const [px, py, pw, ph] = p.bbox;
                const acx = px + pw / 2, acy = py + ph / 2;

                // Entire bbox must be inside ROI
                if (px < _roiX || py < _roiY || px + pw > _roiX + _roiW || py + ph > _roiY + _roiH) continue;

                const aspect = pw / ph;
                if (aspect < 1.0) continue;  // Still require landscape-ish
                pick = {
                    x: Math.round(px), y: Math.round(py),
                    w: Math.round(pw), h: Math.round(ph),
                    cx: Math.round(acx), cy: Math.round(acy),
                    area: pw * ph,
                    fill: '—', vertices: '—',
                    label: p.class, source: 'AI'
                };
                break;
            }
        }

        // HUD
        const top = cvS.info ? cvS.info.slice(0, 4).join(' | ') : '—';
        hudUpdate({
            AI: aiInfo,
            CV: `${cvS.total}→${cvS.ok} ok`,
            Det: top,
            Pick: pick ? `${pick.source} [${pick.label}] ${pick.w}x${pick.h}` : '—',
            Lock: `${stabilityCounter}/${LOCK_TARGET}`
        });

        if (pick) {
            // Highlight the pick with a bright box
            const c = pick.source.includes('AI') ? '#FF00FF' : '#00FFFF';
            dbgCtx.strokeStyle = c; dbgCtx.lineWidth = 3;
            dbgCtx.strokeRect(pick.x, pick.y, pick.w, pick.h);
            dbgCtx.fillStyle = c; dbgCtx.font = '12px monospace';
            dbgCtx.fillText(`${pick.label} [${pick.source}]`, pick.x, pick.y - 3);
            checkStability(pick);
        } else {
            stabilityCounter = 0;
            statusMsg.textContent = 'Point at a rectangular object';
            statusMsg.style.color = 'white';
        }
    }

    // ── Stability → Lock ─────────────────────────────────────────
    function checkStability(rect) {
        if (lastRect) {
            const d = Math.hypot(rect.cx - lastRect.cx, rect.cy - lastRect.cy);
            stabilityCounter = d < 50 ? stabilityCounter + 1 : Math.max(0, stabilityCounter - 1);
        } else {
            stabilityCounter = 1;
        }
        lastRect = rect;

        if (stabilityCounter < LOCK_TARGET) {
            const pct = Math.floor((stabilityCounter / LOCK_TARGET) * 100);
            statusMsg.textContent = `LOCKING... ${pct}%`;
            statusMsg.style.color = 'yellow';
        } else {
            // ═══ LOCKED ═══
            isDetecting = false;
            scannerOvl.style.display = 'none';

            dbgCtx.clearRect(0, 0, dbgCanvas.width, dbgCanvas.height);
            dbgCtx.drawImage(video, 0, 0, dbgCanvas.width, dbgCanvas.height);

            // Green bounding box
            dbgCtx.strokeStyle = '#00FF00'; dbgCtx.lineWidth = 4;
            dbgCtx.strokeRect(rect.x, rect.y, rect.w, rect.h);

            // Red crosshair at center
            dbgCtx.strokeStyle = '#FF0000'; dbgCtx.lineWidth = 2;
            dbgCtx.beginPath();
            dbgCtx.moveTo(rect.cx - 20, rect.cy); dbgCtx.lineTo(rect.cx + 20, rect.cy);
            dbgCtx.moveTo(rect.cx, rect.cy - 20); dbgCtx.lineTo(rect.cx, rect.cy + 20);
            dbgCtx.stroke();

            // Labels
            dbgCtx.fillStyle = '#00FF00'; dbgCtx.font = 'bold 16px monospace';
            dbgCtx.fillText(`LOCKED [${rect.label}]`, rect.x, rect.y - 8);
            dbgCtx.font = '14px monospace';
            dbgCtx.fillText(`Center: (${rect.cx}, ${rect.cy})`, rect.x, rect.y + rect.h + 16);
            dbgCtx.fillText(`Size: ${rect.w} x ${rect.h}`, rect.x, rect.y + rect.h + 32);

            statusMsg.textContent = 'LOCKED!';
            statusMsg.style.color = '#00FF00';
            video.pause();
            log(`LOCKED: ${rect.label} center=(${rect.cx},${rect.cy}) size=${rect.w}x${rect.h}`);
        }
    }

})();
