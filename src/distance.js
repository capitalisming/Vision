/**
 * Eye-to-screen distance from the front camera (MediaPipe Face Landmarker).
 *
 * Principle (pinhole camera): an object of fixed physical size S at distance d images to
 * s = f·S/d pixels, so d = (f·S)/s = k/s. The constant k is personal and per device: it is
 * measured once at a tape-measured distance d0, k = s0 · d0. Using the outer eye corners
 * (a fixed anatomical span) instead of an assumed iris diameter removes the need for
 * population averages.
 *
 * Everything runs on device. Frames never leave the browser and are never written to disk:
 * only the derived numbers (pixel span, millimetres, yaw) leave this module.
 *
 * CONTRACT
 *   await startDistance(videoEl, { participant })
 *   calibrateCamera(knownMm, participant?)  -> { k, knownMm, ... }
 *   getDistance() -> { mm, ageMs, ok, reason }
 *   reason: 'no_face' | 'two_faces' | 'head_turned' | 'stale' | 'not_calibrated'
 *
 * The distance is the median eye span of the last 0.5 s, so a single bad frame cannot move
 * the number. Calibration is stored per participant in localStorage under cam_k_<id>.
 */

/** Landmark indices of the outer eye corners in the 478-point face mesh. */
export const EYE_OUTER_A = 33;
export const EYE_OUTER_B = 263;
/** Landmark index of the nose tip (used only by the coarse yaw fallback). */
export const NOSE_TIP = 1;

/** Temporal window for the median eye span. */
export const WINDOW_MS = 500;
/** A measurement older than this is not usable. */
export const STALE_MS = 500;
/** Maximum head yaw; beyond this the eye span is biased by perspective. */
export const MAX_YAW_DEG = 15;
/** Frames per second cap for the landmarker (phones get hot at 60 fps). */
const MAX_FPS = 30;

const VENDOR = new URL('../vendor/', import.meta.url);
const WASM_PATH = new URL('tasks-vision/wasm', VENDOR).href;
const MODEL_PATH = new URL('models/face_landmarker.task', VENDOR).href;

let visionModule = null;
/** Loaded lazily so that this module can be imported by tests without a browser. */
function loadVision() {
  visionModule ??= import('../vendor/tasks-vision/vision_bundle.mjs').catch((err) => {
    visionModule = null;
    throw new Error(`MediaPipe Face Landmarker could not be loaded from vendor/: ${err.message}`);
  });
  return visionModule;
}

let landmarkerPromise = null;
function getLandmarker() {
  landmarkerPromise ??= (async () => {
    const { FaceLandmarker, FilesetResolver } = await loadVision();
    const fileset = await FilesetResolver.forVisionTasks(WASM_PATH);
    const options = (delegate) => ({
      baseOptions: { modelAssetPath: MODEL_PATH, delegate },
      runningMode: 'VIDEO',
      // Two faces so that a second person in the frame can be reported, not silently ignored.
      numFaces: 2,
      minFaceDetectionConfidence: 0.5,
      minFacePresenceConfidence: 0.5,
      minTrackingConfidence: 0.5,
      outputFaceBlendshapes: false,
      outputFacialTransformationMatrixes: true,
    });
    try {
      return await FaceLandmarker.createFromOptions(fileset, options('GPU'));
    } catch {
      return await FaceLandmarker.createFromOptions(fileset, options('CPU'));
    }
  })().catch((err) => {
    landmarkerPromise = null;
    throw err;
  });
  return landmarkerPromise;
}

const state = {
  video: null,
  stream: null,
  landmarker: null,
  running: false,
  raf: 0,
  lastDetectMs: 0,
  lastFrame: null,
  samples: [],
  participant: 'P01',
  calib: null,
  debugHost: null,
  onFrame: null,
  lastError: null,
};

const nowMs = () =>
  typeof performance !== 'undefined' && typeof performance.now === 'function' ? performance.now() : Date.now();

/** Median of the finite numbers in `values` (null for an empty list). */
export function median(values) {
  const xs = (values ?? []).filter((v) => typeof v === 'number' && Number.isFinite(v)).sort((a, b) => a - b);
  if (xs.length === 0) return null;
  const mid = xs.length >> 1;
  return xs.length % 2 ? xs[mid] : (xs[mid - 1] + xs[mid]) / 2;
}

/**
 * Outer-corner eye span in video pixels.
 * @param {Array<{x:number,y:number}>} landmarks normalised MediaPipe landmarks.
 */
