// Face-to-screen distance from the webcam via MediaPipe Face Landmarker.
// Everything runs locally: the library, wasm and model are loaded from vendor/.
// No frames or coordinates leave the browser and nothing is written to disk.

const VENDOR = new URL('../vendor/', import.meta.url);

export const WINDOW_MS = 500;
export const MAX_HEAD_TURN_DEG = 15;
// Outer eye corners in the 478-point face mesh (subject's left / right).
const LEFT_OUTER = 263;
const RIGHT_OUTER = 33;
// Iris contour points (only in the 478-point mesh), as opposite pairs: two diameters per eye.
const IRIS_DIAMETERS = [[469, 471], [470, 472], [474, 476], [475, 477]];

// Automatic calibration. The iris is the ruler: its visible diameter is about the same in all adults
// (11.7 mm, the value MediaPipe Iris uses), so eye span / iris diameter gives the eye span in mm whatever the
// distance. The camera's focal length turns that into a distance; until it has been measured once with a tape,
// it is taken from a typical webcam field of view, so an automatic calibration is an estimate (see README).
export const IRIS_MM = 11.7;
export const DEFAULT_HFOV_DEG = 62; // Pi Camera Module 2: 62.2°, Module 3: 66°, most laptop webcams 55–70°
export const AUTO_WINDOW_MS = 1500;
export const AUTO_MIN_SAMPLES = 15;
export const AUTO_MAX_CV = 0.03; // eye span may vary by 3% while collecting: the head is held still
const EYE_SPAN_MM_MIN = 70; // outer eye corner distance of adults is about 80–105 mm
const EYE_SPAN_MM_MAX = 120;
const GPU_START_TIMEOUT_MS = 8000; // some GPUs (e.g. Raspberry Pi 4) hang instead of failing

const state = {
  landmarker: null,
  video: null,
  rafId: 0,
  lastVideoTime: -1,
  samples: [], // { t, span } from valid frames only, last WINDOW_MS
  calibSamples: [], // { t, span, iris } from valid frames only, last AUTO_WINDOW_MS
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

/** Mean iris diameter in video pixels, or null when the mesh has no iris points. */
export function irisDiameterPx(lm, videoWidth, videoHeight) {
  if (!lm || lm.length < 478) return null;
  let sum = 0;
  for (const [a, b] of IRIS_DIAMETERS) {
    sum += Math.hypot((lm[a].x - lm[b].x) * videoWidth, (lm[a].y - lm[b].y) * videoHeight);
  }
  const d = sum / IRIS_DIAMETERS.length;
  return d > 0 ? d : null;
}

// Pure per-frame evaluation: { reason, spanPx, irisPx, corners }.
export function evaluateFrame(result, videoWidth, videoHeight) {
  const faces = result.faceLandmarks || [];
  const corners = faces.map((lm) => ({
    left: { x: lm[LEFT_OUTER].x * videoWidth, y: lm[LEFT_OUTER].y * videoHeight },
    right: { x: lm[RIGHT_OUTER].x * videoWidth, y: lm[RIGHT_OUTER].y * videoHeight },
  }));
  if (faces.length === 0) return { reason: 'no_face', spanPx: null, irisPx: null, corners };
  if (faces.length > 1) return { reason: 'two_faces', spanPx: null, irisPx: null, corners };
  const matrix = (result.facialTransformationMatrixes || [])[0];
  if (matrix && headTurnDeg(matrix) > MAX_HEAD_TURN_DEG) {
    return { reason: 'head_turned', spanPx: null, irisPx: null, corners };
  }
  const { left, right } = corners[0];
  return {
    reason: null,
    spanPx: Math.hypot(left.x - right.x, left.y - right.y),
    irisPx: irisDiameterPx(faces[0], videoWidth, videoHeight),
    corners,
  };
}

function prune(now) {
  const from = now - WINDOW_MS;
  while (state.samples.length && state.samples[0].t < from) state.samples.shift();
  const calibFrom = now - AUTO_WINDOW_MS;
  while (state.calibSamples.length && state.calibSamples[0].t < calibFrom) state.calibSamples.shift();
}

function processFrame(result, now) {
  const f = evaluateFrame(result, state.video.videoWidth, state.video.videoHeight);
  state.corners = f.corners;
  state.frameReason = f.reason;
  if (f.reason === null) {
    state.samples.push({ t: now, span: f.spanPx });
    state.calibSamples.push({ t: now, span: f.spanPx, iris: f.irisPx });
    state.lastValidAt = now;
  } else {
    state.calibSamples = []; // an automatic calibration needs an unbroken run of good frames
  }
  prune(now);
}

/** Resolves with `promise`, or rejects after `ms`; a late result is handed to `onLate` (to be closed). */
function withTimeout(promise, ms, onLate) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => {
      promise.then(onLate, () => {});
      reject(new Error(`no answer within ${ms} ms`));
    }, ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
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
    return await withTimeout(FaceLandmarker.createFromOptions(fileset, options('GPU')), GPU_START_TIMEOUT_MS,
      (late) => late.close());
  } catch (gpuError) {
    console.warn('Face Landmarker: GPU delegate failed, using CPU', gpuError);
    return FaceLandmarker.createFromOptions(fileset, options('CPU'));
  }
}

