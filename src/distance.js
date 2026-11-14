// Face-to-screen distance from the webcam via MediaPipe Face Landmarker.
// Everything runs locally: the library, wasm and model are loaded from vendor/.
// No frames or coordinates leave the browser and nothing is written to disk.

const VENDOR = new URL('../vendor/', import.meta.url);

export const WINDOW_MS = 500;
export const MAX_HEAD_TURN_DEG = 15;
// Outer eye corners in the 478-point face mesh (subject's left / right).
const LEFT_OUTER = 263;
const RIGHT_OUTER = 33;

const state = {
  landmarker: null,
  video: null,
  rafId: 0,
  lastVideoTime: -1,
  samples: [], // { t, span } from valid frames only
  lastValidAt: null, // performance.now() of the last valid frame
  frameReason: 'no_face', // null when the latest processed frame was valid
  corners: [], // [{ left: {x,y}, right: {x,y} }] per face, video pixels
  participant: null,
};

export function median(values) {
  if (values.length === 0) return null;
  const s = [...values].sort((a, b) => a - b);
  const mid = s.length >> 1;
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

// Angle between the face's forward axis and the camera axis, in degrees.
// R22 (data[10]) sits at the same index in row- and column-major layouts, and
// for a uniformly scaled rotation every row and column has the same norm.
export function headTurnDeg(matrix) {
  const d = matrix.data;
  const scale = Math.hypot(d[8], d[9], d[10]);
  if (!scale) return 90;
  const c = Math.min(1, Math.abs(d[10]) / scale);
  return (Math.acos(c) * 180) / Math.PI;
}

// Pure per-frame evaluation: { reason, spanPx, corners }.
export function evaluateFrame(result, videoWidth, videoHeight) {
  const faces = result.faceLandmarks || [];
  const corners = faces.map((lm) => ({
    left: { x: lm[LEFT_OUTER].x * videoWidth, y: lm[LEFT_OUTER].y * videoHeight },
    right: { x: lm[RIGHT_OUTER].x * videoWidth, y: lm[RIGHT_OUTER].y * videoHeight },
  }));
  if (faces.length === 0) return { reason: 'no_face', spanPx: null, corners };
  if (faces.length > 1) return { reason: 'two_faces', spanPx: null, corners };
  const matrix = (result.facialTransformationMatrixes || [])[0];
  if (matrix && headTurnDeg(matrix) > MAX_HEAD_TURN_DEG) {
    return { reason: 'head_turned', spanPx: null, corners };
  }
  const { left, right } = corners[0];
  return { reason: null, spanPx: Math.hypot(left.x - right.x, left.y - right.y), corners };
}

function prune(now) {
  const from = now - WINDOW_MS;
  while (state.samples.length && state.samples[0].t < from) state.samples.shift();
}

function processFrame(result, now) {
  const f = evaluateFrame(result, state.video.videoWidth, state.video.videoHeight);
  state.corners = f.corners;
  state.frameReason = f.reason;
  if (f.reason === null) {
    state.samples.push({ t: now, span: f.spanPx });
    state.lastValidAt = now;
  }
  prune(now);
}

async function createLandmarker() {
  const { FilesetResolver, FaceLandmarker } = await import(
    new URL('mediapipe/vision_bundle.mjs', VENDOR).href
  );
  const fileset = await FilesetResolver.forVisionTasks(new URL('mediapipe/wasm', VENDOR).href);
  const options = (delegate) => ({
    baseOptions: {
      modelAssetPath: new URL('models/face_landmarker.task', VENDOR).href,
      delegate,
    },
    runningMode: 'VIDEO',
    numFaces: 2, // so a second face can be reported instead of ignored
    outputFacialTransformationMatrixes: true,
  });
  try {
    return await FaceLandmarker.createFromOptions(fileset, options('GPU'));
  } catch (gpuError) {
    console.warn('Face Landmarker: GPU delegate failed, using CPU', gpuError);
    return FaceLandmarker.createFromOptions(fileset, options('CPU'));
  }
}

function loop() {
  const v = state.video;
  if (v.readyState >= 2 && v.currentTime !== state.lastVideoTime) {
    state.lastVideoTime = v.currentTime;
    const now = performance.now();
    processFrame(state.landmarker.detectForVideo(v, now), now);
  }
  state.rafId = requestAnimationFrame(loop);
}

// Requests the camera, attaches it to videoEl and starts per-frame processing.
// Calling it again while running is a no-op.
export async function startDistance(videoEl) {
  if (state.video) return;
  state.video = videoEl;
  try {
    const stream = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: 'user', width: { ideal: 1280 }, height: { ideal: 720 } },
      audio: false,
    });
    videoEl.muted = true;
    videoEl.playsInline = true;
    videoEl.srcObject = stream;
    await videoEl.play();
    state.landmarker = await createLandmarker();
  } catch (e) {
    state.video = null;
    throw e;
  }
  state.rafId = requestAnimationFrame(loop);
}

