// Loading the GLTF loader from CDN so there will be no dependency
// Derived from detector_4.js
// detector.js — Goalpost / Rectangle Detector (v5 — SIMPLIFIED)
// ==============================================================
// ROI-CROPPED, simple geometry checks, no over-engineering
// ==============================================================

    //import * as THREE from "three";
    //import * as THREE from 'https://cdn.jsdelivr.net/npm/three@0.161.0/build/three.module.js';
    //import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader";
    //import { GLTFLoader } from 'https://cdn.jsdelivr.net/npm/three@0.161.0/examples/jsm/loaders/GLTFLoader.js';
    //import { SkeletonHelper } from "three";

    import * as THREE from 'https://esm.sh/three@0.161.0';
    import { GLTFLoader } from 'https://esm.sh/three@0.161.0/examples/jsm/loaders/GLTFLoader';
    //import { DRACOLoader } from 'https://esm.sh/three@0.161.0/examples/jsm/loaders/GLTFLoader';
    

(function () {
    'use strict';

    // === DOM CREATION ===
document.body.style.margin = '0';
document.body.style.overflow = 'hidden';
document.body.style.background = '#000';
document.body.style.fontFamily = 'sans-serif';

    const video = document.getElementById('webcam');
    const statusMsg = document.getElementById('status-msg');
    const scannerOvl = document.getElementById('scanner-overlay');
    const arScene = document.getElementById('ar-scene');
    const gameUI = document.getElementById('game-ui');
    const dbgCanvas = document.getElementById('debug-canvas');
    const dbgCtx = dbgCanvas.getContext('2d');

    //const goalFlash = document.getElementById('goal-Flash');

    let isDetecting = true;
    let cocoModel = null;
    let stabilityCounter = 0;
    let lastRect = null;
    let lastVideoTime = -1;
    const LOCK_TARGET = 15;

    // Debug HUD Top corner debug box
    /*const hud = Object.assign(document.createElement('div'), { id: 'dbg-hud' });
    Object.assign(hud.style, {
        position: 'fixed', top: '4px', right: '4px', zIndex: '99999',
        color: '#0f0', fontFamily: 'monospace', fontSize: '10px', lineHeight: '1.3',
        background: 'rgba(0,0,0,0.7)', padding: '4px 8px', borderRadius: '4px',
        pointerEvents: 'none', whiteSpace: 'pre'
    });
    document.body.appendChild(hud);
    function hudUpdate(obj) {
        hud.textContent = Object.entries(obj).map(([k, v]) => `${k}: ${v}`).join('\n');
    }*/

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
        //statusMsg.textContent = 'Loading AI & OpenCV...';
        statusMsg.textContent = 'Initializing...Please Wait';
        await Promise.all([loadAI(), waitForOpenCV()]);
        while (video.videoWidth === 0) await new Promise(r => setTimeout(r, 50));
        dbgCanvas.width = video.videoWidth;
        dbgCanvas.height = video.videoHeight;
        statusMsg.textContent = 'Point at a rectangular object';
        log(`Boot OK ${video.videoWidth}x${video.videoHeight}`);
        processVideo();
        //dbgCanvas.style.zIndex = '11';
         //renderer.domElement.style.setProperty('z-index', '200000000000', 'important');
    }
    boot();

    let processVideo_id = null;

    // ── Main Loop ────────────────────────────────────────────────
    function processVideo() {
        //renderer.domElement.style.setProperty('z-index', '200000000000', 'important');

        if (!isDetecting) return;
        if (video.readyState < 4) { 
            processVideo_id = requestAnimationFrame(processVideo);
            return; 
        }

        const vw = video.videoWidth, vh = video.videoHeight;
        if (dbgCanvas.width !== vw) { dbgCanvas.width = vw; dbgCanvas.height = vh; }
        dbgCtx.clearRect(0, 0, vw, vh);

        // Draw video
        dbgCtx.drawImage(video, 0, 0, vw, vh);

        // ROI box (landscape band: 90% wide, 16:7 aspect — matches CSS guide)
        const roiW = Math.floor(vw * 0.89);
        //const roiH = Math.floor(roiW * 7 / 16);  // 16:7 aspect ratio
        const roiH = Math.floor(roiW * 6 / 10);  // 10:6 aspect ratio
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

        //requestAnimationFrame(processVideo);
        //processVideo_id = requestAnimationFrame(processVideo);
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
                //const ok = v >= 4 && v <= 8 && fill > 0.3 && solidity > 0.35 && aspect >= 1.2 && aspect <= 3.0;

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
                if (p.score < 0.08) continue;
                //if (p.score < 0.02) continue;
                //if (p.score < 0.4) continue;//original
                const [px, py, pw, ph] = p.bbox;
                const acx = px + pw / 2, acy = py + ph / 2;
                const dist = Math.hypot(acx - pick.cx, acy - pick.cy);
                if (dist < Math.min(pick.w, pick.h) * 0.6) {//0.6
                    pick.label = p.class;
                    pick.source = 'AI+CV';
                    break;
                }
            }
        }

        // If CV found nothing, let AI be an independent source (high confidence only)
        if (!pick && aiPreds.length) {
            // Recompute ROI bounds (same formula as processVideo)
            const _roiW = Math.floor(vw * 0.89);
            const _roiH = Math.floor(_roiW * 6 / 10);
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
        //const top = cvS.info ? cvS.info.slice(0, 4).join(' | ') : '—';
        /*hudUpdate({
            AI: aiInfo,
            CV: `${cvS.total}→${cvS.ok} ok`,
            Det: top,
            Pick: pick ? `${pick.source} [${pick.label}] ${pick.w}x${pick.h}` : '—',
            Lock: `${stabilityCounter}/${LOCK_TARGET}`
        });*/

        if (pick) {
            // Highlight the pick with a bright box
            const c = pick.source.includes('AI') ? '#FF00FF' : '#00FFFF';
            dbgCtx.strokeStyle = c; dbgCtx.lineWidth = 3;
            dbgCtx.strokeRect(pick.x, pick.y, pick.w, pick.h);
            dbgCtx.fillStyle = c; 
            //dbgCtx.font = '12px monospace';
            //dbgCtx.fillText(`${pick.label} [${pick.source}]`, pick.x, pick.y - 3);
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
            // ═══ LOCKED ═══ ==== ==== ==== ==== ==== ==== ==== ==== ==== ==== 

            cancelAnimationFrame(processVideo_id);
            blink_viewfinder();

            isDetecting = false;
            //scannerOvl.style.display = 'none';

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

            goalFlash.style.setProperty('opacity', '1', 'important');
            //goalFlash.style.opacity = '1';
            //goalFlash.style.display = 'block';
            goalFlash.style.setProperty('display', 'block', 'important');
            //goalFlash.style.position = 'absolute';
            goalFlash.style.setProperty('position', 'absolute', 'important');
            //goalFlash.style.textShadow = '0 0 20px #000000, 0 0 40px #ff6600';
            goalFlash.style.setProperty('textShadow', '0 0 20px #000000, 0 0 40px #ff6600', 'important');


            //goalFlash.style.fontSize = '20px';
            //goalFlash.style.fontSize = '1.2em';
            goalFlash.style.setProperty('fontSize', '1.2em', 'important');
            //goalFlash.style.color = "#ffcc00";//copy_color;
            goalFlash.style.setProperty('color', '#ffcc00', 'important');
            goalFlash.innerText = "IT LOOKS LIKE A GOAL!";
                //goalFlash.style.left = `${rect.cx+(rect.w-rect.w)}px`; ignore
                //goalFlash.style.top = `${rect.cy+rect.h/2}px`; ignore

             //goalFlash.style.left = `${video.videoWidth/2}px`;
             goalFlash.style.setProperty('left', '${video.videoWidth/2}px', 'important');
             //goalFlash.style.top = `${(video.videoHeight-rect.y)+rect.h}px`;
             goalFlash.style.setProperty('top', '${(video.videoHeight-rect.y)+rect.h}px', 'important');
            
            //goalFlash.style.transform = 'translate(-50%, -50%)';
             //goalFlash.style.setProperty('transform', 'translate(-50%, -50%)', 'important');
            //goalFlash.style.textAlign = 'center';
            goalFlash.style.setProperty('textAlign', 'center', 'important');

            // Labels
            /*dbgCtx.fillStyle = '#00FF00'; dbgCtx.font = 'bold 16px monospace';
            dbgCtx.fillText(`LOCKED [${rect.label}]`, rect.x, rect.y - 8);
            dbgCtx.font = '14px monospace';
            dbgCtx.fillText(`Center: (${rect.cx}, ${rect.cy})`, rect.x, rect.y + rect.h + 16);
            dbgCtx.fillText(`Size: ${rect.w} x ${rect.h}`, rect.x, rect.y + rect.h + 32);*/

            statusMsg.textContent = 'LOCKED!';
            statusMsg.style.color = '#00FF00';
            video.pause();
            log(`LOCKED: ${rect.label} center=(${rect.cx},${rect.cy}) size=${rect.w}x${rect.h}`);
        }
    }

    //-- blink viewfinder
    let running = true;
    let flashVisible = true;

    let scanning = true;
    let blink_viewfinder_id = null;
    let viewfinder_flash_count = 0;
    let total_viewfinder_flash_count = 0;

    let target_centerX = 0;
    let target_centerY = 0;

    function blink_viewfinder(){

          if (!running) return;

          //console.log("blink_viewfinder");

        if (viewfinder_flash_count > 15) {

          if(flashVisible){


            dbgCanvas.style.display = "block";
            

          }else{
             dbgCanvas.style.display = "none";
            
          }
          flashVisible = !flashVisible;
          viewfinder_flash_count = 0;

          //console.log("viewfinder_flash_count = "+ viewfinder_flash_count + " ---- total_viewfinder_flash_count = " + total_viewfinder_flash_count);
          total_viewfinder_flash_count ++;
          if(total_viewfinder_flash_count > 10){
            total_viewfinder_flash_count = 0;
            
            console.log("blink_viewfinder finish");
            dbgCtx.clearRect(0, 0, video.videoWidth, video.videoHeight);
            goalFlash.innerText = "";

            //animate_game_container();
            running = false;
            cancelAnimationFrame(blink_viewfinder_id);

            //gameWorld.scale.set(0.5,0.5,0.5);
            gameWorld.scale.set(0.02,0.02,0.02);
            //gameWorld.position.set(0,0,8);
            gameWorld.position.set(0,2.5,80);


            animate();

            
            timerEl.style.display = 'block';
            
            animate_game_container();
            gameWorld.visible = true;
            
          }
                
        }
        viewfinder_flash_count++;

          blink_viewfinder_id = requestAnimationFrame(blink_viewfinder);
    }

    let vec = new THREE.Vector3();
    let animate_game_container_id = null;
    function animate_game_container(){

            //console.log("animate_game_container is called");
            //vec.x=0;
            //vec.y=0.5;
            //const vv = new THREE.Vector3(0,-0.05,1.8);
            //const vv = new THREE.Vector3(0,-0.3,1.5).unproject(camera);
            //gameWorld.position.set(0,-0.3,-2);
            //const sc = new THREE.Vector3(.015,.015,.015);
            //const sc = new THREE.Vector3(1,1,1);
            const sc = new THREE.Vector3(2.8,2.8,2.8);

            //vec.x = 0;
            //vec.y = 0;//1.5;
            //vec.z = 0;//-8;// reduce the z to take the gameworld towards the screen

            //vec.x = 0;
            //vec.y = 0.8;//0.6;//1.5;
            //vec.z = -1;//-8;// reduce the z to take the gameworld towards the screen

            vec.x = 0;
            vec.y = 0.8;//0.6;//1.5;
            vec.z = 2;//-8;// reduce the z to take the gameworld towards the screen

                                 
          

            //gameWorld.position.set(0,0.6,-1);


            //vec.unproject(camera);
            gameWorld.position.lerp(vec, 0.15); // micro smoothing
            gameWorld.scale.lerp(sc, 0.09); // micro smoothing

            const scl = gameWorld.scale.x;
            //animate_game_container_id = requestAnimationFrame(animate_game_container);
            //console.log(scl);
          if(scl < 2.79){
            //console.log(scl);
            animate_game_container_id = requestAnimationFrame(animate_game_container);
          }else{
            //ctx.clearRect(0, 0, canvas.width, canvas.height);
            //console.log("animate_game_container killed = ");
            //gameWorld.position.set(0,0,0);
            //gameWorld.scale.set(1, 1, 1);
            gameWorld.scale.set(2.8,2.8,2.8);
            //gameWorld.position.set(0,0.8,-1);
            gameWorld.position.set(0 ,0.8, 2.0);
            //ctx_1.clearRect(0, 0, canvas.width, canvas.height);
            console.log("scaling animation completed");
            scannerOvl.style.display = 'none';
            //ground.visible = true;
            //ball.visible = true;
            updateTimer();
            showScorePanel();
            interval = setInterval(updateTimer, 1000);
            ready_to_shoot = true;
            grabber_hand_anim(ball.position,ball.rotation.y);
            cancelAnimationFrame(animate_game_container_id);
          }


  }

    //----- Create the "GOAL!" flash element
/*
    const goalFlash = document.createElement('div');
    goalFlash.innerText = "";
    goalFlash.style.position = 'absolute';
    //goalFlash.style.position = 'fixed';
    goalFlash.style.top = '45%';
    goalFlash.style.left = '50%';
    goalFlash.style.transform = 'translate(-50%, -50%)';
    //goalFlash.style.fontSize = '100px';
    goalFlash.style.color = '#ff8c00';
    goalFlash.style.padding = '10px 20px';
    goalFlash.style.borderRadius = '12px';
    goalFlash.style.userSelect = 'none';
    goalFlash.style.opacity = '0';
    goalFlash.style.pointerEvents = 'none';
    //goalFlash.style.transition = 'opacity 0.4s ease-out';
    goalFlash.style.zIndex = '9997';
    goalFlash.style.display = 'none';
    //goalFlash.style.fontSize = 'clamp(4rem, 5vw, 3rem)';
    goalFlash.style.fontSize = 'clamp(2rem, 3vw, 2rem)';
    goalFlash.style.fontWeight = '400';//ff
    goalFlash.style.fontFamily ='sans-serif', 'system-ui';//'sans-serif';
    goalFlash.style.whiteSpace = 'normal';   // allow wrapping
    //goalFlash.style.wordWrap = 'break-word'; // break long words if needed
    //goalFlash.style.maxWidth = '90vw';       // limit width to 90% of viewport
    goalFlash.style.maxWidth = '90vw';  
    goalFlash.style.textAlign = 'center';    // optional — center text nicely

    document.body.appendChild(goalFlash);
*/
//----------------------------------------------




// game.js




const break_count = 10000;

let scene, camera, renderer;

let ball, goalkeeper, goalpost, ground;
let currentForce = 0;
let currentAngle = 0;
let currentSwing = 0;  // from ‑1 to +1
const angleMin = THREE.MathUtils.degToRad(-45);
const angleMax = THREE.MathUtils.degToRad(45);

let angleDirection = 1;
const angleSpeed = 1;//1.5; // radians/sec

const clock = new THREE.Clock();
let ballInFlight = false;
let velocity = new THREE.Vector3();

const raycaster = new THREE.Raycaster();
const mouse = new THREE.Vector2();
let isDragging = false;
let dragStart = { x: 0, y: 0 };
let ballSelected = false;