function loop() {
  const v = state.video;
  if (!v) { state.rafId = 0; return; }
  if (v.readyState >= 2 && v.currentTime !== state.lastVideoTime) {
    state.lastVideoTime = v.currentTime;
    const now = performance.now();
    processFrame(state.landmarker.detectForVideo(v, now), now);
  }
  state.rafId = requestAnimationFrame(loop);
}

// How the camera stream gets into the video element. Default: this computer's webcam. The app can replace it
// (for example with a Raspberry Pi camera): a provider is `async (videoEl) => void` that sets videoEl.srcObject.
// `id` names the camera: a calibration (k) belongs to one camera, so it is stored under that id. The default
// webcam has no id and keeps the plain key. `deviceId` picks one of this computer's cameras (from listCameras).
let cameraProvider = null;
let cameraId = '';
let webcamDeviceId = '';
export function setCameraProvider(provider, id = '', { deviceId = '' } = {}) {
  cameraProvider = provider;
  cameraId = id;
  webcamDeviceId = deviceId;
}

/** '' when this page can use a local camera, else 'insecure' (needs https or localhost) or 'unsupported'. */
export function cameraSupport(win = globalThis) {
  if (win.isSecureContext === false) return 'insecure';
  if (!win.navigator?.mediaDevices?.getUserMedia) return 'unsupported';
  return '';
}

/** Raspberry Pi and other ARM Linux boards (not Android): ask for a smaller picture to spare the CPU. */
export function isLowPowerDevice(userAgent = globalThis.navigator?.userAgent ?? '') {
  return /Linux (aarch64|armv7l|armv8l|arm)/.test(userAgent) && !/Android/.test(userAgent);
}

/** The constraints for getUserMedia: a chosen camera exactly, else the front camera if there is one. */
export function videoConstraints(deviceId = '', lowPower = isLowPowerDevice()) {
  const size = lowPower
    ? { width: { ideal: 640 }, height: { ideal: 480 } }
    : { width: { ideal: 1280 }, height: { ideal: 720 } };
  return deviceId ? { deviceId: { exact: deviceId }, ...size } : { facingMode: 'user', ...size };
}

function named(name, message) {
  return Object.assign(new Error(message), { name });
}

async function webcam(videoEl) {
  const problem = cameraSupport();
  if (problem === 'insecure') {
    throw named('InsecureContextError', 'The camera only works on an https:// page or on http://localhost.');
  }
  if (problem) throw named('NotSupportedError', 'This browser cannot use a camera (no getUserMedia).');
  videoEl.srcObject = await navigator.mediaDevices.getUserMedia({ video: videoConstraints(webcamDeviceId), audio: false });
}

/**
 * This computer's cameras as [{ deviceId, label }]. Labels are only known after camera permission was given;
 * before that they are "Camera 1", "Camera 2"…
 */
