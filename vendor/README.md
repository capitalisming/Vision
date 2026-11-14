# vendor/

Everything here is loaded locally; the app makes no CDN or network requests.

| Path | What | Version | License | Source |
|---|---|---|---|---|
| `mediapipe/vision_bundle.mjs`, `mediapipe/vision.d.ts` | MediaPipe Tasks Vision (ES module + types) | `@mediapipe/tasks-vision` 1.1.1 (npm, 2026-10-14) | Apache-2.0 | https://www.npmjs.com/package/@mediapipe/tasks-vision |
| `mediapipe/wasm/vision_wasm_internal.{js,wasm}`, `mediapipe/wasm/vision_wasm_nosimd_internal.{js,wasm}` | WASM runtime from the same package (SIMD and no-SIMD) | 1.1.1 | Apache-2.0 | same package, `wasm/` |
| `models/face_landmarker.task` | Face Landmarker model, float16, v1 | 1 | Apache-2.0 | https://storage.googleapis.com/mediapipe-models/face_landmarker/face_landmarker/float16/1/face_landmarker.task |

1.1.1 was chosen over the newest 1.2.3 (released 2026-11-11) to avoid a days-old release before the freeze.

SHA-256:

```
a84921e02321e582484c1f8126d344b5f33b791fa09c640a52e20ee8632068f1  mediapipe/vision_bundle.mjs
6522286aa32dd93eff17c3da002b0649516f87abfec7a80b5bfe5c9625caa5f8  mediapipe/wasm/vision_wasm_internal.js
0e101a010e262ef8e78f22e3c95b60a9705fd06962753c9acd6356d9fb56b7bd  mediapipe/wasm/vision_wasm_internal.wasm
64184e229b263107bc2b804c6625db1341ff2bb731874b0bcc2fe6544e0bc9ff  models/face_landmarker.task
```