// For goalkeeper animation
let keeperMixer = null;
let keeperActions = {
    idle: null,
    diveLeft: null,
    diveRight: null
};
let keeperCurrentAction = null;
let trajectoryLine = null;


// Ball collision box (reused every frame)
let ballBox = new THREE.Box3();

// Array to store static goal posts
let goalPosts = [];

// Array to store bounding boxes of each post
let postBoxes = [];


  let postMat;
  let crossbar;
  let leftPost;
  let rightPost;

  // Store globally
let ballMesh = null;
let ballBaseRadius = 0;
let ballRadius = 0;

let hitSpheres = [];

let hit_Flag = false;
let goli_hit_Flag = false;
let isGoal = false;
let net_hit_Flag = false;


let net_hit_board;
let net_hit_boardBox;

let score = 0;


let ball_Materials = [];
let goli_Materials = [];

//------

// === DOM CREATION ===
document.body.style.margin = '0';
document.body.style.overflow = 'hidden';
document.body.style.background = '#000';
document.body.style.fontFamily = 'sans-serif';


//----- Load Font
/*
const link = document.createElement('link');
link.rel = 'stylesheet';
//link.href ="https://fonts.googleapis.com/css2?family=Roboto:ital,wght@0,100..900;1,100..900&display=swap";
//link.href = "https://fonts.googleapis.com/css2?family=Montserrat:ital,wght@0,100..900;1,100..900&display=swap";
link.href = "https://fonts.googleapis.com/css2?family=Cherry+Bomb+One&display=swap";

document.head.appendChild(link);*/



// Call this once after loading the GLTF ball


function setupBallFromGroup(ballGroup) {
  if (!ballGroup) {
    console.error("Ball group is null or undefined!");
    return null;
  }

  // Debug: log all children
  /*console.log("Traversing ball group hierarchy:");
  ballGroup.traverse((child) => {
    console.log(child.type, child.name);
  });*/

  // Find the first Mesh or SkinnedMesh
  let ballMesh = null;
  ballGroup.traverse((child) => {
    if ((child.isMesh || child.isSkinnedMesh) && !ballMesh) {
      ballMesh = child;
    }
    if (child.isMesh && child.material) {
          const mats = Array.isArray(child.material) ? child.material : [child.material];
          mats.forEach(mat => {

              mat.transparent = true;
              
              //mat.doubleSided = false;

              //mat.depthTest = flashScore;
              //mat.depthWrite = false;
              //mat.opacity = 0.5;
              ball_Materials.push(mat);

              //console.log("mat.name == "+ mat.name);


          });
      }

  });



  if (!ballMesh) {
    console.error("No mesh found inside the ball group!");
    return null;
  }

  // Compute bounding sphere if not present
  if (!ballMesh.geometry.boundingSphere) {
    ballMesh.geometry.computeBoundingSphere();
  }

  const ballBaseRadius = ballMesh.geometry.boundingSphere.radius;
  //console.log("✅ ballBaseRadius =", ballBaseRadius);

  // Get world position
  const ballWorldPos = new THREE.Vector3();
  ballMesh.getWorldPosition(ballWorldPos);
  //console.log("✅ ballWorldPos =", ballWorldPos);

  // Account for scale if the model
  //If your ball mesh has been scaled (e.g., ball.scale.set(2, 2, 2)), you must include that:
  const worldScale = new THREE.Vector3();
  ballMesh.getWorldScale(worldScale);

   ballRadius = ballBaseRadius * Math.max(worldScale.x, worldScale.y, worldScale.z);
  //console.log("Scaled radius:", ballRadius);

  ball_init_WorldPos = ballWorldPos;
  //console.log(ballWorldPos.x, ballWorldPos.y,ballWorldPos.z);
  //console.log(ballWorldPos.x, ballWorldPos.y,ballWorldPos.z);
  // Return useful info
  return {
    mesh: ballMesh,
    radius: ballBaseRadius,
    worldPos: ballWorldPos
  };

}
let ball_init_WorldPos = new THREE.Vector3();


// Score UI
const scoreUI = document.createElement('div');
scoreUI.id = 'scoreUI';
Object.assign(scoreUI.style, {
  position: 'absolute',
  top: '10px',
  left: '10px',
  color: 'white',
  background: 'rgba(0, 0, 0, 0.6)',
  padding: '10px',
  zIndex: 10,
});
scoreUI.innerHTML = 'Score: <span id="score">0</span>';
document.body.appendChild(scoreUI);
const scoreDisplay = document.getElementById('score');

scoreUI.style.display = 'none';

//Flash or Animate on Score Change

// flash it 3 times

function flashScore(times = 3, interval = 200) {
  for (let i = 0; i < times; i++) {
    setTimeout(() => {
      scoreUI.style.background = 'rgba(255, 215, 0, 0.8)'; // bright flash
    }, i * interval * 2); // ON

    setTimeout(() => {
      scoreUI.style.background = 'rgba(0, 0, 0, 0.6)'; // normal
    }, i * interval * 2 + interval); // OFF
  }
}


//-------




let modelsArr = [];//---store loaded models mesh
let myGroup = [];

let modelLinks = [
    
//'https://user.cdn.mywebar.com/521765/782426/cr7_goalkeeper_diving_save.glb',
'https://user.cdn.mywebar.com/521765/goli_output_512.glb',
'https://user.cdn.mywebar.com/521765/782426/3d_model_of_soccer__football_goal_post.glb',
'https://user.cdn.mywebar.com/521765/782426/polyfield_strikers__football_raw.glb',
//'https://user.cdn.mywebar.com/521765/782665/grass.glb',
'https://user.cdn.mywebar.com/521765/grass_2.glb',
];



let modelsPosition = [

  [0, 0, 9.129], // goli
  [0, 0, 11], // goal post
  [0, 0.4, -1.2], // ball
  [0, 0, 5], // grass field
];

let modelsRotation = [

  [0, 180, 0], // goli
  [0, 180, 0], // goal post
  [0, 0, 0], // ball
  [0, 0, 0], // grass field
];

let modelsScale = [

  [0.7, 0.7, 0.7],// goli
  [1.5, 1.5, 1.5], // goal post
  [0.3,0.3,0.3], // ball
  [3, 1, 3.6], // grass field

];

let model_, group, loader_img, myModel, modelPromise, animationId_1;

//------

let clip = null;
let action = null;
const frameRate = 30;
    // Define your animation ranges here:
let goli_mov_speed = 0.01;

let main_anim_Id = null;



//const dive_move_speed = [0.4];

var keeperTargetX = 0;    // where the keeper should move to


  // You can choose which animations should lead to crouch_left
  const goToIdleAfter = [
    "save_upper_left",
    "save_upper_right",
    "save_upper_center",
    "save_lower_left",
    "save_lower_right",
    "save_lower_center",
    "punt",
    "throw_ball",
    "roll"
  ];



function makeSubclip(baseClip, name, start, end) {

    
   subClip = THREE.AnimationUtils.subclip(baseClip, name, start, end);
  var shift = subClip.tracks[0].times[0];
  for (var i = 0; i < subClip.tracks.length; i++) {
    var t = subClip.tracks[i];
    for (var j = 0; j < t.times.length; j++) {
      t.times[j] -= shift;
    }
  }
  return subClip;
    

}

//

var idleIndex = 0;     // 0 = left, 1 = right
var idlePlaying = false;
//var action = null;
//var clip = null;
//var keeperMixer = null;
let loop_anim_setTimeout = null;

function playIdleLoop() {
  animation_speed = speedSlow;
  idlePlaying = true;
  playNextIdle();
 
}

function playNextIdle() {
    

    var name = (idleIndex === 0 ? "crouch_left" : "crouch_right");
  //var name = (idleIndex === 0 ? "crouch_right" : "crouch_left");
  idleIndex = 1 - idleIndex;

  var range = animRanges[name];
  var start = range[0];
  var end = range[1];

      if (action) {
        action.stop();
        keeperMixer.uncacheAction(action.getClip());
      }

  // ---- X movement for idle animations ----
  keeperTargetX = diveDistance[name] || 0;
  

  // if name contains "_left", invert direction
  //if (name.indexOf("_left") !== -1) {
    //keeperTargetX = -keeperTargetX;
  //}

  // ----------------------------------------

     subClip = makeSubclip(clip, name, start, end);
      action = keeperMixer.clipAction(subClip);
      action.reset();
      action.setLoop(THREE.LoopOnce);
      action.clampWhenFinished = true;

      //action.play();
      if(name ==="crouch_left"){
        clearTimeout(loop_anim_setTimeout);
        loop_anim_setTimeout = setTimeout(() => {
          if(idlePlaying){
            playNextIdle();
          }
        }, 1000); 
      }else{
        action.play();
      }
  
}


  var subClip = null;
function playSegment(name) {

    
  
  idlePlaying = false;   // stop idle loop while playing big animation

  if (action) {
    action.stop();
    keeperMixer.uncacheAction(action.getClip());
  }

  var range = animRanges[name];
  if (!range) {
    //console.log("Unknown animation:", name);
    return;
  }

  // movement distance
  if (diveDistance[name] !== undefined) {
    keeperTargetX = diveDistance[name];
    goli_mov_speed = 0.02;//0.08;
    // invert distance for left side
    //if (name.indexOf("_left") !== -1) {
      //keeperTargetX = -keeperTargetX;
    //}
  } else {
    keeperTargetX = 0;
    
  }
  //console.log("************" + clip);
  //console.log("************" + name);
//console.log(clip, name, range[0], range[1]);
  subClip = makeSubclip(clip, name, range[0], range[1]);
  action = keeperMixer.clipAction(subClip);
  action.reset();
  action.setLoop(THREE.LoopOnce);
  action.clampWhenFinished = true;

  action.play();

  //console.log("▶️ Playing segment:", name);
   //console.log("************************" + subClip.name);
  
}


function updateBoneSpheres(boneSpheres, armatureRoot) {
    armatureRoot.updateWorldMatrix(true, false);

    for (const { bone, sphere } of boneSpheres) {
        bone.updateWorldMatrix(true, false);

        // Correct world transform
        sphere.matrix.copy(armatureRoot.matrixWorld).multiply(bone.matrixWorld);

        // Remove bone scaling
        const pos = new THREE.Vector3();
        const rot = new THREE.Quaternion();

        sphere.matrix.decompose(pos, rot, new THREE.Vector3());

        sphere.matrix.compose(pos, rot, new THREE.Vector3(1,1,1));
    }
}

let gameWorld;



scene = new THREE.Scene();
          //scene.background = new THREE.Color(0x87ceeb);


          scene = new THREE.Scene();
          //scene.background = new THREE.Color(0x87ceeb);

          gameWorld = new THREE.Group();
          scene.add(gameWorld);
          scannerOvl.style.display = 'none';//
        //gw show gameworld
          //gameWorld.visible = false;
          //gameWorld.scale.set(0.02,0.02,0.02);
          //gameWorld.position.set(0,2.5,8);

          //gameWorld.position.set(0,2.0,-1.5); //gw postion to get it in the scanner box outline
          gameWorld.position.set(0 ,0.5, 2.3);//gameWorld.position.set(0 ,1, =2.0)

          gameWorld.scale.set(2.8,2.8,2.8);

          //console.log(window.innerWidth / window.innerHeight);
          const screen_ratio = window.innerWidth / window.innerHeight;
          camera = new THREE.PerspectiveCamera(64+screen_ratio*2, window.innerWidth / window.innerHeight, 0.1, 1000);
          camera.position.set(0, 3.7, -8+screen_ratio);
          //camera.position.set(0, 0, 0);
          //camera.lookAt(0, 3, 5);

          //camera.lookAt(0, -2, 8);        // aim towards goal
          camera.lookAt(0, 1.9-screen_ratio*2, 20);      //for style_4.css avweage viewfinder aspect-ratio: 10 / 6;

            //camera.lookAt(0, 1.0, 25);   //for style_3.css bigger viewfinder aspect-ratio: 16 / 7;
          //camera.fov = 34;//34


          renderer = new THREE.WebGLRenderer({ antialias: true,  alpha:true });
          renderer.setSize(window.innerWidth, window.innerHeight);

           renderer.domElement.style.setProperty('position', 'fixed', 'important');
           renderer.domElement.style.setProperty('top', '0', 'important');
           renderer.domElement.style.setProperty('left', '0', 'important');

          renderer.domElement.style.setProperty('z-index', '2000', 'important');

          renderer.shadowMap.enabled = true;
          renderer.shadowMap.type = THREE.PCFSoftShadowMap;
          document.body.appendChild(renderer.domElement);
          //renderer.domElement.style.zIndex = '100000';  
          //renderer.domElement.style.setProperty('z-index', '200000000000', 'important');
          //renderer.style.zIndex = '200000000';


          // Lighting

          const hemiLight = new THREE.HemisphereLight(0xFFFFFF, 0x444444, 5);
          hemiLight.position.set(0, 10, 0);
          scene.add(hemiLight);

          /*const hemiLight = new THREE.HemisphereLight( 0xffffff, 0x8d8d8d, 3 );
                hemiLight.position.set( 0, 20, 0 );
                scene.add( hemiLight );*/





                const dirLight = new THREE.DirectionalLight( 0xffffff, 5);
                //dirLight.position.set( - 2, 5, - 3 );
                dirLight.position.set( - 2, 5, - 15 );
                dirLight.castShadow = true;
                 scene.add(dirLight);

                  /*const dirLight = new THREE.DirectionalLight(0xffffff, 1);
                  dirLight.position.set(0, 2, 0);
                  dirLight.castShadow = true;
                  scene.add(dirLight);*/
                
                /*const cam = dirLight.shadow.camera;
                cam.top = cam.right = 2;
                cam.bottom = cam.left = - 2;
                cam.near = 3;
                cam.far = 8;
                dirLight.shadow.mapSize.set( 1024, 1024 );*/
                //followGroup.add( dirLight );
                //followGroup.add( dirLight.target );
                //scene.add(dirLight);

                  /*const dirLight_1 = new THREE.DirectionalLight(0xffffff, 3);
                  dirLight_1.position.set(2, -5, -1);
                  dirLight_1.castShadow = true;
                  scene.add(dirLight_1);*/



                /*const dirLight = new THREE.DirectionalLight( 0xffffff, 3 );
                dirLight.position.set( 3, 10, 10 );
                dirLight.castShadow = true;
                dirLight.shadow.camera.top = 2;
                dirLight.shadow.camera.bottom = - 2;
                dirLight.shadow.camera.left = - 2;
                dirLight.shadow.camera.right = 2;
                dirLight.shadow.camera.near = 0.1;
                dirLight.shadow.camera.far = 40;
                scene.add( dirLight );*/

                /*const dirLight = new THREE.DirectionalLight(0xffffff, 1.5);
dirLight.position.set(5, 15, 5);
dirLight.castShadow = true;

dirLight.shadow.mapSize.set(2048, 2048);

dirLight.shadow.camera.near = 0.1;
dirLight.shadow.camera.far = 50;

dirLight.shadow.camera.left = -30;
dirLight.shadow.camera.right = 30;
dirLight.shadow.camera.top = 30;
dirLight.shadow.camera.bottom = -30;

dirLight.shadow.bias = -0.0005;

scene.add(dirLight);*/

