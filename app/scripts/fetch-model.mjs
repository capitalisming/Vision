// Fetches the MediaPipe Face Landmarker model (Apache-2.0) and copies the tasks-vision
// WASM runtime into public/, so the app runs fully offline after the first load.
import { createHash } from 'node:crypto';
import { cpSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const MODEL_URL =
  'https://storage.googleapis.com/mediapipe-models/face_landmarker/face_landmarker/float16/1/face_landmarker.task';
const out = join(root, 'public/models/face_landmarker.task');

mkdirSync(dirname(out), { recursive: true });
if (!existsSync(out)) {
  const r = await fetch(MODEL_URL);
  if (!r.ok) throw new Error(`model download failed: ${r.status}`);
  writeFileSync(out, Buffer.from(await r.arrayBuffer()));
}
const sha = createHash('sha256').update(readFileSync(out)).digest('hex');
console.log(`face_landmarker.task sha256=${sha}`);

const wasmSrc = join(root, 'node_modules/@mediapipe/tasks-vision/wasm');
cpSync(wasmSrc, join(root, 'public/wasm'), { recursive: true });
console.log('copied tasks-vision wasm → public/wasm');