export function eyeSpanPxFromLandmarks(landmarks, frameW, frameH) {
  if (!landmarks || landmarks.length <= Math.max(EYE_OUTER_A, EYE_OUTER_B)) return null;
  const a = landmarks[EYE_OUTER_A];
  const b = landmarks[EYE_OUTER_B];
  if (!a || !b) return null;
  const left = { x: a.x * frameW, y: a.y * frameH };
  const right = { x: b.x * frameW, y: b.y * frameH };
  const span = Math.hypot(right.x - left.x, right.y - left.y);
  return { span, left, right };
}

/**
 * Head yaw in degrees from MediaPipe's facial transformation matrix.
 * For a pure yaw the result is |yaw| under either row-major or column-major storage
 * (the sign differs, the magnitude does not), which is all the 15° rule needs.
 */
export function yawFromMatrix(matrix) {
  const d = matrix?.data;
  if (!d || d.length < 11) return null;
  const degrees = (Math.atan2(d[2], d[0]) * 180) / Math.PI;
  const abs = Math.abs(degrees);
  return abs > 90 ? 180 - abs : abs;
}

/**
 * Coarse yaw fallback when the transformation matrix is unavailable: nose-tip offset from
 * the eye midpoint, normalised by face width. Only used to avoid a false "straight ahead".
 */
export function yawFromLandmarks(landmarks) {
  if (!landmarks || landmarks.length < 455) return null;
  const nose = landmarks[NOSE_TIP];
  const cheekL = landmarks[234];
  const cheekR = landmarks[454];
  const eyeL = landmarks[EYE_OUTER_A];
  const eyeR = landmarks[EYE_OUTER_B];
  const faceW = Math.abs(cheekR.x - cheekL.x);
  if (!(faceW > 1e-6)) return null;
  const eyeMidX = (eyeL.x + eyeR.x) / 2;
  const offset = (nose.x - eyeMidX) / faceW; // 0 when the head faces the camera
  return Math.min(90, Math.abs(offset) * 150);
}

/** localStorage helpers: private mode can throw, a camera must keep working anyway. */
function readCalibration(participant) {
  try {
    const raw = localStorage.getItem(`cam_k_${participant}`);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    return parsed && Number.isFinite(parsed.k) && parsed.k > 0 ? parsed : null;
  } catch {
    return null;
  }
}

function writeCalibration(participant, calib) {
  try {
    localStorage.setItem(`cam_k_${participant}`, JSON.stringify(calib));
  } catch {
    /* storage full or blocked: calibration still applies until the page is closed */
  }
}

function currentK() {
  if (!state.calib) return null;
  const w = state.video?.videoWidth;
  // Same sensor, different stream resolution: k scales linearly with frame width.
  const scale = w && state.calib.frameW ? w / state.calib.frameW : 1;
  return state.calib.k * scale;
}

/** Select the participant whose personal k is used. Loads it from localStorage. */
export function setParticipant(participant) {
  state.participant = String(participant || 'P01');
  state.calib = readCalibration(state.participant);
  return state.calib;
}

export function getParticipant() {
  return state.participant;
}

export function getCalibration() {
  return state.calib ? { ...state.calib } : null;
}

/** Forget one participant's calibration (used by the calibration screen). */
export function resetCalibration(participant = state.participant) {
  try {
    localStorage.removeItem(`cam_k_${participant}`);
  } catch {
    /* ignore */
  }
  if (participant === state.participant) state.calib = null;
}

let startingPromise = null;

/**
 * Start the camera and the per-frame landmark loop.
 * @param {HTMLVideoElement} videoEl
 * @param {{participant?: string, onFrame?: Function}} [options]
 */
export async function startDistance(videoEl, options = {}) {
  if (!videoEl || typeof videoEl !== 'object') throw new TypeError('startDistance(videoEl): video element required');
  if (state.running && state.video === videoEl) return api;
  if (startingPromise) return startingPromise;

  startingPromise = (async () => {
    stopDistance();
    state.video = videoEl;
    state.onFrame = options.onFrame ?? null;
    setParticipant(options.participant ?? state.participant);

    state.landmarker = await getLandmarker();

    state.stream = await navigator.mediaDevices.getUserMedia({
      audio: false,
      video: {
        facingMode: 'user',
        width: { ideal: 1280 },
        height: { ideal: 720 },
      },
    });
    videoEl.srcObject = state.stream;
    videoEl.muted = true;
    videoEl.playsInline = true;
    await videoEl.play().catch(() => {
      /* autoplay may be blocked; the loop waits for readyState >= 2 anyway */
    });

    state.running = true;
    state.lastDetectMs = 0;
    state.raf = requestAnimationFrame(loop);
    return api;
  })();

  try {
    return await startingPromise;
  } finally {
    startingPromise = null;
  }
}