//-----------------------------------------
function init_1(){

    //console.log(Object.keys(THREE));

    //loader_img = scene.getObjectByName("Loading_Image");

    modelsArr = [];

            //loader_img.visible = false;

            //yg
            const loader = new GLTFLoader();
            
            loader.load('./goli_purple.glb', gltf => {
            //loader.load('./goli_lenovo.glb', gltf => {
            //loader.load('./new_export/player.glb', gltf => {
                //loader.load('./goli_output_512.glb', gltf => {
                /*const { mesh, animations } = gltf.scene;

                    // Don't mutate mesh directly
                    const wrappedModel = {
                      mesh,
                      animations
                    };*/

                goalkeeper = gltf.scene;
                //scene.add(goalkeeper);
                gameWorld.add(goalkeeper);

                 goalkeeper.position.set(0, 0, 9.129);
                 //goalkeeper.position.set(0, 0, 2);
                // maybe scale if needed
                goalkeeper.scale.set(1.6, 1.6, 1.6);
                goalkeeper.rotation.set(0, 91, 0);
                //goalkeeper.rotation.set(0, 0, 0);
                clip = gltf.animations[0];

            //}, undefined, error => {
             // console.error('Error loading goalkeeper model:', error);
            //});

            keeperMixer = new THREE.AnimationMixer(goalkeeper);
            //keeperMixer.clipAction( goalkeeper.animations[ 0 ] ).play();

            //const action = keeperMixer.clipAction(gltf.animations[0]);

            // Set to loop 5 times then stop
            //action.setLoop(THREE.LoopRepeat, 500); 

            // Or set to loop forever (default)
            //action.loop = THREE.LoopRepeat;
            //action.repetitions = Infinity;

            //action.play();

            //keeperMixer.addEventListener("finished", onAnimationFinished);

            //function onAnimationFinished(){
                //keeperMixer.clipAction( goalkeeper.animations[ 0 ] ).play();

            //}
            //clip = gltf.animations[0];
            //console.log("clip -" + goalkeeper.animations[ 0 ]);


        //console.log("clip -----" + gltf.animations[0]);


            //const animations = gltf.animations;
            //console.log("animations[0] = " + animations[0]);
            //keeperMixer.clipAction(animations[0]).play();//---------------------------pay the animation for testing




            

        /* 
        //log object data
        Object.entries(gltf.animations[0]).forEach(([key, value]) => {
            console.log(`Key: ${key}, Value:`, value);
        });*/

        //Object.entries(goalkeeper).forEach(([key, value]) => {
            //console.log(`Key: ${key}, Value:`, value);
        //});

        keeperMixer.addEventListener("finished", function () {

          if (idlePlaying) {
            // We are inside the crouch loop → go to next crouch animation

            playNextIdle();
            
            return;
          }
          
            //goli_mov_speed = 0.01;
            //fade_goli_out();

          // We just finished a gameplay animation → start idle loop
          //playIdleLoop();
          //goalkeeper.mesh.visible = false;
        });

         playIdleLoop();

    //playSegment("save_lower_left");
    //playSegment("crouch_left");

    // call the goli animation loop
    //playIdleLoop();


    //playSegment("save_upper_left");
    //playSegment("save_upper_left");

    /*gltf.animations.forEach(clip => {
      console.log("animation name = "+ clip.name);
    });*/

    const sp_size_1 = 2;
    const sp_size_2 = 10;
    function createHitSphere(radius, bone) {



      //console.log("createHitSphere is called");
      //radius = 3;//0.7;
      /*if(bone.name == "Bip001_L_Toe0"){
        radius = 0.3; 

      }*/
      const sphereMesh = new THREE.Mesh(
        //new THREE.SphereGeometry(radius*0.3, 8, 8),
         new THREE.SphereGeometry(radius, 8, 8),
        //new THREE.MeshBasicMaterial({ visible: true, wireframe: true }) // invisible in final game
        new THREE.MeshBasicMaterial({ visible: false }) // invisible in final game
      );
      bone.add(sphereMesh); // attach to bone
      sphereMesh.position.set(0, 0, 0); // center on the bone
      //console.log(bone);
      

      return { mesh: sphereMesh, radius }; // store radius for collision
    }

    goalkeeper.traverse((obj) => {

         //Object.entries(obj.children).forEach(([key, value]) => {
            //console.log(`Key: ${key}, Value:`, value);
        //});



        //console.log("---->"+obj.skeleton.bones);
        //console.log("-------- >"+obj[0]);


        if (obj.isMesh && obj.material) {
            //console.log("aaa");
          const mats = Array.isArray(obj.material) ? obj.material : [obj.material];
          mats.forEach(mat => {

            mat.castShadow = true;
            mat.receiveShadow = true;

              //mat.color.set(0xf26921);
              mat.transparent = true;
              //mat.opacity = 0.5;
              goli_Materials.push(mat);

              //console.log("mat.name == "+ mat.name);


          });
        }
        if (obj.isBone) {
            //console.log('Bone found:', obj.name);
            //console.log(obj);
            
            if(obj.name == "Bone_Brow_C"){
                hitSpheres.push(createHitSphere(9, obj));
            }
            if(obj.name == "neck_01"){
                hitSpheres.push(createHitSphere(10, obj));
            }
            if(obj.name == "spine_01"){
                //hitSpheres.push(createHitSphere(15, obj));
            }
            if(obj.name == "spine_02"){
                hitSpheres.push(createHitSphere(15, obj));//stomach
            }
            if(obj.name == "spine_03"){
                hitSpheres.push(createHitSphere(18, obj));//chest
            }
            if(obj.name == "Pelvis"){
                //hitSpheres.push(createHitSphere(15, obj));
            }
            if(obj.name == "middle_01_l"){
                hitSpheres.push(createHitSphere(9, obj));//palm
            }
            if(obj.name == "middle_01_r"){
                hitSpheres.push(createHitSphere(9, obj));
            }
            if(obj.name == "Hand_L"){
                hitSpheres.push(createHitSphere(8, obj));//wrist
            }
            if(obj.name == "Hand_R"){
                hitSpheres.push(createHitSphere(8, obj));
            }
            if(obj.name == "lowerarm_l"){
                hitSpheres.push(createHitSphere(8, obj));//elbow
            }
            if(obj.name == "lowerarm_r"){
                hitSpheres.push(createHitSphere(8, obj));
            }
            if(obj.name == "UpperArm_L"){
                hitSpheres.push(createHitSphere(10, obj));//UpperArm_L
            }
            if(obj.name == "UpperArm_R"){
                hitSpheres.push(createHitSphere(10, obj));
            }
            if(obj.name == "Foot_L"){
                hitSpheres.push(createHitSphere(8, obj));//Foot_L
            }
            if(obj.name == "Foot_R"){
                hitSpheres.push(createHitSphere(8, obj));
            }
            if(obj.name == "Thigh_L"){
                hitSpheres.push(createHitSphere(10, obj));//Knee
            }
            if(obj.name == "Thigh_R"){
                hitSpheres.push(createHitSphere(10, obj));
            }
            if(obj.name == "calf_twist_01_l_end"){
                //hitSpheres.push(createHitSphere(6, obj));//foot joint L
            }
            if(obj.name == "calf_twist_01_r_end"){
                //hitSpheres.push(createHitSphere(6, obj));
            }
            if(obj.name == "calf_twist_01_l"){
                hitSpheres.push(createHitSphere(10, obj));//Calf means foot joint or shose
            }
            if(obj.name == "calf_twist_01_r"){
                hitSpheres.push(createHitSphere(10, obj));
            }
            

        }
    });

    }, undefined, error => {
        console.error('Error loading goalkeeper model:', error);
    });




  //---
  // Goalpost model

    
    const loader_goalpost = new GLTFLoader();
    loader_goalpost.load('./3d_model_of_soccer__football_goal_post.glb', gltf => {
    goalpost = gltf.scene;
    //scene.add(goalpost);
    gameWorld.add(goalpost);
    goalpost.position.set(0, 0, 11);
    // maybe scale if needed
    goalpost.scale.set(1.5, 1.5, 1.5);
    //goalpost.rotation.set(0, 180, 0);//(0, -110, 0);
    goalpost.rotation.set(0, -110, 0);




    goalpost.traverse(child => {
      if (child.isMesh && child.material) {
          const mats = Array.isArray(child.material) ? child.material : [child.material];
          mats.forEach(mat => {


            mat.castShadow = true;
            mat.receiveShadow = true;

            //mat.transparent = true;
              //mat.opacity = 0.5;
              //ball_Materials.push(mat);



              //console.log("mat.name == "+ mat.name);
          });
      }
    });

    

  }, undefined, error => {
    console.error('Error loading goalkeeper model:', error);
  });


      // Football model


  const loader_ball = new GLTFLoader();
  loader_ball.load('./black_football.glb', gltf => {
    ball = gltf.scene;
    //scene.add(ball);
    gameWorld.add(ball);
    //ball.position.set(0, 0.4, -1.2);//original pos
    //ball.position.set(0, 0.4, -0.1);//original pos later
    ball.position.set(0, 0.4, -1.7);
    //ball.position.set(0, 0.1, -1.2);
    // maybe scale if needed
    //ball.scale.set(0.3,0.3,0.3);
    //ball.scale.set(0.1,0.1,0.1);
    ball.scale.set(ball_initial_scale, ball_initial_scale, ball_initial_scale);
    ball.rotation.set(0, 0, 0);
    
   setupBallFromGroup(ball);

    ball.traverse(child => {
      if (child.isMesh && child.material) {
          const mats = Array.isArray(child.material) ? child.material : [child.material];
          mats.forEach(mat => {

            mat.castShadow = true;
            mat.receiveShadow = true;

              mat.transparent = true;
              //mat.opacity = 0.5;
              ball_Materials.push(mat);



              //console.log("mat.name == "+ mat.name);
          });
      }
    });
    ball.updateMatrixWorld(true);

  }, undefined, error => {
    console.error('Error loading ball model:', error);
  });

    


  postMat = new THREE.MeshStandardMaterial({ visible: false, color: 0xfff000, transparent: true });
  //postMat.opacity = 0.2;

  // Crossbar
  crossbar = new THREE.Mesh(new THREE.BoxGeometry(7.2, 0.1, 0.1), postMat);
  crossbar.position.set(0, 3, 9.7);
  crossbar.name = 'crossbar';
  //scene.add(crossbar);
  gameWorld.add(crossbar);
  goalPosts.push(crossbar);
  postBoxes.push(new THREE.Box3().setFromObject(crossbar));

  // Left Post
  leftPost = new THREE.Mesh(new THREE.BoxGeometry(0.1, 4, 0.1), postMat);
  leftPost.position.set(3.6, 1, 10);//x=3.8
  leftPost.name = 'leftPost';
  //scene.add(leftPost);
  gameWorld.add(leftPost);
  goalPosts.push(leftPost);
  postBoxes.push(new THREE.Box3().setFromObject(leftPost));

  // Right Post
  rightPost = new THREE.Mesh(new THREE.BoxGeometry(0.1, 4, 0.1), postMat);
  rightPost.position.set(-3.6, 1, 10);
  rightPost.name = 'rightPost';
  //scene.add(rightPost);
  gameWorld.add(rightPost);
  goalPosts.push(rightPost);
  postBoxes.push(new THREE.Box3().setFromObject(rightPost));

  net_hit_board = new THREE.Mesh(
    //new THREE.BoxGeometry(7.2, 2.45, 0.1),
    new THREE.BoxGeometry(7.2, 2.8, 0.1),
    new THREE.MeshStandardMaterial({ visible: false, color: 0xff0000, transparent: true})// side: THREE.DoubleSide 
  );
  
  //net_hit_board.position.set(0, 1.6, 10.8);
  net_hit_board.position.set(0, 1.5, 11.5);
  //net_hit_board.material.opacity = 0;
  //hit test bounding box
  net_hit_boardBox = new THREE.Box3().setFromObject(net_hit_board);

  //scene.add(net_hit_board);
  gameWorld.add(net_hit_board);
  net_hit_board.name = 'net';
  goalPosts.push(net_hit_board);
  postBoxes.push(new THREE.Box3().setFromObject(net_hit_board));

  //ball.updateMatrixWorld(true);
  for(let i=0; i<goalPosts.length; i++){
      goalPosts[i].updateMatrixWorld(true);
      postBoxes[i].setFromObject(goalPosts[i]);
    }

//-------


    const loader_ground = new GLTFLoader();
    //loader_ground.load("./grass_2.glb", gltf => {
    loader_ground.load("./grass_dummy.glb", gltf => {
      ground = gltf.scene;
      //ground.scale.set(0.6, 0.6, 0.6);
      ground.scale.set(3, 1, 3.6);
      ground.position.set(0, 0, 5);
      //ground.visible = false;
      //scene.add(ground);

      gameWorld.add(ground);

        ground.traverse(child => {
        //console.log("==="+child.type, child.name);
          if (child.isMesh && child.material) {
              const mats = Array.isArray(child.material) ? child.material : [child.material];
              mats.forEach(mat => {
                
                mat.castShadow = true;
                mat.receiveShadow = true;
                mat.transparent = true;
                  //mat.opacity = 0.5;
                  //mat.depthTest = false;
                  //mat.depthWrite = false;
                  //ball_Materials.push(mat);

                  //console.log("mat.name == "+ mat.name);


              });
          }
        });
    });

  // Shadow catcher
  const shadowPlane = new THREE.Mesh(
    new THREE.PlaneGeometry(20,20),
   // new THREE.ShadowMaterial({ opacity:0.9})
    //new THREE.MeshStandardMaterial({ visible: true, color: 0xff0000, transparent: true, doubleSided: true})
    new THREE.MeshPhongMaterial( { color: 0xcbcbcb, depthWrite: false } )
    //new THREE.Mesh( new THREE.PlaneGeometry( 100, 100 ), new THREE.MeshPhongMaterial( { color: 0xcbcbcb, depthWrite: false } ) )
  );
  shadowPlane.rotation.x = -Math.PI/2;
   shadowPlane.position.y = 0.01;
  shadowPlane.position.z = 5;
  shadowPlane.receiveShadow = true;
  //shadowPlane.position.set(0,1,0);
  //gameWorld.add(shadowPlane);
  //scene.add(shadowPlane);




 
 
  //ground_1.scale.set(3, 1, 3.6);
  
  scene.add(hand_grabber_Mesh);

  //uncomment this to skip the countdown for testing
  //grabber_hand_anim(ball.position,ball.rotation.y);
  countDown_finished = true;
  ready_to_shoot = true;







  
//scannerOvl.style.display = 'none';
  //main_anim_Id = requestAnimationFrame(animate);
  // to run the game from the sesting
  animate();




}// ----------------------------- init ends here --------------------------------------

// ---- Timer

let totalSeconds = 60;
  const timerEl = document.getElementById("timer");
  //timerEl.style.display = 'none';

  function updateTimer() {
    //let minutes = Math.floor(totalSeconds / 60);
    let minutes = 0;
    let seconds = totalSeconds % 60;

    minutes = minutes.toString().padStart(2, "0");
    seconds = seconds.toString().padStart(2, "0");

    timerEl.textContent = `${minutes}:${seconds}`;

    // Last 10 seconds → red + blink
    if (totalSeconds <= 10) {
      timerEl.classList.add("danger");
      timerEl.classList.add("blink");
    }

    if (totalSeconds <= 0) {
      clearInterval(interval);
      timerEl.classList.remove("blink");
    }

    totalSeconds--;
  }

 
  let interval = null;
  interval = setInterval(updateTimer, 1000);
   updateTimer();

  //-----------------------

