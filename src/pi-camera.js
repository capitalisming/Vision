// AI-assisted (Claude Code), reviewed by a team member.
// Raspberry Pi camera as a video source. Polls /frame on pi/camera_server.py, draws each frame into a canvas
// and shows the canvas stream in a <video>, so code written for a webcam <video> can use the Pi camera.
// Frames stay in memory only; nothing is stored or sent anywhere.

const MAX_FAILURES = 5; // consecutive failed requests before the status turns to 'lost'

/**
 * Base URL of the Pi camera server. Empty input means "this page came from the Pi" (same origin).
 * Accepts "raspberrypi.local:8000", "192.168.1.20:8000" or a full http(s) URL; keeps only the origin.
 * Without a scheme it takes the page's: an https page (e.g. GitHub Pages) can only load an https camera.
 */
export function normalizePiUrl(input, pageOrigin) {
  const text = String(input ?? '').trim();
  if (!text) return pageOrigin;
  const scheme = /^https:/i.test(String(pageOrigin)) ? 'https' : 'http';
  const withScheme = /^https?:\/\//i.test(text) ? text : `${scheme}://${text}`;
  let url;
  try {
    url = new URL(withScheme);
  } catch {
    throw new Error(`"${text}" is not a valid address. Example: raspberrypi.local:8000`);
  }
  return url.origin;
}

/** Why `base` cannot be loaded from a page at `pageUrl`, or '' when it can. */
export function blockedReason(base, pageUrl) {
  const page = new URL(pageUrl);
  if (page.protocol === 'https:' && base.startsWith('http:')) {
    return 'This page is on https, so it cannot load an http camera. Start the Pi server with https '
      + '(python3 pi/camera_server.py --https, see pi/README.md) and enter https://<pi-address>:8000, '
      + 'or open the app from the Pi instead: http://<pi-address>:8000';
  }
  return '';
}

/**
 * Start showing the Pi camera in `videoEl`. Resolves after the first frame, or rejects with a readable error.
 * @returns {Promise<{stop: () => void, status: () => {state: string, fps: number, ageMs: number|null,
 *   width: number, height: number, error: string}}>}
 */
export async function connectPiCamera(videoEl, base, { fps = 15, timeoutMs = 2000 } = {}) {
  const reason = blockedReason(base, location.href);
  if (reason) throw new Error(reason);
  const frameUrl = `${base}/frame`;
  const canvas = document.createElement('canvas');
  const ctx = canvas.getContext('2d');
  let running = true;
  let failures = 0;
  let lastError = '';
  let receivedAt = 0; // performance.now() when the newest frame arrived
  let serverAgeMs = 0; // how old that frame already was on the Pi
  const recent = []; // arrival times of the last frames, for the fps readout
  let controller = null;

  async function fetchFrame() {
    controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await fetch(frameUrl, { cache: 'no-store', signal: controller.signal });
      if (res.status === 503) throw new Error('the Pi camera has not produced a frame yet');
      if (!res.ok) throw new Error(`the Pi answered ${res.status}`);
      const blob = await res.blob();
      const bitmap = await createImageBitmap(blob);
      if (canvas.width !== bitmap.width || canvas.height !== bitmap.height) {
        canvas.width = bitmap.width;
        canvas.height = bitmap.height;
      }
      ctx.drawImage(bitmap, 0, 0);
      bitmap.close();
      receivedAt = performance.now();
      serverAgeMs = Number(res.headers.get('X-Frame-Age-Ms')) || 0;
      recent.push(receivedAt);
      while (recent.length > 1 && receivedAt - recent[0] > 2000) recent.shift();
      failures = 0;
      lastError = '';
    } finally {
      clearTimeout(timer);
    }
  }

  try {
    await fetchFrame(); // fail fast with a clear message if the Pi is not reachable
  } catch (err) {
    const why = err.name === 'AbortError' ? 'no answer within 2 s' : err.message;
    // A blocked cross-origin read, an untrusted certificate and a dead address all look the same to the
    // page ("Failed to fetch").
    let hint = '';
    if (base === location.origin) {
      if (/ 404$/.test(why)) hint = ' This page did not come from a Pi: enter the Pi address.';
    } else {
      hint = ` Check that pi/camera_server.py is running there and was started with --allow-origin ${location.origin}.`;
      if (base.startsWith('https:')) {
        hint += ` With a self-signed certificate, open ${base}/health once in this browser and accept the warning.`;
      }
    }
    throw new Error(`Cannot reach the Pi camera at ${base}: ${why}.${hint}`);
  }

  const stream = canvas.captureStream(fps);
  videoEl.srcObject = stream;
  await videoEl.play();

  (async function loop() {
    const period = 1000 / fps;
    while (running) {
      const started = performance.now();
      try {
        await fetchFrame();
      } catch (err) {
        if (!running) break;
        failures += 1;
        lastError = err.name === 'AbortError' ? 'no answer within 2 s' : err.message;
      }
      const wait = failures ? Math.min(2000, period * 2 ** failures) : period - (performance.now() - started);
      await new Promise((r) => setTimeout(r, Math.max(0, wait)));
    }
  })();

  return {
    stop() {
      running = false;
      controller?.abort();
      for (const track of stream.getTracks()) track.stop();
      if (videoEl.srcObject === stream) videoEl.srcObject = null;
    },
    status() {
      const span = recent.length > 1 ? (recent[recent.length - 1] - recent[0]) / 1000 : 0;
      return {
        state: !running ? 'stopped' : failures >= MAX_FAILURES ? 'lost' : 'live',
        fps: span > 0 ? (recent.length - 1) / span : 0,
        ageMs: receivedAt ? performance.now() - receivedAt + serverAgeMs : null,
        width: canvas.width,
        height: canvas.height,
        error: lastError,
      };
    },
  };
}