export async function listCameras() {
  if (cameraSupport() || !navigator.mediaDevices.enumerateDevices) return [];
  const devices = await navigator.mediaDevices.enumerateDevices();
  return devices.filter((d) => d.kind === 'videoinput')
    .map((d, i) => ({ deviceId: d.deviceId, label: d.label || `Camera ${i + 1}` }));
}

/** deviceId of the camera that is running now, or ''. */
export function activeDeviceId() {
  const track = state.video?.srcObject?.getVideoTracks?.()[0];
  return track?.getSettings?.().deviceId ?? '';
}

function releaseStream(videoEl) {
  videoEl.srcObject?.getTracks?.().forEach((track) => track.stop());
  videoEl.srcObject = null;
}

// Gets the camera into videoEl (through the provider, else the webcam) and starts per-frame processing.
// Calling it again while videoEl is playing a stream is a no-op; with no stream it starts the camera again.
// Another video element that was running is stopped first: one camera at a time.
export async function startDistance(videoEl) {
  if (state.video === videoEl && videoEl.srcObject) return;
  if (state.video) stopDistance();
  state.video = videoEl;
  state.lastVideoTime = -1;
  try {
    await (cameraProvider ?? webcam)(videoEl);
    videoEl.muted = true;
    videoEl.playsInline = true;
    await videoEl.play();
  } catch (e) {
    releaseStream(videoEl);
    state.video = null;
    throw e;
  }
  try {
    state.landmarker ??= await createLandmarker();
  } catch (e) {
    releaseStream(videoEl); // without the face tracker the camera is of no use: let go of it
    state.video = null;
    throw named('FaceTrackerError', `The face tracker could not start: ${e?.message ?? e}`);
  }
  if (state.video !== videoEl) return; // stopped while the face tracker was loading
  if (!state.rafId) state.rafId = requestAnimationFrame(loop);
}

/** Stop the camera and the per-frame processing, and forget the measurements. Safe to call at any time. */
export function stopDistance() {
  if (state.rafId) cancelAnimationFrame(state.rafId);
  state.rafId = 0;
  if (state.video) releaseStream(state.video);
  state.video = null;
  state.samples = [];
  state.calibSamples = [];
  state.lastValidAt = null;
  state.frameReason = 'no_face';
  state.corners = [];
}

const kKey = (participant) => (cameraId ? `cam_k_${participant}@${cameraId}` : `cam_k_${participant}`);
const methodKey = (participant) => (cameraId ? `cam_kmethod_${participant}@${cameraId}` : `cam_kmethod_${participant}`);
const focalKey = () => (cameraId ? `cam_focal@${cameraId}` : 'cam_focal');

export function getK(participant) {
  const v = Number(localStorage.getItem(kKey(participant)));
  return Number.isFinite(v) && v > 0 ? v : null;
}

/**
 * How the calibration of this participant and camera was made: 'tape' (measured at a known distance),
 * 'auto' (automatic, camera field of view assumed), 'auto_focal' (automatic, with a focal length measured
 * earlier with a tape on this camera), or null when there is none. Calibrations from before automatic
 * calibration existed were all made with a tape.
 */
export function getCalibrationMethod(participant) {
  if (!getK(participant)) return null;
  return localStorage.getItem(methodKey(participant)) || 'tape';
}

/** Focal length of this camera as a share of the picture width, once measured with a tape; else null. */
export function getFocalNorm() {
  const v = Number(localStorage.getItem(focalKey()));
  return Number.isFinite(v) && v > 0 ? v : null;
}

/** Focal length in pixels of a camera with horizontal field of view `hfovDeg`, for a picture `width` px wide. */
export function focalPx(width, hfovDeg = DEFAULT_HFOV_DEG) {
  return width / 2 / Math.tan((hfovDeg * Math.PI) / 360);
}

export function setParticipant(participant) {
  state.participant = participant;
}