//slots
var animRanges = {

  //crouch_left: [692, 723],
  //crouch_right: [724, 755],
  crouch_left: [1, 26],
  crouch_right: [1, 26],
  //punt: [122, 234],
  //roll: [235, 359],
  save_lower_center: [79, 144],
    save_lower_left: [174, 279],//[174, 269],//save_lower_left: [174, 290],
  save_lower_right: [291, 387], //[291, 407],
  save_upper_center: [145, 173],
  save_upper_left: [408, 522],//[408, 549],
  save_upper_right: [550, 665],//[550, 691],
  //throw_ball: [998, 1174]
};

var diveDistance = {

  crouch_left: 0,
  crouch_right: 0, //(use negative value to move the model right)

  save_lower_left: -2.0,
  save_lower_right: 2.0,
  save_upper_left: -2.3,
  save_upper_right: 1.3,
  save_lower_center: 0,
  save_upper_center: 0,
  punt: 0,
  roll: 0,
  throw_ball: 0
};

const goli_anim = [
    "save_upper_center",
    "save_upper_right",
    "save_lower_right",
    "save_upper_left",
    "save_lower_left",
    "save_lower_center"
  ];



//let an =0;
  let random_anim_value = 0;
  let lottery = 0;
let lottery_bank = [0,1,2,0,2];
function decideKeeperDive(angleRad) {
      clearTimeout(decide_wait_time);

      //console.log("lottery_bank = " + lottery_bank);
      //console.log("lottery_bank = " + lottery_bank.shuffle());

    /*if(an >= goToIdleAfter.length-1){
      an = 0;
    }
    an++;
    playSegment(goToIdleAfter[an]);*/

      const midAngle = (angleMin + angleMax) / 2;
      //console.log("midAngle ====== "+ (currentForce*angleRad) + " angleRad ====== "+ angleRad);

      const range = currentForce*angleRad;

     //playSegment("save_upper_left");
      
     //jump based on the actual ball position
     const sp_factor = 1.3;

     /*if(range >= -0.005 && range < 0.005){
        speedNormal = 0.5;
          playSegment("save_lower_center");  
          console.log("************" + "save_lower_center" + " range = "+ range);  
      }else if(range >= -0.1 && range < 0.1){
        speedNormal = 0.5;
         playSegment("save_upper_center");
         console.log("************" + "save_upper_center" + " range = "+ range);
      }else if(range >= 0.1 && range < 0.19){
        speedNormal = sp_factor;
         playSegment("save_lower_left");
         console.log("************" + "save_lower_left" + " range = "+ range);
      }else if(range >= 0.19 && range < 0.9){
        speedNormal = 1.5;//sp_factor;
         playSegment("save_upper_left");
         console.log("************" + "save_upper_left" + " range = "+ range);
      }else if(range <= -0.1 && range > -0.19){
        speedNormal = sp_factor;
         playSegment("save_lower_right");
         console.log("************" + "save_lower_right" + " range = "+ range);
      }else if(range <= -0.19 && range > -0.9){
        speedNormal = 1.5;//sp_factor;
         playSegment("save_upper_right");
         console.log("************" + "save_upper_right" + " range = "+ range);
      }*/

      //console.log("range = "+ range);

      /*if(range >= -0.1 && range < 0.1){
         playSegment("save_upper_center");
      }else if(range >= 0.1 && range < 0.25){
         playSegment("save_upper_right");
      }else if(range >= 0.25 && range < 0.9){
         playSegment("save_lower_right");
      }else if(range <= -0.1 && range > -0.25){
         playSegment("save_upper_left");
      }else if(range <= -0.25 && range > -0.9){
         playSegment("save_lower_left");
      }else{
          playSegment("save_lower_center");    
      }*/

      // Random jump trigger


    lottery = getRandomInt(0,2);
    if(lottery === 0){ // play accurate animation 
         if(range >= -0.005 && range < 0.005){
            speedNormal = 0.5;
              playSegment("save_lower_center");  
              console.log("************" + "save_lower_center" + " range = "+ range);  
          }else if(range >= -0.1 && range < 0.1){
            speedNormal = 0.5;
             playSegment("save_upper_center");
             console.log("************" + "save_upper_center" + " range = "+ range);
          }else if(range >= 0.1 && range < 0.19){
            speedNormal = sp_factor;
             playSegment("save_lower_left");
             console.log("************" + "save_lower_left" + " range = "+ range);
          }else if(range >= 0.19 && range < 0.9){
            speedNormal = 1.5;//sp_factor;
             playSegment("save_upper_left");
             console.log("************" + "save_upper_left" + " range = "+ range);
          }else if(range <= -0.1 && range > -0.19){
            speedNormal = sp_factor;
             playSegment("save_lower_right");
             console.log("************" + "save_lower_right" + " range = "+ range);
          }else if(range <= -0.19 && range > -0.9){
            speedNormal = 1.5;//sp_factor;
             playSegment("save_upper_right");
             console.log("************" + "save_upper_right" + " range = "+ range);
          }
      }else if(lottery === 1){ // play accurate animation 
         if(range >= -0.005 && range < 0.005){
            speedNormal = 0.5;
              playSegment("save_lower_center");  
              console.log("************" + "save_lower_center" + " range = "+ range);  
          }else if(range >= -0.1 && range < 0.1){
            speedNormal = 0.5;
             playSegment("save_upper_center");
             console.log("************" + "save_upper_center" + " range = "+ range);
          }else if(range >= 0.1 && range < 0.19){
            speedNormal = sp_factor;
             playSegment("save_lower_left");
             console.log("************" + "save_lower_left" + " range = "+ range);
          }else if(range >= 0.19 && range < 0.9){
            speedNormal = 1.5;//sp_factor;
             playSegment("save_upper_left");
             console.log("************" + "save_upper_left" + " range = "+ range);
          }else if(range <= -0.1 && range > -0.19){
            speedNormal = sp_factor;
             playSegment("save_lower_right");
             console.log("************" + "save_lower_right" + " range = "+ range);
          }else if(range <= -0.19 && range > -0.9){
            speedNormal = 1.5;//sp_factor;
             playSegment("save_upper_right");
             console.log("************" + "save_upper_right" + " range = "+ range);
          }
      }else{
        //random_anim_value = getRandomInt(0,goli_anim.length-1);
        //playSegment(goli_anim[random_anim_value]);
         
         if(range >= 0.1 && range < 0.19){
            speedNormal = sp_factor;
             playSegment("save_upper_left");
             console.log(" Random ************" + "save_lower_left" + " range = "+ range);
          }else if(range >= 0.19 && range < 0.9){
            speedNormal = 1.5;//sp_factor;
             playSegment("save_lower_left");
             console.log("Random ************" + "save_upper_left" + " range = "+ range);
          }else if(range <= -0.1 && range > -0.19){
            speedNormal = sp_factor;
             playSegment("save_upper_right");
             console.log("Random ************" + "save_lower_right" + " range = "+ range);
          }else if(range <= -0.19 && range > -0.9){
            speedNormal = 1.5;//sp_factor;
             playSegment("save_lower_right");
             console.log("Random ************" + "save_upper_right" + " range = "+ range);
          }

          /*
            if(range >= 0.1 && range < 0.19){
            speedNormal = sp_factor;
             playSegment("save_upper_right");
             console.log(" Random ************" + "save_lower_left" + " range = "+ range);
          }else if(range >= 0.19 && range < 0.9){
            speedNormal = 1.5;//sp_factor;
             playSegment("save_lower_right");
             console.log("Random ************" + "save_upper_left" + " range = "+ range);
          }else if(range <= -0.1 && range > -0.19){
            speedNormal = sp_factor;
             playSegment("save_lower_left");
             console.log("Random ************" + "save_lower_right" + " range = "+ range);
          }else if(range <= -0.19 && range > -0.9){
            speedNormal = 1.5;//sp_factor;
             playSegment("save_upper_left");
             console.log("Random ************" + "save_upper_right" + " range = "+ range);
          }
          */
      }
      

      /*
    // Random jump trigger
    lottery = getRandomInt(0,2);
    if(lottery === 0){ // play accurate animation 
        if(range >= -0.1 && range < 0.1){
           playSegment("save_upper_center");
        }else if(range >= 0.1 && range < 0.25){//right for user and left for goli
           playSegment("save_upper_right");
        }else if(range >= 0.25 && range < 0.9){
           playSegment("save_lower_right");
        }else if(range <= -0.1 && range > -0.25){
           playSegment("save_upper_left");
        }else if(range <= -0.25 && range > -0.9){
           playSegment("save_lower_left");
        }else{
            playSegment("save_lower_center");    
        }
      }else if(lottery === 1){ // play accurate animation 
        if(range >= -0.1 && range < 0.1){
           playSegment("save_upper_center");
        }else if(range >= 0.1 && range < 0.25){//right for user and left for goli
           playSegment("save_upper_right");
        }else if(range >= 0.25 && range < 0.9){
           playSegment("save_lower_right");
        }else if(range <= -0.1 && range > -0.25){
           playSegment("save_upper_left");
        }else if(range <= -0.25 && range > -0.9){
           playSegment("save_lower_left");
        }else{
            playSegment("save_lower_center");    
        }
      }else{
        //random_anim_value = getRandomInt(0,goli_anim.length-1);
        //playSegment(goli_anim[random_anim_value]);
        if(range >= -0.1 && range < 0.1){
           playSegment("save_upper_left");
        }else if(range >= 0.1 && range < 0.25){//right for user and left for goli
           playSegment("save_upper_left");
        }else if(range >= 0.25 && range < 0.9){
           playSegment("save_lower_left");
        }else if(range <= -0.1 && range > -0.25){
           playSegment("save_upper_right");
        }else if(range <= -0.25 && range > -0.9){
           playSegment("save_lower_right");
        }
      }
      */
      animation_speed = speedNormal;
      //console.log("lottery value = "+ lottery);
  


}


//------------------------------------🔄🔄🔄🔄🔄🔄🔄🔄🔄🔄🔄🔄🔄-------resetBall
//------------------------------------🔄🔄🔄🔄🔄🔄🔄🔄🔄🔄🔄🔄🔄-------resetBall
//------------------------------------🔄🔄🔄🔄🔄🔄🔄🔄🔄🔄🔄🔄🔄-------resetBall
//let ball_initial_scale = 0.3;
let ball_initial_scale = 0.25;
function resetBall() {
  //console.log("reset ball.position.z = "+ ball.position.z);
  ballInFlight = false;
  //ball.position.set(0, 0.2, 0);
  //ball.position.set(0, 0.4, -0.7);
  //ball.position.set(0, 0.4, 0.1);//original pos later
  ball.position.set(0, 0.4, -1.7);//original pos

  //ball.position.set(0, 0.1, -1.2);
  //ball.position.set(ball_init_WorldPos);
   //ball.position.copy(ball_init_WorldPos);
   //console.log("ball_init_WorldPos "+ball_init_WorldPos);
    //console.log(ballWorldPos.x, ballWorldPos.y,ballWorldPos.z);
  ball.scale.set(ball_initial_scale, ball_initial_scale, ball_initial_scale);

  velocity.set(0, 0, 0);
  currentForce = 0;
  currentSwing = 0;
  currentAngle = 0;
  hit_Flag = false;
  goli_hit_Flag = false;
  net_hit_Flag = false;
  ball.visible = true;
  ball_in_air = 1;
  showGoalFlash_msg = false;
  goalkeeper.visible = true;
  goal_is_done = false;
  list_id = 1;


  /*for(let i = 0; i < ball_Materials.length; i++){
    ball_Materials[i].opacity = 1;
  }*/
  fadeBall_In();


}



//-----------------------------------🔫 🔫 🔫 🔫 🔫 🔫 🔫 🔫 🔫 🔫 🔫 🔫 -----shootBall
//-----------------------------------🔫 🔫 🔫 🔫 🔫 🔫 🔫 🔫 🔫 🔫 🔫 🔫 -----shootBall
//-----------------------------------🔫 🔫 🔫 🔫 🔫 🔫 🔫 🔫 🔫 🔫 🔫 🔫 -----shootBall
let decide_wait_time = null;
function shootBall() {

  //if(currentForce < 0.2){
    //currentForce = 0.2;
  //}

  if (ballInFlight) return;
  
  hit_Flag = false;

  velocity = getInitialVelocity(currentAngle, currentForce);
  ballInFlight = true;
  ready_to_shoot = false;

  if(trajectoryMarkers.length>0){
   disposeTrajectoryMarkers();
  }
  //call goal keeper animation
  
clearTimeout(decide_wait_time);
decide_wait_time = setTimeout(() => {// jump after this delay
    decideKeeperDive(currentAngle);
 }, 5); // 225


  //console.log("currentForce = "+ currentForce + " currentSwing = "+ currentSwing);


}

function mapForceToSpeed(forceValue) {
  // forceValue is expected to be between 0 and 1
  const minSpeed = 5;
  const maxSpeed = 15;//25;//25+50;
  return minSpeed + (maxSpeed - minSpeed) * forceValue+0;
}
/*
function getInitialVelocity(angle, force) {//new
  const flatDir = new THREE.Vector3(Math.sin(-angle), 0, Math.cos(-angle)).normalize();

  // Fixed or tweakable launch angle
  const yComponent = force*0.5; // or Math.tan(launchAngleInRadians)
  const dir = new THREE.Vector3(flatDir.x, yComponent, flatDir.z).normalize();

  return dir.multiplyScalar(mapForceToSpeed(force));
}
*/

function getInitialVelocity(angle, force) {//new
  const flatDir = new THREE.Vector3(Math.sin(-angle), 0, Math.cos(-angle)).normalize();
  
  // Fixed or tweakable launch angle
  const yComponent = force*0.5; // or Math.tan(launchAngleInRadians)
  //const dir = new THREE.Vector3(flatDir.x, yComponent, flatDir.z).normalize();

  const speed = mapForceToSpeed(force);
  // Launch angle in degrees → tweak this to control arc
  const launchAngleDeg = angle; 
  const launchAngle = THREE.MathUtils.degToRad(launchAngleDeg+25);//55
  // Combine horizontal and vertical components
  const velocity = new THREE.Vector3(

    flatDir.x *Math.cos(launchAngle),
    Math.tan(launchAngle)*force,
    flatDir.z * Math.cos(launchAngle)
  ).multiplyScalar(speed);

  return velocity;

}


function applyLateralAcceleration(velocity, angle, swing, delta) {
  const lateralDir = new THREE.Vector3(
    Math.cos(angle),
    0,
    -Math.sin(angle)
  ).normalize();

  const swingForce = swing * 100;//100;
  //const lateralAccel = lateralDir.multiplyScalar(swingForce * 0.1 * delta);//gives cure due to increased multiply factor
   //const lateralAccel = lateralDir.multiplyScalar(swingForce * 0.15 * delta);//gives cure due to increased multiply factor
  const lateralAccel = lateralDir.multiplyScalar(swingForce * 0.05 * delta);//old
  velocity.add(lateralAccel);
}

// Optional: if you want parabolic motion
function applyGravity(velocity, delta) {
  const gravity = new THREE.Vector3(0, -9.81 * delta, 0);
  velocity.add(gravity);
}

function disposeTrajectoryMarkers() {
  for (const m of trajectoryMarkers) {
    if (m.geometry) m.geometry.dispose();
    if (m.material) m.material.dispose();
    scene.remove(m);
    //gameWorld.remove(m);
  }
  trajectoryMarkers = [];
}
//---------------------------------------------🚀 🚀 🚀 🚀 🚀 🚀 🚀 🚀 🚀 🚀 🚀 🚀 🚀 🚀 🚀 🚀 🚀 🚀 🚀 🚀 ----- Create trajectory

