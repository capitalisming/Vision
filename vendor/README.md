# vendor/

Third-party browser assets for the camera module. Everything here is served from this
folder — the app never loads MediaPipe from a CDN and works with the network switched off.

| File | What | Licence |
|---|---|---|
| `tasks-vision/vision_bundle.mjs` | MediaPipe Tasks Vision ES module, version **1.2.3** | Apache-2.0 |
| `tasks-vision/wasm/vision_wasm_internal.js` | WASM loader (default, non-module build) | Apache-2.0 |
| `tasks-vision/wasm/vision_wasm_internal.wasm` | WASM runtime | Apache-2.0 |
| `tasks-vision/wasm/vision_wasm_module_internal.js` | WASM loader (ES-module build) | Apache-2.0 |
| `tasks-vision/wasm/vision_wasm_module_internal.wasm` | WASM runtime (ES-module build) | Apache-2.0 |
| `models/face_landmarker.task` | Face Landmarker, float16, model version 1 | Apache-2.0 |

Sources:

- npm package: <https://www.npmjs.com/package/@mediapipe/tasks-vision> ·
  tarball `https://registry.npmjs.org/@mediapipe/tasks-vision/-/tasks-vision-1.2.3.tgz`
- model: `https://storage.googleapis.com/mediapipe-models/face_landmarker/face_landmarker/float16/1/face_landmarker.task`
- upstream project and licence: <https://github.com/google-ai-edge/mediapipe> (Apache-2.0)

SHA-256 of the exact files in this folder:

```
64184e229b263107bc2b804c6625db1341ff2bb731874b0bcc2fe6544e0bc9ff  models/face_landmarker.task
fb0c02c296f44ce0cc324ba16bd646d8773eb4a7847db4019cc4d0430db7a9b5  tasks-vision/vision_bundle.mjs
2aa5fd3fdd3d8208cd7587df0bb19fb6925c4ea16a76dd025aedc1f64d6a6309  tasks-vision/wasm/vision_wasm_internal.js
225bc06c0f51a9cf31fea0e9e0b0243e9e01fb5ef332cc1a7fa6656dbdfdaabf  tasks-vision/wasm/vision_wasm_internal.wasm
d29996249490361715c769c6a49b43ad47e6ac9a28a8e8bce8d02b238e897851  tasks-vision/wasm/vision_wasm_module_internal.js
a269e84b12aefc93c9d6a4d62b01f41e5434a9fa941533bb8e75b1e3d1669e46  tasks-vision/wasm/vision_wasm_module_internal.wasm
```

## How `src/distance.js` uses it

```js
FilesetResolver.forVisionTasks(new URL('../vendor/tasks-vision/wasm', import.meta.url).href)
```

The resolver appends `/vision_wasm_internal.js` (or `_module_` for the module build) to that
base path, so the folder name matters but a trailing slash does not. The model is passed as
`baseOptions.modelAssetPath` pointing at `../vendor/models/face_landmarker.task`.

The JSON calibration constant `k` is stored together with the frame width at calibration
time. If the camera later delivers another resolution, `k` is scaled by
`videoWidth / calibration.frameWidth`. Changing the lens (front vs rear camera) or the zoom
invalidates the calibration and needs a new Save.

## Refreshing the assets

Only needed when deliberately upgrading MediaPipe. From the repository root:

```powershell
$tmp = Join-Path $env:TEMP 'tasks-vision'
New-Item -ItemType Directory -Force $tmp | Out-Null
curl.exe -L -o "$tmp/tasks-vision.tgz" https://registry.npmjs.org/@mediapipe/tasks-vision/-/tasks-vision-1.2.3.tgz
tar -xzf "$tmp/tasks-vision.tgz" -C $tmp
Copy-Item "$tmp/package/vision_bundle.mjs" vendor/tasks-vision/
Copy-Item "$tmp/package/wasm/*" vendor/tasks-vision/wasm/
curl.exe -L -o vendor/models/face_landmarker.task https://storage.googleapis.com/mediapipe-models/face_landmarker/face_landmarker/float16/1/face_landmarker.task
```

Then update the version and the SHA-256 list above.