// Outer eye corners of every face in the latest processed frame, in video pixels: [{ left, right }].
export function getEyeCorners() {
  return state.corners;
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

/**
 * Eye span in mm from an unbroken run of frames, with the iris as the ruler.
 * @param {{span:number, iris:number|null}[]} samples
 * @returns {{ok:true, eyeSpanMm:number, eyeSpanPx:number} | {ok:false, reason:string, progress:number}}
 *   reason: 'collecting' (not enough frames yet), 'hold_still', 'no_iris' or 'implausible'
 */
export function eyeSpanFromIris(samples, { minSamples = AUTO_MIN_SAMPLES, maxCv = AUTO_MAX_CV } = {}) {
  const usable = samples.filter((s) => s.span > 0 && s.iris > 0);
  if (samples.length >= minSamples && usable.length < minSamples / 2) return { ok: false, reason: 'no_iris', progress: 0 };
  if (usable.length < minSamples) return { ok: false, reason: 'collecting', progress: usable.length / minSamples };
  const spans = usable.map((s) => s.span);
  const mean = spans.reduce((a, b) => a + b, 0) / spans.length;
  const sd = Math.sqrt(spans.reduce((a, b) => a + (b - mean) ** 2, 0) / (spans.length - 1));
  if (sd / mean > maxCv) return { ok: false, reason: 'hold_still', progress: 0 };
  const eyeSpanMm = median(usable.map((s) => s.span / s.iris)) * IRIS_MM;
  if (eyeSpanMm < EYE_SPAN_MM_MIN || eyeSpanMm > EYE_SPAN_MM_MAX) return { ok: false, reason: 'implausible', progress: 0 };
  return { ok: true, eyeSpanMm, eyeSpanPx: median(spans) };
}

/**
 * Automatic calibration, without a tape: call it once per frame until it returns ok. It needs the face held
 * still for AUTO_WINDOW_MS. k = focal length (px) × eye span (mm), so distance = k / eye span (px) as before.
 * @returns {{ok:true, k:number, eyeSpanMm:number, method:string} | {ok:false, reason:string, progress:number}}
 */
export function autoCalibrateCamera(participant) {
  if (!participant) throw new Error('participant is required');
  if (!state.video?.videoWidth) return { ok: false, reason: 'no_face', progress: 0 };
  if (state.frameReason) return { ok: false, reason: state.frameReason, progress: 0 };
  prune(performance.now());
  const est = eyeSpanFromIris(state.calibSamples);
  if (!est.ok) return est;
  const focalNorm = getFocalNorm();
  const width = state.video.videoWidth;
  const focal = focalNorm ? focalNorm * width : focalPx(width);
  const k = focal * est.eyeSpanMm;
  const method = focalNorm ? 'auto_focal' : 'auto';
  localStorage.setItem(kKey(participant), String(k));
  localStorage.setItem(methodKey(participant), method);
  state.participant = participant;
  return { ok: true, k, eyeSpanMm: est.eyeSpanMm, method };
}

/** Remove the calibration of this participant with this camera (to calibrate again). */
export function clearCalibration(participant) {
  localStorage.removeItem(kKey(participant));
  localStorage.removeItem(methodKey(participant));
}

// k = median eyeSpanPx * knownMm, stored per participant. Throws if there is no
// valid recent measurement to calibrate from. When the iris is visible it also measures this camera's focal
// length, so later automatic calibrations on this camera (any participant) need no assumed field of view.
export function calibrateCamera(participant, knownMm) {
  if (!participant) throw new Error('participant is required');
  if (!(knownMm > 0)) throw new Error('knownMm must be a positive number');
  // With no participant there is no k, so a good measurement reports exactly
  // 'not_calibrated'; any other reason means the face reading is unusable.
  const d = getDistance(null);
  if (d.reason !== 'not_calibrated') throw new Error(`cannot calibrate: ${d.reason}`);
  const k = d.eyeSpanPx * knownMm;
  localStorage.setItem(kKey(participant), String(k));
  localStorage.setItem(methodKey(participant), 'tape');
  const est = eyeSpanFromIris(state.calibSamples, { minSamples: 5, maxCv: 0.05 });
  if (est.ok && state.video?.videoWidth) {
    localStorage.setItem(focalKey(), String(k / est.eyeSpanMm / state.video.videoWidth));
  }
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