//---------------------------------------------🚀 🚀 🚀 🚀 🚀 🚀 🚀 🚀 🚀 🚀 🚀 🚀 🚀 🚀 🚀 🚀 🚀 🚀 🚀 🚀 ----- Create trajectory

//---------------------------------------------🚀 🚀 🚀 🚀 🚀 🚀 🚀 🚀 🚀 🚀 🚀 🚀 🚀 🚀 🚀 🚀 🚀 🚀 🚀 🚀 ----- Create trajectory

//arc spheres with glow and fade at the end 
let trajectoryMarkers = [];

function createTrajectoryLine() {

// 🧹 Remove old markers
  for (const m of trajectoryMarkers) scene.remove(m);
  trajectoryMarkers = [];

  const timeStep = 0.05;
  const totalTime = 1;//1.5;


  //const startPos = ball.position.clone() ;
    // Get ball world position
  const ballWorldPos = new THREE.Vector3();
  const startPos = ball.getWorldPosition(ballWorldPos);



  const velocity = getInitialVelocity(currentAngle, currentForce).clone();
  let pos = startPos.clone();

  // ⚙️ Base geometry and material
  const sphereGeometry = new THREE.SphereGeometry(0.09, 12, 12); // smooth small spheres
  const stepInterval = 1; // spacing between spheres
  let stepCount = 0;

  for (let t = 0; t < totalTime; t += timeStep) {
    applyLateralAcceleration(velocity, currentAngle, currentSwing, timeStep);
    applyGravity(velocity, timeStep);
    pos.addScaledVector(velocity, timeStep);

    if (stepCount % stepInterval === 0) {
      // Fade and size interpolation based on time
      const fade = t / totalTime;
      const opacity = THREE.MathUtils.lerp(1.0, 0.1, fade);
      const scale = THREE.MathUtils.lerp(1.0, 0.4, fade);

      // 🟣 Glowing material — use bright emissive-like color
      const sphereMaterial = new THREE.MeshBasicMaterial({
        color: new THREE.Color(0xffef03), // pink-red glow
        transparent: true,
        opacity: opacity,
        depthTest: true,
        depthWrite: true,
      });

      const sphere = new THREE.Mesh(sphereGeometry, sphereMaterial);
      sphere.position.copy(pos);
      sphere.scale.set(scale, scale, scale);
      scene.add(sphere);

      trajectoryMarkers.push(sphere);
    }

    stepCount++;
  }
}
function createTrajectoryLine_1(tim) {
/*
  // 🧹 Remove old markers
  for (const m of trajectoryMarkers) scene.remove(m);
  trajectoryMarkers = [];

  const timeStep = 0.05;
  const totalTime = tim;//1.5;

  const startPos = ball.position.clone();
  const velocity = getInitialVelocity(currentAngle, currentForce).clone();
  let pos = startPos.clone();

  // ⚙️ Base geometry and material
  const sphereGeometry = new THREE.SphereGeometry(0.09, 12, 12); // smooth small spheres
  const stepInterval = 1; // spacing between spheres
  let stepCount = 0;

  for (let t = 0; t < totalTime; t += timeStep) {
    applyLateralAcceleration(velocity, currentAngle, currentSwing, timeStep);
    applyGravity(velocity, timeStep);
    pos.addScaledVector(velocity, timeStep);

    if (stepCount % stepInterval === 0) {
      // Fade and size interpolation based on time
      const fade = t / totalTime;
      const opacity = THREE.MathUtils.lerp(1.0, 0.1, fade);
      const scale = THREE.MathUtils.lerp(1.0, 0.4, fade);

      // 🟣 Glowing material — use bright emissive-like color
      const sphereMaterial = new THREE.MeshBasicMaterial({
        color: new THREE.Color(0xffef03), // pink-red glow
        transparent: true,
        opacity: opacity,
        depthTest: true,
        depthWrite: true,
      });

      const sphere = new THREE.Mesh(sphereGeometry, sphereMaterial);
      sphere.position.copy(pos);
      sphere.scale.set(scale, scale, scale);
      scene.add(sphere);
      trajectoryMarkers.push(sphere);
    }

    stepCount++;
  }
  */
}


//--------
//--------??
let timeScale = 1;
let isSlowMo = false;

ballInFlight=false;
let ball_in_air = 1;


//--------------------------------------- ⚽️ ⚽️ ⚽️ ⚽️ ⚽️ ⚽️ ⚽️ ⚽️ ⚽️ ⚽️ ⚽️ ⚽️ ⚽️ ⚽️ ⚽️ ⚽️ ⚽️ update ball

//--------------------------------------- ⚽️ ⚽️ ⚽️ ⚽️ ⚽️ ⚽️ ⚽️ ⚽️ ⚽️ ⚽️ ⚽️ ⚽️ ⚽️ ⚽️ ⚽️ ⚽️ ⚽️ update ball

//--------------------------------------- ⚽️ ⚽️ ⚽️ ⚽️ ⚽️ ⚽️ ⚽️ ⚽️ ⚽️ ⚽️ ⚽️ ⚽️ ⚽️ ⚽️ ⚽️ ⚽️ ⚽️ update ball

function updateBallPosition(delta) {
  //console.log("updateBallPosition");
  //console.log("Ball object:", ball);
  //console.log(ball.geometry.boundingSphere);
  //delta *= timeScale;
  if (!ballInFlight) return;

  applyLateralAcceleration(velocity, currentAngle, currentSwing, delta);
  applyGravity(velocity, delta); // Optional

  ball.position.addScaledVector(velocity, delta);
  

    //Ball rotation
    //const ballRadius = 1;//1.22; // Adjust if your ball size differs
    //const distance = velocity.length() * delta;
    //const angleRotated = distance / ballRadius*2;

    // Spin axis: perpendicular to direction of motion (on ground)
    //const rotationAxis = new THREE.Vector3().copy(velocity).normalize().cross(new THREE.Vector3(currentSwing, 1, 0)).normalize();

    // Apply smooth rotation
    //ball.rotateOnAxis(rotationAxis, angleRotated);

    // Optional: simulate spin due to swing
    //const spinAmount = currentSwing *10;
    //const spinAmount = currentSwing *100* delta;
    //console.log("spinAmount = " + spinAmount);
    //ball.rotateY(spinAmount);
    ball.rotateY(currentForce * 100 * currentSwing * delta);//* FRICTION


  //---- ball hit test with poles

  // Update ball bounding box for current frame
  //ballBox.setFromObject(ball);


  ball.updateMatrixWorld(true);
  ballBox.setFromObject(ball);

  //if(!goli_hit_Flag){
    if(goli_hit_Flag) return;
    check_Goli_Collision(ball, hitSpheres);
  //}

  //console.log("-------------Check collision with static post boxes--------------  🥅 🥅 🥅 🥅 🥅  Goalpost");
  // Check collision with static post boxes
  if(hit_Flag) return;
  for (let i = 0; i < postBoxes.length; i++) {
    
    goalPosts[i].updateMatrixWorld(true);
    postBoxes[i].setFromObject(goalPosts[i]);

        if(!hit_Flag){

        //if(!hit_Flag && !goli_hit_Flag){
          if (ballBox.intersectsBox(postBoxes[i])) {
            hit_Flag = true;
            //console.log("goli_hit_Flag =" + goli_hit_Flag); 
            handlePostCollision(goalPosts[i]);

            break;
            
          }
      }
    }

    if (ball.position.z >= 12.0){
      ballInFlight = false;
        //hit_Flag = true;
        //velocity.y=0;
          fadeBall();
          
            //console.log("here------------------ "+ "missed the ball");
            //hit_Flag = true;
            if(list_id != 0){
              list_id = 2;
            }
            
            showGoalFlash();
            //setTimeout(showGoalFlash, 1000);
    }
     if (ball.position.y <0.4){
      //ball.position.y = ball.position.y+ballRadius;
      //ballInFlight = false;
      //hit_Flag = true;
      velocity.y=0; // ball moving on the ground
      /*if(hit_Flag){
        velocity.set(0,0,0);
      }else{
        velocity.y=0; // ball moving on the ground
      }*/

      if(goli_hit_Flag || goal_is_done){
        fadeBall();
        ballInFlight = false;
        currentSwing = 0;
        currentForce = 0;
        //velocity.z = 0; //*= - 0.04; // Reverse and damp Z velocity // -0.8
        //velocity.x = 0; //*=  0.03;
        //velocity.y *= - 0.8;//0.9
        ball.rotateY(0);
        velocity.set(0,0,0);
        //ball.position.y = -0.1;


      }else{
         //ball.position.y = ball.position.y+ballRadius;
      }
      ball.position.y = 0.4;//ball.position.y+ballRadius;//yyy
      //ball_in_air = 0;
        //velocity.z *= 0.5;
  //velocity.x *= 0.5;
  //velocity.y *= 0.0005;
      //fadeBall();
      //list_id = 2;
      //showGoalFlash();

    }


}
let goal_is_done = false;
let ready_to_shoot = false;
//----- ⚽️ ⚽️ ⚽️ update ball finished here


  /*ball.updateMatrixWorld(true);
  ballBox.setFromObject(ball);

  goalPosts[i].updateMatrixWorld(true);
  postBoxes[i].setFromObject(goalPosts[i]);*/


let ballWorldPos = new THREE.Vector3();
/*let ballSphere = new THREE.Sphere(
    ballWorldPos,
    ballBaseRadius * ball.scale.x
  );*/


function check_Goli_Collision(ballMesh, hitSpheres) {
  //const ballWorldPos = new THREE.Vector3();
  ballMesh.getWorldPosition(ballWorldPos);

  const ballSphere = new THREE.Sphere(
    ballWorldPos,
    //ballBaseRadius * ballMesh.scale.x
    ballRadius
  );
  //ballSphere.updateMatrixWorld(true);

  for (const hb of hitSpheres) {//hand_grabber_Mesh.position.copy(position).add(new THREE.Vector3(0, 1.5, 0.5));
    /*const hbWorldPos = new THREE.Vector3();
    hb.mesh.updateMatrixWorld(true);
    hb.mesh.getWorldPosition(hbWorldPos);//.add(new THREE.Vector3(-0.5, -0.5, 0)


    //const keeperSphere = new THREE.Sphere(hbWorldPos, hb.radius * hb.mesh.scale.x);
    const keeperSphere = new THREE.Sphere(hbWorldPos, hb.radius*.1);
    //const keeperSphere = hb.mesh;*/

    const hbWorldPos = new THREE.Vector3();
    const hbWorldQuat = new THREE.Quaternion();
    const hbWorldScale = new THREE.Vector3();

    hb.mesh.updateWorldMatrix(true, false);
    hb.mesh.matrixWorld.decompose(hbWorldPos, hbWorldQuat, hbWorldScale);

    const keeperSphere = new THREE.Sphere(
        hbWorldPos,
        hb.radius * hbWorldScale.x
    );

    
    if(!goli_hit_Flag){
      
      if (keeperSphere.intersectsSphere(ballSphere)) {//
        if(hit_Flag) return;
        goli_hit_Flag = true;
        //console.log("Ball hit goalkeeper bone:", hb.mesh.parent.name, "❌❌❌❌❌❌❌❌");
        //copy_color = "#ff4444";       
        //goalFlash.innerText = "SAVED!";
        //list_id = 3;
        list_id = 0;
        showGoalFlash();
        fadeBall();

        //ball.visible = false;

        /*velocity.z *= - 0.4; // Reverse and damp Z velocity // -0.8
        velocity.x *=  3.8;
        velocity.y *= - 0.8;//0.9*/

        velocity.z *= - 0.4; // Reverse and damp Z velocity // -0.8
        velocity.x *=  1.8;
        velocity.y *= - 0.8;//0.9

        
        //const screenPos = worldToScreenPosition(ball.position, camera);
        //triggerStarConfettiBurst(screenPos.x, screenPos.y, 60);

        return true;
        
      }
    }
  }
  return false;
}



function handlePostCollision(post) {
  let deflectionStrength = 3.2; // adjust this

  velocity.z *= 0.1;
  velocity.x *= 0.0005;
  velocity.y *= 0.000005;

  //velocity.z *= 0.05;
  //velocity.x *= 0.0005;
  //velocity.y *= 0.0005;

  //console.log("hit the pole and hit_Flag = " + hit_Flag);
  //console.log("pole hit ball.position.z = "+ ball.position.z);

  // Play sound, add effect here if needed

  

   isGoal = false;


  switch (post.name) {
    case 'leftPost':
      isGoal = isBallOnGoalSideOfPost(post);

      if(isGoal){
        score_multiplyer = 1.5;
        //deflectionStrength = -(2 + Math.random()*2);//deflects the ball inside the goalpost towards right side
        //velocity.y += deflectionStrength + 2; //deflect the ball slightly down towards the ground

        deflectionStrength = -(2 + Math.random()*3);
        velocity.x += deflectionStrength;
        //velocity.y +=  deflectionStrength*0.1; 
        velocity.y +=  deflectionStrength*0.00001; 
      }
      else{
        list_id = 0;
        deflectionStrength = (3 + Math.random()*3);
        velocity.x += deflectionStrength;

      }
      //velocity.x += deflectionStrength*0.1;
      //velocity.x += isGoal ? 0.5 : deflectionStrength;
      break;

    case 'rightPost':
      isGoal = isBallOnGoalSideOfPost(post);

      if(isGoal){
        score_multiplyer = 1.5;
        deflectionStrength = (2 + Math.random()*3);//deflects the ball  inside the goalpost towards left side
        //velocity.y += deflectionStrength - 6; //deflect the ball slightly down towards the ground
        //velocity.y += - deflectionStrength*0.2; 
        velocity.y += - deflectionStrength*0.00002; 
      }
      else{
        list_id = 0;
        deflectionStrength = -(3 + Math.random()*3);

      }
      velocity.x += deflectionStrength;

      //velocity.x += isGoal ? -0.5 : -deflectionStrength;
      break;

    case 'crossbar':
      
      isGoal = isBallBelowCrossbar(post);
      if(isGoal){
        score_multiplyer = 1.5;
        //Ball hit the cross bar on bottom side and defects down side inside the goal
        //deflectionStrength = - 2;// deflects the ball towards down side
        deflectionStrength = - (1 + Math.random()*1);

        if(ball.position.x < post.position.x){
          //console.log("crossbar RIGHT corner BOTTOM-----");
          //velocity.x += deflectionStrength + 4;
          velocity.x += deflectionStrength + (2 + Math.random()*2);
        }else{
          //velocity.x += deflectionStrength;
          velocity.x += deflectionStrength - (0 + Math.random()*1)
          //console.log("crossbar LEFT corner BOTTOM-----");
        }
        velocity.y += deflectionStrength*0.00005;

      }
      else{
        list_id = 0;
        // Ball hit the cross bar on top side and defects on the upside
        //console.log(Math.random()* 2);
        deflectionStrength = (2 + Math.random()*2);

        if(ball.position.x < post.position.x){
          //console.log("crossbar RIGHT corner TOP-----");
          velocity.x += deflectionStrength - 8;
        }else{
          velocity.x += 5+deflectionStrength -2;
          //console.log("crossbar LEFT corner TOP-----");
        }
        //velocity.y += -deflectionStrength*0.005;
        velocity.y += 5;

      }
      
      //velocity.y += deflectionStrength*0.5;
      
      

      break;

    case 'net':

     
     velocity.y += -deflectionStrength*0.003;
     velocity.x = 0;
     velocity.z *= 0.00002;
     isGoal = true;
     score_multiplyer = 1;

     //console.log( "✅ ❌✅ ❌✅ ❌✅ ❌✅ ❌✅ ❌✅ ❌");

      break;
  }

  // Optional: log or trigger goal/no-goal visual
  //console.log(`Post hit: ${post.name} → Goal side? ${isGoal ? '✅ YES' : '❌ NO'}`);
  //console.log("isGoal = "+isGoal);
  fadeBall();
  if(isGoal){
    isGoal =false;
    //ball.visible = false;
    goal_is_done = true;
    score+=10;



    //console.log("currentForce = "+ currentForce + " currentSwing = "+ currentSwing);
    registerShot(true);
    scoreDisplay.textContent = score;
    flashScore();
    createScorePopup();
    //console.log("-------------Goal By Pole--------------💈 💈 💈 💈 💈 💈 💈 💈 💈 💈");
    //copy_color = "#ffcc00";
    //goalFlash.innerText = "GOAL!";
    list_id = 1;
    //showGoalFlash();
    setTimeout(showGoalFlash, 1100);
    //const screenPos = worldToScreenPosition(ball, camera);
    //triggerStarConfettiBurst(screenPos.x, screenPos.y, 60);
    

    spawnConfettiBurst(ball.position.clone(), 120);


  }else{
    if(list_id != 0){
        list_id = 2;
    }
    //showGoalFlash();
    setTimeout(showGoalFlash, 500);
  }



  // Slightly reduce forward speed to simulate energy loss
  velocity.multiplyScalar(0.9);

  // Optionally spin the ball to make it look cooler
  //ball.rotation.y += 0.3;

  // Prevent ball from sticking inside post
  //const offset = new THREE.Vector3().copy(velocity).normalize().multiplyScalar(0.05);
  //ball.position.add(offset);

  //createSpark(ball.position);
  
  shakeCamera(0.2, 150);
  
  
}