function loop() {
  if (!state.running) return;
  state.raf = requestAnimationFrame(loop);

  const v = state.video;
  if (!state.landmarker || !v || v.readyState < 2 || !v.videoWidth) return;
  const t = nowMs();
  if (t - state.lastDetectMs < 1000 / MAX_FPS) return;
  state.lastDetectMs = t;

  let result;
  try {
    result = state.landmarker.detectForVideo(v, t);
  } catch (err) {
    state.lastError = err;
    return;
  }
  handleResult(result, t);
  drawDebug();
}

function handleResult(result, t) {
  const v = state.video;
  const frameW = v.videoWidth;
  const frameH = v.videoHeight;
  const faces = result?.faceLandmarks?.length ?? 0;

  const frame = {
    t,
    faces,
    frameW,
    frameH,
    spanPx: null,
    yawDeg: null,
    yawSource: null,
    eyeLeft: null,
    eyeRight: null,
  };

  if (faces === 1) {
    const landmarks = result.faceLandmarks[0];
    const span = eyeSpanPxFromLandmarks(landmarks, frameW, frameH);
    const matrixYaw = yawFromMatrix(result.facialTransformationMatrixes?.[0]);
    const yaw = matrixYaw ?? yawFromLandmarks(landmarks);
    if (span) {
      frame.spanPx = span.span;
      frame.eyeLeft = span.left;
      frame.eyeRight = span.right;
    }
    frame.yawDeg = yaw;
    frame.yawSource = matrixYaw == null ? (yaw == null ? null : 'landmarks') : 'matrix';

    // Samples taken while the head is turned would bias the median, so they are skipped.
    if (frame.spanPx != null && frame.spanPx > 0 && (yaw == null || yaw <= MAX_YAW_DEG)) {
      state.samples.push({ t, span: frame.spanPx, yaw: yaw ?? 0 });
    }
  }

  state.samples = state.samples.filter((s) => t - s.t <= WINDOW_MS);
  state.lastFrame = frame;
  if (state.onFrame) state.onFrame(frame, getDistance());
}

/**
 * Current distance.
 * @returns {{mm: number|null, ageMs: number|null, ok: boolean, reason: string|null,
 *            eyeSpanPx: number|null, yawDeg: number|null}}
 */
export function getDistance() {
  const now = nowMs();
  const frame = state.lastFrame;
  const ageMs = frame ? Math.round(now - frame.t) : null;
  const empty = { mm: null, ageMs, ok: false, reason: null, eyeSpanPx: null, yawDeg: frame?.yawDeg ?? null };

  if (!state.calib) return { ...empty, reason: 'not_calibrated' };
  if (!frame || frame.faces === 0) return { ...empty, reason: 'no_face' };
  if (frame.faces > 1) return { ...empty, reason: 'two_faces' };
  if (frame.yawDeg != null && frame.yawDeg > MAX_YAW_DEG) return { ...empty, reason: 'head_turned' };

  const fresh = state.samples.filter((s) => now - s.t <= WINDOW_MS);
  if (fresh.length === 0 || ageMs == null || ageMs > STALE_MS) return { ...empty, reason: 'stale' };

  const span = median(fresh.map((s) => s.span));
  const k = currentK();
  if (!k || !span) return { ...empty, reason: 'stale' };

  return {
    mm: Math.round(k / span),
    ageMs,
    ok: true,
    reason: null,
    eyeSpanPx: span,
    yawDeg: frame.yawDeg,
  };
}

/**
 * Calibrate at a tape-measured distance: k = median eye span (0.5–1 s) · knownMm.
 * @param {number} knownMm distance from the eyes to the screen, measured by hand.
 * @param {string} [participant] defaults to the selected participant.
 */