const kKey = (participant) => `cam_k_${participant}`;

export function getK(participant) {
  const v = Number(localStorage.getItem(kKey(participant)));
  return Number.isFinite(v) && v > 0 ? v : null;
}

export function setParticipant(participant) {
  state.participant = participant;
}

// { mm, ageMs, ok, reason, eyeSpanPx }. eyeSpanPx is the 0.5 s median; mm is
// null unless ok. ageMs is null before the first valid frame.
export function getDistance(participant = state.participant) {
  const now = performance.now();
  prune(now);
  const ageMs = state.lastValidAt === null ? null : now - state.lastValidAt;
  const eyeSpanPx = median(state.samples.map((s) => s.span));
  const k = participant ? getK(participant) : null;
  let reason = state.frameReason;
  if (!reason && (ageMs === null || ageMs > WINDOW_MS)) reason = 'stale';
  if (!reason && !k) reason = 'not_calibrated';
  const ok = reason === null;
  return { mm: ok ? k / eyeSpanPx : null, ageMs, ok, reason, eyeSpanPx };
}

// k = median eyeSpanPx * knownMm, stored per participant. Throws if there is no
// valid recent measurement to calibrate from.
export function calibrateCamera(participant, knownMm) {
  if (!participant) throw new Error('participant is required');
  if (!(knownMm > 0)) throw new Error('knownMm must be a positive number');
  // With no participant there is no k, so a good measurement reports exactly
  // 'not_calibrated'; any other reason means the face reading is unusable.
  const d = getDistance(null);
  if (d.reason !== 'not_calibrated') throw new Error(`cannot calibrate: ${d.reason}`);
  const k = d.eyeSpanPx * knownMm;
  localStorage.setItem(kKey(participant), String(k));
  state.participant = participant;
  return k;
}

// Debug view: video with eye-corner points and the current distance, large.
export function mountDistanceDebug(container) {
  container.innerHTML = `
    <div class="dist-debug" style="position:relative;display:inline-block;max-width:100%">
      <video style="display:block;max-width:100%;transform:scaleX(-1)"></video>
      <canvas style="position:absolute;inset:0;width:100%;height:100%;transform:scaleX(-1)"></canvas>
      <div class="dist-readout" style="position:absolute;left:8px;top:8px;font:700 40px system-ui;color:#fff;text-shadow:0 0 6px #000"></div>
    </div>`;
  const video = container.querySelector('video');
  const canvas = container.querySelector('canvas');
  const readout = container.querySelector('.dist-readout');
  const ctx = canvas.getContext('2d');
  const draw = () => {
    if (!container.isConnected) return;
    if (video.videoWidth && canvas.width !== video.videoWidth) {
      canvas.width = video.videoWidth;
      canvas.height = video.videoHeight;
    }
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.fillStyle = state.frameReason ? '#f44' : '#3f3';
    for (const { left, right } of state.corners) {
      for (const p of [left, right]) {
        ctx.beginPath();
        ctx.arc(p.x, p.y, 5, 0, 2 * Math.PI);
        ctx.fill();
      }
    }
    const d = getDistance();
    readout.textContent = d.ok ? `${Math.round(d.mm)} mm` : d.reason;
    requestAnimationFrame(draw);
  };
  const started = startDistance(video).then(() => requestAnimationFrame(draw));
  return { video, started };
}