//--- For Left & Right Posts (X-axis based)
function isBallOnGoalSideOfPost(post) {
  const ballX = ball.position.x;
  const postX = post.position.x;

  if (post.name === 'leftPost') {
    // If ball is to the right of the post → goal side
    //return ballX > postX;
    return ballX < postX;
  } else if (post.name === 'rightPost') {
    // If ball is to the left of the post → goal side
    //return ballX < postX;
    return ballX > postX;
  }

  return false;
}

//---- For Crossbar (Y-axis based)

function isBallBelowCrossbar(post) {
  const ballY = ball.position.y;
  const barY = post.position.y + 0.05; // half the height (0.1 / 2)

  // If ball is below the crossbar (hit bottom) → it's going in
  return ballY < barY;
}

//----------------------- countdown

const countDown_Text = document.createElement('div');

//countDown_Text.style.fontSize = '8vw'; // scales with screen size

countDown_Text.style.color = '#BA0C2F'; // kelloggs red core text
countDown_Text.style.textAlign = 'center';
countDown_Text.style.position = 'absolute';
countDown_Text.style.top = '50%';
countDown_Text.style.left = '50%';
countDown_Text.style.transform = 'translate(-50%, -50%)';
countDown_Text.style.textShadow = `
  0 0 5px #ffffff,    /* soft black halo */
  0 0 10px #ffffff

`;
//countDown_Text.style.webkitTextStroke = '2px black'; // crisp edge on Chrome/Safari
countDown_Text.style.padding = '10px 20px';
countDown_Text.style.borderRadius = '12px';
countDown_Text.style.userSelect = 'none';
countDown_Text.style.pointerEvents = 'none';
countDown_Text.style.zIndex = '9996';
//countDown_Text.style.fontSize = 'clamp(4rem, 5vw, 3rem)';
countDown_Text.style.fontSize = 'clamp(5rem, 7vw, 6rem)';
countDown_Text.style.fontWeight = '400';//ff
countDown_Text.style.fontFamily ='Cherry Bomb One', 'system-ui';//'sans-serif';
countDown_Text.style.opacity = '0';
countDown_Text.style.display = 'none'


// Add it to the page
document.body.appendChild(countDown_Text);


let countdown_setTimeout = null;
//const countDown_copy_list = ["Get Ready!", "Shoot in", "3", "2", "1"];
const countDown_copy_list = ["Tap", "Drag", "Set Your Angle", "Shoot The Ball"];
let countDown_count = 0;
let countDown_finished = false;

function show_Countdown() {

  if(countDown_finished) return;
  countDown_Text.innerText = countDown_copy_list[countDown_count];
  //countDown_Text.style.color = '#ffcc00';
  //countDown_Text.style.textShadow = '0 0 20px #ffcc00, 0 0 40px #ff6600';

 // Start big and transparent
    countDown_Text.style.transform = 'translate(-50%, -50%) scale(1.5)';
    countDown_Text.style.display = 'block'
    countDown_Text.style.opacity = '0';
    countDown_Text.style.transition = 'none';

    /// Trigger reflow to reset transition
    void countDown_Text.offsetWidth;

    // Fade in and shrink to normal
    countDown_Text.style.transition = 'transform 0.3s ease-out, opacity 0.3s ease-in';
    countDown_Text.style.transform = 'translate(-50%, -50%) scale(1)';


  countDown_Text.style.opacity = '1';

    clearTimeout(countdown_setTimeout);

    countdown_setTimeout = setTimeout(() => {

    countDown_Text.style.transition = 'transform 0.4s ease-in, opacity 0.4s ease-out';
    countDown_Text.style.transform = 'translate(-50%, -50%) scale(1)';

    countDown_Text.style.opacity = '0';
    countDown_Text.innerText = "";
    countDown_count++;
      if(countDown_count< countDown_copy_list.length){
        show_Countdown();
          
      }else{
        //show grabber hand helper_
        //countDown_count = 0;
        countDown_finished = true;
        ready_to_shoot = true;
        //grabber_hand_anim(ball.position,ball.rotation.y);
        countDown_Text.style.display = 'none'
        disposeCountdown();
        clearTimeout(countdown_setTimeout);
      }


  }, 1500); // visible for 1 second


}
function disposeCountdown() {
  if (countDown_Text && countDown_Text.parentNode) {
    countDown_Text.parentNode.removeChild(countDown_Text);
  }
}

//---------------------------- Grabber hand anim

//---- sprite_sheet grabber hand animation
const hand_tilesHoriz = 5; // number of tiles horizontally
const hand_tilesVert = 1;  // number of tiles vertically
const hand_numberOfTiles = hand_tilesHoriz * hand_tilesVert;

//const hand_grabber_Texture = new THREE.TextureLoader().load('https://user.cdn.mywebar.com/521765/792411/Hand_spriteheet_5.png');
const hand_grabber_Texture = new THREE.TextureLoader().load('./Hand_spriteheet_8_rotated');

hand_grabber_Texture.wrapS = hand_grabber_Texture.wrapT = THREE.RepeatWrapping;
hand_grabber_Texture.repeat.set(1 / hand_tilesHoriz, 1 / hand_tilesVert); // example 4x4

const hand_grabber_Material = new THREE.MeshBasicMaterial({
  map: hand_grabber_Texture,
  transparent: true,
  side: THREE.DoubleSide,
  depthTest: false,
  depthWrite: false,



});

const hand_grabber_Geometry = new THREE.PlaneGeometry(2, 2);
const hand_grabber_Mesh = new THREE.Mesh(hand_grabber_Geometry, hand_grabber_Material);
//scene.add(hand_grabber_Mesh);
hand_grabber_Mesh.visible = false;
hand_grabber_Mesh.renderOrder = 999;

let hand_grabber_anim_Id;

function pingPongValue(state) {
    // state: { value, direction, min, max, step }

    state.value += state.step * state.direction;

    if (state.value >= state.max) {
        state.value = state.max;
        state.direction = -1;
    } else if (state.value <= state.min) {
        state.value = state.min;
        state.direction = 1;
    }

    return state.value;
}

// INIT:
const state = {
    value: -55,
    direction: -1,
    min: -55,
    max: 55,
    step: 0.5
};



let tim = 0;
function grabber_hand_anim(position, rotationY) {

  //rotationY = 0;
  cancelAnimationFrame(hand_grabber_anim_Id);
  //splashMesh.position.copy(position);
  //hand_grabber_Mesh.position.copy(position).add(new THREE.Vector3(-0.4, 1, -0.4));
  hand_grabber_Mesh.position.copy(position).add(new THREE.Vector3(-0.4, 1.5, -0.4));
  hand_grabber_Mesh.scale.set(0.9, 0.9, 1);

  const degToRad = (deg) => deg * (Math.PI / 180);

  hand_grabber_Mesh.rotation.set( degToRad(40), degToRad(180), degToRad(0));
  hand_grabber_Mesh.visible = true;

  // start animating frames (same as before)

  let hand_currentTile = 0;
  const hand_totalDuration = 1300;//1800; // ms for full sequence
  const hand_frameDuration = hand_totalDuration / hand_numberOfTiles;
  let hand_lastTime = performance.now();

  const totalLoops = 20;//150;              // play animation 150 times
  let loopCount = 0;


    let dx = 0;
    //console.log("dx = "+ dx + "==" + dx.value);
    currentSwing = THREE.MathUtils.clamp(dx / 200, -0.5, 0.5);
    currentAngle = currentSwing;
    
    let dy = 90;//getRandomInt(35, 40);
    currentForce = THREE.MathUtils.clamp(dy / 100, 0.01, 5.5);

  function hand_grabber_updateFrame(time) {

   
    tim+=0.012;
    createTrajectoryLine_1(tim);

  if (!hand_grabber_Mesh.visible) return;
    if (time - hand_lastTime > hand_frameDuration) {
      hand_lastTime = time;
      hand_currentTile++;

      const col = hand_currentTile % hand_tilesHoriz;
      const row = Math.floor(hand_currentTile / hand_tilesHoriz);
      hand_grabber_Texture.offset.x = col / hand_tilesHoriz;
      hand_grabber_Texture.offset.y = 1 - (row + 1) / hand_tilesVert;


      if (hand_currentTile >= hand_numberOfTiles) {

          hand_currentTile = 0;
          loopCount++;
          tim=0;


          if (loopCount >= totalLoops) {

            hand_grabber_Mesh.visible = false; // done
             if(trajectoryMarkers.length>0){
                disposeTrajectoryMarkers();
              }
            cancelAnimationFrame(hand_grabber_anim_Id);
            return;
          }
      }
    }
    //requestAnimationFrame(updateFrame);
    hand_grabber_anim_Id = requestAnimationFrame(hand_grabber_updateFrame);
  }

  //requestAnimationFrame(updateFrame);
  hand_grabber_anim_Id = requestAnimationFrame(hand_grabber_updateFrame);
}




//-----------------------


//0  Miss / Goli Hit — Encourage

const copy_list_0_ = [
  "Nice Try, Keep Shootin’",
  "Sooo Close-try once more!",
  "Almost There—Don’t Stop!",
  "Great effort, shoot again!",
  "So close—try once more!",
  "Keep aiming, champ!",
  "Almost there—don’t stop!",
  "Shoot on, superstar!",
  "Stay locked in, fire away!",

  "Kick it up!",
  "Ahh! Hit the next shot!",
  "Don’t give up — kick again!"
];
const copy_list_0 = [
  "Nice Try, Keep Shootin’"
];

//1️ Successful Goal — Celebrate the score!

const copy_list_1_ = [
  "Shot! Nailed it!",
  "Whoa! You’re a PRO!",
  "Legend in the Making!",
  "Ultra Skill Unlocked!",
  "Power Level Maxed!",
  "Ice-Cold Skills!",
  "Absolute Beast!",
  "Wow! Nothing But Net!",
  "Super cool moves!",
  "Pro-level skills!",

  "Goal-den moment!",
  "Watta Power Kick!",
  "That’s how you score!"

];
const copy_list_1 = [
  "GOAL"


];

//2️ Missed — Encourage improvement

const copy_list_2 = [
  "MISSED!",
];

//3️ Saved — Playful or funny fails

const copy_list_3 = [
  "SAVED!",
];


function getRandomInt(min, max) {
    min = Math.ceil(min);
    max = Math.floor(max);
    return Math.floor(Math.random() * (max - min + 1)) + min; // Inclusive of both min and max
}


//const copy_color_1 = '#ff8c00';
//const copy_color_2 = "#ffffff";
//const copy_color_3 = "#ff0000";

//
//----- Create the "GOAL!" flash element

const goalFlash = document.createElement('div');
goalFlash.innerText = "";
//goalFlash.style.position = 'absolute';
goalFlash.style.position = 'fixed';

goalFlash.style.top = '45%';

goalFlash.style.left = '50%';
goalFlash.style.transform = 'translate(-50%, -50%)';
//goalFlash.style.fontSize = '100px';

goalFlash.style.color = '#ff8c00';

goalFlash.style.padding = '10px 20px';
goalFlash.style.borderRadius = '12px';
goalFlash.style.userSelect = 'none';
goalFlash.style.opacity = '0';
goalFlash.style.pointerEvents = 'none';
//goalFlash.style.transition = 'opacity 0.4s ease-out';
goalFlash.style.zIndex = '9997';
goalFlash.style.display = 'none';

//goalFlash.style.fontSize = 'clamp(4rem, 5vw, 3rem)';
goalFlash.style.fontSize = 'clamp(2rem, 3vw, 2rem)';
goalFlash.style.fontWeight = '400';//ff
goalFlash.style.fontFamily ='Cherry Bomb One', 'system-ui';//'sans-serif';
//goalFlash.style.fontSize = '1.1rem';

//
goalFlash.style.whiteSpace = 'normal';   // allow wrapping
//goalFlash.style.wordWrap = 'break-word'; // break long words if needed
//goalFlash.style.maxWidth = '90vw';       // limit width to 90% of viewport
goalFlash.style.maxWidth = '90vw';  
goalFlash.style.textAlign = 'center';    // optional — center text nicely


// Add it to the page
document.body.appendChild(goalFlash);

//---- Show the Flash on Goal
//let list_id = 1;
let msg_setTimeout = null;
let show_overlay_count = 0;

const copy_colors = {
  0: '#ff8c00',  // orange - missed / Saved
  1: '#BA0C2F',  // kellogs red - Goal
  2: '#ffffff',  // white - Missed
  3: '#ff8c00',  // orange - Saved
  
};
const textShadows = {
  0: '0 0 5px #000000, 0 0 10px #000000',
  1: '0 0 5px #ffffff, 0 0 10px #ffffff',
  2: '0 0 5px #BA0C2F, 0 0 10px #BA0C2F',
  3: '0 0 5px #000000, 0 0 10px #000000'
};


//---- Show the Flash on Goal
let list_id = 1;

let showGoalFlash_msg = false;

/***********************************
 *  showGoalFlash
 ***********************************/