export function calibrateCamera(knownMm, participant = state.participant) {
  const d = Number(knownMm);
  if (!Number.isFinite(d) || d < 150 || d > 2000) {
    throw new Error('Known distance must be between 150 and 2000 mm');
  }
  if (!state.running || !state.video) throw new Error('Start the camera before calibrating');
  if (!state.lastFrame || state.lastFrame.faces !== 1) throw new Error('Exactly one face must be visible');

  const t = nowMs();
  const span = median(
    state.samples.filter((s) => t - s.t <= 1000 && (s.yaw ?? 0) <= MAX_YAW_DEG).map((s) => s.span),
  );
  if (!span || span <= 0) throw new Error('No stable eye measurement — look straight at the camera');

  const calib = {
    k: span * d,
    knownMm: d,
    eyeSpanPx: span,
    frameW: state.video.videoWidth,
    frameH: state.video.videoHeight,
    participant: String(participant),
    at: new Date().toISOString(),
  };
  state.participant = String(participant);
  state.calib = calib;
  writeCalibration(state.participant, calib);
  return { ...calib };
}

/** Stop the camera, the loop and clear per-frame state (calibration stays in storage). */
export function stopDistance() {
  state.running = false;
  if (state.raf) cancelAnimationFrame(state.raf);
  state.raf = 0;
  state.stream?.getTracks().forEach((track) => track.stop());
  state.stream = null;
  if (state.video) state.video.srcObject = null;
  state.samples = [];
  state.lastFrame = null;
  state.lastError = null;
}

/** Last raw frame (for the debug view and distance_check.csv). */
export function getLastFrame() {
  return state.lastFrame ? { ...state.lastFrame } : null;
}

export function isRunning() {
  return state.running;
}

/**
 * Debug view: an absolutely positioned canvas over the video, eye corners joined by a line
 * and the current distance in large type. Pass null to remove it.
 */
export function setDebugHost(host) {
  state.debugHost = host || null;
  if (!host) {
    document.querySelectorAll('canvas.nvm-debug').forEach((c) => c.remove());
  }
}

function drawDebug() {
  const host = state.debugHost;
  const frame = state.lastFrame;
  if (!host || !frame) return;

  let canvas = host.querySelector('canvas.nvm-debug');
  if (!canvas) {
    canvas = document.createElement('canvas');
    canvas.className = 'nvm-debug';
    host.appendChild(canvas);
  }
  if (canvas.width !== frame.frameW || canvas.height !== frame.frameH) {
    canvas.width = frame.frameW;
    canvas.height = frame.frameH;
  }
  const ctx = canvas.getContext('2d');
  if (!ctx) return;
  ctx.clearRect(0, 0, canvas.width, canvas.height);

  const scale = canvas.height / 480;
  if (frame.eyeLeft && frame.eyeRight) {
    ctx.strokeStyle = '#00e5ff';
    ctx.fillStyle = '#00e5ff';
    ctx.lineWidth = Math.max(2, 3 * scale);
    ctx.beginPath();
    ctx.moveTo(frame.eyeLeft.x, frame.eyeLeft.y);
    ctx.lineTo(frame.eyeRight.x, frame.eyeRight.y);
    ctx.stroke();
    for (const p of [frame.eyeLeft, frame.eyeRight]) {
      ctx.beginPath();
      ctx.arc(p.x, p.y, Math.max(4, 6 * scale), 0, Math.PI * 2);
      ctx.fill();
    }
  }

  const d = getDistance();
  const label = d.ok ? `${d.mm} mm` : `${d.reason ?? 'no data'}`;
  const font = Math.max(18, Math.round(34 * scale));
  ctx.font = `700 ${font}px system-ui, sans-serif`;
  const pad = Math.round(10 * scale);
  const textW = ctx.measureText(label).width;
  ctx.fillStyle = 'rgba(0,0,0,0.65)';
  ctx.fillRect(pad, pad, textW + pad * 2, font + pad * 2);
  ctx.fillStyle = d.ok ? '#7cf59a' : '#ffb4a2';
  ctx.fillText(label, pad * 2, pad * 2 + font);

  if (frame.spanPx != null) {
    const sub = `eye span ${frame.spanPx.toFixed(1)} px · yaw ${frame.yawDeg == null ? '?' : frame.yawDeg.toFixed(0)}°`;
    ctx.font = `500 ${Math.round(15 * scale)}px system-ui, sans-serif`;
    ctx.fillStyle = '#ffffff';
    ctx.fillText(sub, pad * 2, pad * 3 + font + Math.round(8 * scale));
  }
}

/** The module API, also returned by startDistance() for convenience. */
export const api = {
  startDistance,
  stopDistance,
  calibrateCamera,
  getDistance,
  getCalibration,
  getLastFrame,
  getParticipant,
  isRunning,
  resetCalibration,
  setDebugHost,
  setParticipant,
};