function showGoalFlash() {

  if(showGoalFlash_msg) return;
    goli_mov_speed = 0;
    //fade_goli_out();
   showGoalFlash_msg = true;
   goalFlash.style.top = '55%';

    goalFlash.innerText = "";

    goalFlash.style.opacity = '1';

     if (list_id == 3){
       fadeBall();
     }

     if(list_id == 0 || list_id == 2 || list_id == 3){

        registerShot(false);
     }


      //console.log("list_id = "+ list_id);

      const color = copy_colors[list_id] || '#ffffff';
      //const copyList = copy_lists[list_id] || [""];
      goalFlash.style.position = 'fixed';
      goalFlash.style.transition = 'none';
      goalFlash.style.transform = 'translate(-50%, -50%) scale(2.5)';
      goalFlash.style.display = 'block';
      goalFlash.style.opacity = '0';

      void goalFlash.offsetWidth; // force layout flush



      // insert emoji image
      //goalFlash.appendChild(eval("img_"+list_id).cloneNode(true));

      const randomCount = getRandomInt(0, eval("copy_list_"+list_id).length-1);

      const textNode = document.createElement("div");
      textNode.textContent = eval("copy_list_"+list_id)[randomCount];
      textNode.style.textShadow = textShadows[list_id];
      textNode.style.color = copy_colors[list_id] || '#ffffff';

      textNode.style.textAlign = "center";
      textNode.style.fontSize = "10vw";
      textNode.style.fontWeight = "900";
      textNode.style.lineHeight = "1.2";

      goalFlash.appendChild(textNode);

      // Animate in
      goalFlash.style.transition = 'transform 0.3s ease-in';
      goalFlash.style.transform = 'translate(-50%, -50%) scale(1)';
      goalFlash.style.opacity = '1';

      clearTimeout(msg_setTimeout);
      msg_setTimeout = setTimeout(() => {

      goalFlash.style.transform = 'translate(-50%, -50%) scale(1)';
      isFading = false;
      goalFlash.style.opacity = '0';
      goalFlash.innerText = "";
      goalFlash.style.display = 'none';
      fade_goli_out();
      
      //ready_to_shoot = true;
      resetBall();
        show_overlay_count ++;
        if(show_overlay_count >= break_count){
          show_overlay_count = 0;
          ready_to_shoot = false;
          //show_overlay();
          show_result_Text();
        }else{
          ready_to_shoot = true;
          grabber_hand_anim(ball.position,ball.rotation.y);
        }
      
      goalFlash.innerHTML = "";
      clearTimeout(msg_setTimeout);
      
      
     
    

    }, 2400); // visible for 1 second
}

//----============---------

/***********************************
 * show_result_Text
 ***********************************/

const result_Text = document.createElement('div');

result_Text.style.color = '#BA0C2F';
result_Text.style.textAlign = 'center';
result_Text.style.position = 'absolute';
result_Text.style.top = '50%';
result_Text.style.left = '50%';
result_Text.style.transform = 'translate(-50%, -50%)';
result_Text.style.textShadow = `
  0 0 5px #ffffff,
  0 0 10px #ffffff
`;

result_Text.style.padding = '10px 20px';
result_Text.style.borderRadius = '12px';
result_Text.style.userSelect = 'none';
result_Text.style.pointerEvents = 'none';
result_Text.style.zIndex = '9996';

//result_Text.style.fontSize = 'clamp(2.8rem, 7vw, 3rem)';
//result_Text.style.fontSize = "clamp(2rem, 6vw, 3.2rem)";
result_Text.style.fontSize = "clamp(2.3rem, 6.3vw, 3.5rem)";
result_Text.style.fontFamily = 'Cherry Bomb One, system-ui';
result_Text.style.fontWeight = '400';
result_Text.style.lineHeight = '1.2';

result_Text.style.whiteSpace = 'normal';
result_Text.style.wordBreak = 'normal';
result_Text.style.maxWidth = '90vw';

result_Text.style.opacity = '0';
result_Text.style.display = 'none';



// Add it to the page
document.body.appendChild(result_Text);


let result_Text_setTimeout = null;
const result_Text_copy_list = [];
let result_Text_count = 0;
let result_Text_finished = false;

/***********************************
 * show_Result
 ***********************************/

function show_result_Text() {

  
  if(score/10 == break_count){//win copy

    result_Text_copy_list[0] = "Total striker energy!";

    //result_Text_copy_list[1] = "Your Score Is\n'"+ score + "'\nOut Of 10 Attempts";
    result_Text_copy_list[1] = "Final Score\n'"+ score + "'";

    result_Text_copy_list[2] = "Goals "+"'"+ score/10 +"/"+ break_count + "'";
    
    result_Text_copy_list[3] = "You ruled the field!";

  }else if (score == 0){//lose copy

    result_Text_copy_list[0] = "Missed the goal.";

    //result_Text_copy_list[1] = "Your Score Is\n'"+ score + "'\nOut Of 10 Attempts";
    result_Text_copy_list[1] = "Final Score\n'"+ score + "'";

    result_Text_copy_list[2] = "Goals "+"'"+score/10+"/"+ break_count + "'";
    
    result_Text_copy_list[3] = "Good try! Take another shot.";

  }else{

    result_Text_copy_list[0] = "Good try!";

    result_Text_copy_list[1] = "Final Score\n'"+ score + "'";

    result_Text_copy_list[2] = "Goals "+"'"+score/10+"/"+ break_count + "'";
    
    result_Text_copy_list[3] = "Almost famous. Almost.";

  }
  
  function splitInto3Lines(text) {
    const words = text.trim().split(/\s+/);
    const lines = ["", "", ""];

    let lineIndex = 0;

    for (let i = 0; i < words.length; i++) {
      lines[lineIndex] += (lines[lineIndex] ? " " : "") + words[i];

      // Move to next line when current line length exceeds ~⅓
      if (
        lines[lineIndex].length >
        text.length / 3 &&
        lineIndex < 2
      ) {
        lineIndex++;
      }
    }

    return lines;
  }

  function setResultText3Lines(text) {
    result_Text.innerHTML = ""; // clear previous

    const lines = splitInto3Lines(text);

    lines.forEach(line => {
      const div = document.createElement("div");
      div.textContent = line;
      div.style.lineHeight = "1.15";
      div.style.textAlign = "center";
      result_Text.appendChild(div);
      //console.log(line);
    });
    //console.log("-----------");
  }


  function result_text_transition(){

    //result_Text.innerText = result_Text_copy_list[result_Text_count];

    setResultText3Lines(result_Text_copy_list[result_Text_count]);


   // Start big and transparent
      result_Text.style.transform = 'translate(-50%, -50%) scale(1.5)';
      result_Text.style.display = 'block'
      result_Text.style.opacity = '0';
      result_Text.style.transition = 'none';

      /// Trigger reflow to reset transition
      void result_Text.offsetWidth;

      // Fade in and shrink to normal
      result_Text.style.transition = 'transform 0.3s ease-out, opacity 0.3s ease-in';
      result_Text.style.transform = 'translate(-50%, -50%) scale(1)';


      result_Text.style.opacity = '1';

      clearTimeout(result_Text_setTimeout);

      result_Text_setTimeout = setTimeout(() => {

      result_Text.style.transition = 'transform 0.3s ease-in, opacity 0.3s ease-out';
      result_Text.style.transform = 'translate(-50%, -50%) scale(1)';

      result_Text.style.opacity = '0';
      result_Text.innerText = "";
      result_Text_count++;

      if(result_Text_count < result_Text_copy_list.length){
          result_text_transition();
            
        }else{
          
          
          result_Text_count = 0;
          score = 0;
          scoreDisplay.textContent = score;
          ready_to_shoot = true;
          result_Text_finished = true;
          ready_to_shoot = true;
          grabber_hand_anim(ball.position,ball.rotation.y);
          
          
          result_Text.style.display = 'none'
          
          clearTimeout(result_Text_setTimeout);
        }


    }, 2200); // visible for 2 second

  }
  result_text_transition();


}
function disposeResult_Text() {
  if (result_Text && result_Text.parentNode) {
    result_Text.parentNode.removeChild(result_Text);
  }
}


//----




/***********************************
 *  Preload Smily Image Once
 ***********************************/

const flashIcon = new Image();
flashIcon.src = "./star_golden.png";  // <-- put your image
let iconLoaded = false;

flashIcon.onload = () => {
    iconLoaded = true;
};

    // Create the image
    //const img_1 = document.createElement("img");
    const img_1 = new Image();
    img_1.src = "https://user.cdn.mywebar.com/521765/emoji_thumbs_up_1.png";
    //img_1.style.width = "500px";
    //img_1.style.height = "500px";
    img_1.style.width = "35vw";
    img_1.style.maxWidth = "200px";
    img_1.style.height = "auto";
    img_1.style.display = "flex";
    //img_1.style.margin = "0 auto 1.5vh auto";
    img_1.style.margin = "0 auto 1vh auto";
    img_1.style.pointerEvents = "none";

    const img_2 = document.createElement("img");
    img_2.src = "https://user.cdn.mywebar.com/521765/emoji_sad_1.png";
    img_2.style.width = "25vw";
    img_2.style.maxWidth = "150px";
    img_2.style.height = "auto";
    img_2.style.display = "block";
    img_2.style.margin = "0 auto 1vh auto";
    img_2.style.pointerEvents = "none";

    const img_3 = document.createElement("img");
    img_3.src = "https://user.cdn.mywebar.com/521765/emoji_sad_1.png";
    img_3.style.width = "25vw";
    img_3.style.maxWidth = "150px";
    img_3.style.height = "auto";
    img_3.style.display = "block";
    img_3.style.margin = "0 auto 1vh auto";
    img_3.style.pointerEvents = "none";

    const img_0 = document.createElement("img");
    img_0.src = "https://user.cdn.mywebar.com/521765/emoji_sad_1.png";
    img_0.style.width = "25vw";
    img_0.style.maxWidth = "150px";
    img_0.style.height = "auto";
    img_0.style.display = "block";
    img_0.style.margin = "0 auto 1vh auto";
    img_0.style.pointerEvents = "none";


/********************************************
 *  
 ********************************************/




//
//-------------------------------------------------------fadeBall
let isFading = false;

function fadeBall() { // fadeout the ball
  if (isFading) return;
  isFading = true;
  //console.log("fadeBall is called");

  const startTime = performance.now();
  const duration = 1000; // 1.5 second
  let fadeBall_Id = null;

  
  function fadeBall_transition(){

        const elapsed = performance.now() - startTime;
        const t = elapsed / duration;

        //console.log("ball fade in progress" + "t = "+ t);
        if(ball.position.y <= 0.4){

          velocity.set(0,0,0);
          ballInFlight = false;
        }

        if (t >= 1) {
          isFading = false;
          ball.visible = false;
          // Cleanup
          //resetBall();
          cancelAnimationFrame(fadeBall_Id);
          return;
        }

        // Update scale and fade
        const scale_factor = ball_initial_scale - t * 0.1;
        ball.scale.set(scale_factor, scale_factor, scale_factor);


          for(let i = 0; i < ball_Materials.length; i++){

            ball_Materials[i].opacity = 1 - t;

          }
        

        fadeBall_Id = requestAnimationFrame(fadeBall_transition);
      }
    fadeBall_Id = requestAnimationFrame(fadeBall_transition);
}
//
//

function fadeBall_In() { // show ball
  //if (isFading) return;
  //isFading = true;
  //console.log("fadeBall is called");

  const startTime = performance.now();
  const duration = 1000; // 1.5 second
  let fadeBall_In_Id = null;

        for(let i = 0; i < ball_Materials.length; i++){

            ball_Materials[i].opacity = 1;
        }

  function fadeBall_transition(){


        const elapsed = performance.now() - startTime;
        const t = elapsed / duration;

        //console.log("ball fade in progress" + "t = "+ t);

        if (t >= 1) {
          isFading = false;
          // Cleanup
          //grabber_hand_anim(ball.position,ball.rotation.y);
          ball.scale.set(ball_initial_scale, ball_initial_scale, ball_initial_scale);
          cancelAnimationFrame(fadeBall_In_Id);
          return;
        }

        // Update position and fade
        const scale_factor =  t * 0.4;
        ball.scale.set(scale_factor, scale_factor, scale_factor);


          //for(let i = 0; i < ball_Materials.length; i++){

            //ball_Materials[i].opacity = t;

          //}
        

        fadeBall_In_Id = requestAnimationFrame(fadeBall_transition);
      }
    //fadeBall_In_Id = requestAnimationFrame(fadeBall_transition);;
}

//------ goli fade in fade out



let isFading_goli_out = false;
let isFading_goli_in = false;

function fade_goli_out() {

  //if (isFading_goli_out) return;
  //isFading_goli_out = true;
  //console.log("goli fade out is called =====");

  const startTime = performance.now();
  //const duration = 1000; // 1.5 second
  const duration = 500; // 1.5 second
 
  let fade_goli_out_Id = null;

  
  function fadeGoli_transition_out(){

        const elapsed = performance.now() - startTime;
        const t = elapsed / duration;

        //console.log("ball fade in progress" + "t = "+ t);

        if (t >= 1) {
          isFading_goli_out = false;
          // Cleanup
          //resetBall();
           //We just finished a gameplay animation → start idle loop
           
           keeperTargetX = 0;
           
           goli_mov_speed = 0;
           

           playIdleLoop();
           fade_goli_in();
          cancelAnimationFrame(fade_goli_out_Id);
          return;
        }
        // Update position and fade

          for(let i = 0; i < goli_Materials.length; i++){

            goli_Materials[i].opacity = 1 - t;

          }    

        fade_goli_out_Id = requestAnimationFrame(fadeGoli_transition_out);
      }
    fade_goli_out_Id = requestAnimationFrame(fadeGoli_transition_out);
}

function fade_goli_in() {

  goalkeeper.position.x = 0;
  keeperTargetX = 0;
  goli_mov_speed = 0;
  animation_speed = speedSlow;

  //if (isFading_goli_in) return;
  //isFading_goli_in = true;
  //console.log("goli fade in is called =====");

  const startTime = performance.now();
  //const duration = 2000; // 2 second
  const duration = 1000; // 2 second
  let fade_goli_in_Id = null;

  
  function fadeGoli_transition_in(){

        const elapsed = performance.now() - startTime;
        const t = elapsed / duration;

        //console.log("ball fade in progress" + "t = "+ t);

        if (t >= 1) {
          isFading_goli_in = false;
          // Cleanup
          //resetBall();
           //We just finished a gameplay animation → start idle loop
           //playIdleLoop();
           
           goli_mov_speed = 0.01;

          //grabber_hand_anim(ball.position,ball.rotation.y);
          cancelAnimationFrame(fade_goli_in_Id);
          return;
        }

        // Update position and fade

          for(let i = 0; i < goli_Materials.length; i++){

             goli_Materials[i].opacity = t;

          }
        

        fade_goli_in_Id = requestAnimationFrame(fadeGoli_transition_in);
      }
    fade_goli_in_Id = requestAnimationFrame(fadeGoli_transition_in);
}





//---- Implementation: 3d Confetti Burst



// ------------------ CONFETTI STORAGE ------------------
const confettiParticles = [];

// Access the Three.js library provided by MyWebAR
//const { THREE } = window; 

// The specific URL of the image you uploaded to MyWebAR
//const imageUrl = 'https://user.cdn.mywebar.com/521765/775340/star_golden.png';
//const imageUrl = 'https://user.cdn.mywebar.com/521765/776570/star_golden_purple.png';
//const imageUrl = 'https://user.cdn.mywebar.com/521765/784217/star_sparkle.png';
//const imageUrl = 'https://user.cdn.mywebar.com/521765/784217/star_golden_red.png';
const imageUrl = './star_golden.png';

let confettiBaseMaterial;
// Create and load the texture from the URL
const textureLoader = new THREE.TextureLoader();
// Optional: load a texture for star/particle look // Or null if not needed
const confettiTexture = textureLoader.load(imageUrl, 
    // The onload callback function
    (texture) => {
        //console.log('Texture loaded successfully:', texture);
        
        // Create the SpriteMaterial with the loaded texture resued for clones
        confettiBaseMaterial = new THREE.SpriteMaterial({
            map: texture || null,
            color: 0xffffff,//color: 0xad5e3b,
            transparent: true,
            depthWrite: false,
            depthTest: true,
            fog: false
        });

        // Create and add the Sprite to the scene
        //const sprite = new THREE.Sprite(confettiBaseMaterial);
        //sprite.scale.set(5, 5, 1);
        //sprite.position.set(0, 2, 0); // Position it in front of the camera
        
        // Access the MyWebAR scene and add the sprite
        // (The global scene object is typically available in the MyWebAR code environment)
        //scene.add(sprite);
    },
    // The onProgress callback (optional)
    undefined,
    // The onError callback (optional)
    (error) => {
        console.error('An error occurred while loading the texture:', error);
    }
);


//If basket is nested inside another group, use:
/*const worldPos = new THREE.Vector3();
basket.getWorldPosition(worldPos);
spawnConfettiBurst(worldPos, 80);*/

// ------------------ SPAWN FUNCTION ------------------
function spawnConfettiBurst(worldPos, count = 50) {

      // Get ball world position
  const ballWorldPos = new THREE.Vector3();
  worldPos = ball.getWorldPosition(ballWorldPos);

  for (let i = 0; i < count; i++) {
    const mat = confettiBaseMaterial.clone();
    //mat.color.setHSL(Math.random(), 1, 0.5); // random bright color

    const sprite = new THREE.Sprite(mat);
    //sprite.scale.setScalar(0.15 + Math.random() * 0.25); // particle size
    sprite.scale.setScalar(0.35 + Math.random() * 0.35); // particle size
    sprite.position.copy(worldPos);
    //console.log("sprite.scale.x = "+sprite.scale.x);

    scene.add(sprite);

    confettiParticles.push({
      sprite,
      velocity: new THREE.Vector3(
        (Math.random() - 0.5) * 4/1,  // random spread X
        Math.random() * 8/1,          // mostly upward
        //(Math.random() - 0.5) * 4/1   // random spread Z
        (Math.random() - 1.0) * 4/1   // random spread Z // confetti comes towards user , increasing number from 1.5 to 2.5 brings the confetti more close to the screen
      ),
      life: 120 // frames to live (~1.5s at 60fps)
    });
  }
}

// ------------------ UPDATE FUNCTION ------------------
function updateConfetti() {
  for (let i = confettiParticles.length - 1; i >= 0; i--) {
    const p = confettiParticles[i];

    // Apply velocity
    p.sprite.position.addScaledVector(p.velocity, 0.05);

    // Simulate gravity
    p.velocity.y -= 0.02;

    // Fade out
    p.sprite.material.opacity = p.life / 90;

    p.life--;
    if (p.life <= 0) {
      scene.remove(p.sprite);
      confettiParticles.splice(i, 1);
    }
  }
}



//---------------
//---------------



//---- Subtle Camera Shake
function shakeCamera(intensity = 0.09, duration = 100) {
  const originalPosition = camera.position.clone();

  const shake = () => {
    camera.position.x = originalPosition.x + (Math.random() - 0.5) * intensity;
    camera.position.y = originalPosition.y + (Math.random() - 0.5) * intensity;
    camera.position.z = originalPosition.z + (Math.random() - 0.5) * intensity;
  };

  const interval = setInterval(shake, 16);

  setTimeout(() => {
    clearInterval(interval);
    camera.position.copy(originalPosition);
  }, duration);
}

    let speedNormal = 1.3;//1.5;
    const speedSlow   = 0.5;//0.15; // 25% speed for slow motion
    let animation_speed = 1;

function animate() {
  //requestAnimationFrame(animate);
  main_anim_Id = requestAnimationFrame(animate);
  const delta = clock.getDelta();

  // Animate goalkeeper if loaded
  if (keeperMixer) {
    action.timeScale = animation_speed;
    keeperMixer.update(delta);
    goalkeeper.position.x += (keeperTargetX - goalkeeper.position.x) * goli_mov_speed;
  }



  //if (ballInFlight) {
    updateBallPosition(delta);
  //}

  updateConfetti();

  renderer.render(scene, camera);
}

//animate();










    //show_Countdown();
    //scoreUI.style.display = 'block';
        countDown_finished = true;
        //ready_to_shoot = true;


function getIntersects(x, y) {
  mouse.x = (x / window.innerWidth) * 2 - 1;
  mouse.y = - (y / window.innerHeight) * 2 + 1;
  raycaster.setFromCamera(mouse, camera);
  //return raycaster.intersectObject(ball);
   return raycaster.intersectObject(ground);
}


/**
 * Mouse/single touch start event
 */


function pointerdown( event ) {

    if(!countDown_finished) return

     if(ready_to_shoot){
     const hits = getIntersects(event.clientX, event.clientY);
         if (hits.length > 0){

            isDragging = true;
              ballSelected = true;
              dragStart = { x: event.clientX, y: event.clientY };
              cancelAnimationFrame(hand_grabber_anim_Id);
              hand_grabber_Mesh.visible = false;

              if (trajectoryMarkers.length>0){
                 disposeTrajectoryMarkers();
              }
         }
      }           
}

function onTouchStart(event) {
  if (event.touches.length === 1) {
    const touch = event.touches[0];
    const hits = getIntersects(touch.clientX, touch.clientY);
    if (hits.length > 0 && ready_to_shoot) {
      isDragging = true;
      ballSelected = true;
      dragStart = { x: touch.clientX, y: touch.clientY };
      cancelAnimationFrame(hand_grabber_anim_Id);
      hand_grabber_Mesh.visible = false;

      if (trajectoryMarkers.length>0){
         disposeTrajectoryMarkers();
      }

    }
  }
}

/**
 * Mouse/single touch end event
 */
function pointerup( event ) {
  // ...
  //console.log('🏁 touchend fired');
  //if (isDragging && ballSelected && !ballInFlight) {
  if (isDragging && ready_to_shoot) {
    isDragging = false;
    //ballSelected = false;
    //console.log("currentForce = "+ currentForce);
    if(currentForce<0.5){
      currentForce = 0.5;
    }
    shootBall();
    
    }
}

function onTouchEnd(event) {
  if (isDragging && ready_to_shoot) {
    isDragging = false;
    ballSelected = false;

    if(currentForce<0.5){
      currentForce = 0.5;
    }
    shootBall();    
  }
}


/**
 * Mouse/single touch drag event
 */
function pointermove( event ) {
    /*
  // ...
  //console.log(event);
  //console.log('🔥 touchmove fired' + event.x +" == "+ event.y);
  //if (isDragging && ballSelected && !ballInFlight) {

  const hits = getIntersects(event.clientX, event.clientY);
  if (hits.length > 0 && ready_to_shoot) {
    //renderer.domElement.style.cursor = 'pointer';
  } else {
    //renderer.domElement.style.cursor = 'default';
  }

  if (isDragging && ready_to_shoot) {
    const dy = dragStart.y - event.clientY;
    currentForce = THREE.MathUtils.clamp(dy / 50, 0.01, 5.5);
        //currentForce = THREE.MathUtils.clamp(dy / 100, 0.01, 1.0);
    //console.log("dy = "+ dy +"==="+ "currentForce = " + currentForce);
    //console.log("currentForce = "+ currentForce + " currentSwing = "+ currentSwing);
    if(currentForce>1.15){
      currentForce = 1.15;
    }

    // For swing: horizontal drag for swing
    const dx = event.clientX - dragStart.x;
    //currentSwing = THREE.MathUtils.clamp(dx / 200, -0.5, 0.5);
    currentSwing = THREE.MathUtils.clamp(dx / 400, -1, 1);
    currentAngle = currentSwing;
    //createTrajectoryLine();
     
    }
*/
}

function onTouchMove(event) {
    
      /*if (isDragging && ready_to_shoot && event.touches.length === 1) {
        const touch = event.touches[0];
        const dy = dragStart.y - touch.clientY;
        currentForce = THREE.MathUtils.clamp(dy / 50, 0.01, 5.5);
        
        //if(Math.abs(currentSwing) > 0.5){
            //currentSwing = 0.5*(currentSwing / Math.abs(currentSwing));
            //console.log( -1 % 5 );
             
        //}
        //console.log(int(currentSwing % (currentSwing)));
        currentAngle = currentSwing;
        createTrajectoryLine();
        //console.log("currentForce = "+ currentForce + " currentSwing = "+ currentSwing);
       
      }*/

  if (isDragging && ready_to_shoot && event.touches.length === 1) {
    const touch = event.touches[0];
    const dy = dragStart.y - touch.clientY;
    currentForce = THREE.MathUtils.clamp(dy / 400, 0.5, 1.5);
    const dx = touch.clientX - dragStart.x;
    currentSwing = THREE.MathUtils.clamp(dx / 400, -0.45, 0.45);
    currentAngle = currentSwing;
    if(currentForce>1.015){
      //currentForce = 1.015;
    }
    createTrajectoryLine();
    //console.log("currentForce = "+ currentForce + " currentSwing = "+ currentSwing);
  }
       
    
    
}


// Prevent Chrome from hijacking the gesture
document.documentElement.style.touchAction = "none";
document.body.style.touchAction = "none";

function onWindowResize() {
  /*camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth / window.innerHeight, renderer.getSize().height);*/


  camera.aspect = window.innerWidth/window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight);
  //renderer.setSize(window.innerWidth / window.innerHeight, renderer.getSize().height);

}

  // Input listeners
  window.addEventListener('resize', onWindowResize);
  renderer.domElement.addEventListener('pointerdown', pointerdown);
  renderer.domElement.addEventListener('mousemove', pointermove);
  renderer.domElement.addEventListener('mouseup', pointerup);
  renderer.domElement.addEventListener('touchstart', onTouchStart);
  renderer.domElement.addEventListener('touchmove', onTouchMove);
  renderer.domElement.addEventListener('touchend', onTouchEnd);

init_1();

let currentAttempt = 0;

function registerShot(isGoal) {
  if (currentAttempt >= 5) return;

  const attempt = document.querySelectorAll(".attempt")[currentAttempt];

  const img = document.createElement("img");
  img.src = isGoal ? "./success-slot-icon-v2.png" : "./fail-slot-icon-v2.png";
  img.className = "resultIcon";

  attempt.appendChild(img);

  currentAttempt++;
}

const scorePanel = document.querySelector(".scorePanel");
const ratingPanel = document.querySelector(".ratingPanel");

function showScorePanel() {
  //scorePanel.classList.add("visible");
  scorePanel.style.display = "block";
  ratingPanel.style.display = "block";

}

function hideScorePanel() {
  //scorePanel.classList.remove("visible");
  scorePanel.style.display = "none";
  ratingPanel.style.display = "none";
}
//hideScorePanel();

//clears the goal scores
function reset_Score_Panel() {
  document.querySelectorAll(".attempt").forEach(a => a.innerHTML = "");
  currentAttempt = 0;
}


//registerShot(true);  // goal
//registerShot(false); // miss

const rankEl = document.querySelector(".rankValue");

function updateRank(newRank) {
  rankEl.textContent = newRank;
}
//updateRank(1325);

//---
//const rankEl = document.querySelector(".rankValue");

let currentRating = 0;   // starting rating
let animationFrame = null;

function animateRating(targetRating, duration = 1800) {

  targetRating = currentRating + targetRating;

  cancelAnimationFrame(animationFrame);

  const startRating = currentRating;
  const difference = targetRating - startRating;
  const startTime = performance.now();

  function update(now) {
    //console.log("update running");
    const elapsed = now - startTime;
    const progress = Math.min(elapsed / duration, 1);

    // Ease-out effect (smooth slowdown near end)
    const easeOut = 1 - Math.pow(1 - progress, 3);

    currentRating = Math.round(startRating + difference * easeOut);
    rankEl.textContent = currentRating;

    if (progress < 1) {
         //console.log("animateRating running");
      animationFrame = requestAnimationFrame(update);
    } else {
        //console.log("animateRating done");
      currentRating = targetRating;
      rankEl.textContent = targetRating;
    }
  }

  animationFrame = requestAnimationFrame(update);
}
animateRating(0);  // smoothly increase to 1350



//let animationFrame = null;

/*function animateRating(startValue, endValue, duration = 800) {

  cancelAnimationFrame(animationFrame);

  const startTime = performance.now();
  const difference = endValue - startValue;

  function update(now) {
    const elapsed = now - startTime;
    const progress = Math.min(elapsed / duration, 1);

    // Linear (completely smooth, no slow-down)
    const value = startValue + difference * progress;

    rankEl.textContent = Math.floor(value);

    if (progress < 1) {
      animationFrame = requestAnimationFrame(update);
    } else {
      rankEl.textContent = endValue;
    }
  }

  animationFrame = requestAnimationFrame(update);
}
animateRating(120, 1350, 1000);*/
//------
let score_multiplyer = 1;
function calculate_points(){

}
// Points animation
function createScorePopup() {//scopop
  
  //const text =  (1000*score_multiplyer)+Math.round(currentForce*1000)+Math.round(Math.abs(currentAngle*1000));
  const text =  100*score_multiplyer;


  animateRating(text);
  //console.log("-----pop up is called");

  // Create a canvas to draw text
  const point_canvas = document.createElement('canvas');
  const ctx = point_canvas.getContext('2d');
  const size = 256;
  
  point_canvas.width = point_canvas.height = size;

  ctx.font = '48px Arial';
  ctx.fillStyle = 'yellow';
  ctx.strokeStyle = 'black';
  ctx.lineWidth = 2;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.strokeText(text, size / 2, size / 2);
  ctx.fillText(text, size / 2, size / 2);
  point_canvas.style.zIndex = "99999";  // higher = appears on top

  //ctx.fontSize = 'clamp(5rem, 7vw, 6rem)';
  //ctx.fontSize = '48px';
  //ctx.font = "200px Cherry Bomb One, system-ui";

  ctx.fontWeight = '400';//ff
  //ctx.fontFamily ='Cherry Bomb One', 'system-ui';//'sans-serif';

  // Create texture from canvas
  const texture = new THREE.CanvasTexture(point_canvas);
  texture.needsUpdate = true;

  // Create sprite material
  const material = new THREE.SpriteMaterial({map:texture , transparent:true, depthTest:false, depthWrite:false});
  const sprite = new THREE.Sprite(material);
  
  // Set initial position
  //sprite.position.copy(basket.position);
  sprite.position.set(0,3,11);
  //console.log("basket.position = "+ basket.position.x , basket.position.y, basket.position.z);
  //sprite.scale.set(15, 15, 15);
  //sprite.position.set(0,3,2);
  sprite.scale.set(10, 10, 10);
  sprite.renderOrder = 99998;

  scene.add(sprite);

  // Animation data
  const startTime = performance.now();
  const duration = 2000; // 1 second
  let frameId = null;

  function animatePopup() {
    const elapsed = performance.now() - startTime;
    const t = elapsed / duration;

    if (t >= 1) {
      // Cleanup

      cancelAnimationFrame(frameId);
      scene.remove(sprite);
      material.map.dispose();
      material.dispose();
      return;
    }

    // Update position and fade
    sprite.position.y += 0.02;
    //material.opacity = 1 - t;

    frameId = requestAnimationFrame(animatePopup);
  }

  frameId = requestAnimationFrame(animatePopup);
  
}


    


//--------------------- xx ----- xx ----- xx ------------------------------------
})();

