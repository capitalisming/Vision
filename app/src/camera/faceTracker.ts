import { FaceLandmarker, FilesetResolver } from '@mediapipe/tasks-vision';
import { featuresFromLandmarks, FaceFeaturesPx } from '../core/distance';

export interface FrameResult {
  t: number;
  faces: number;
  features: FaceFeaturesPx | null;
  frameW: number;
  frameH: number;
  luma: number | null;
}

/**
 * Front-camera face tracking (MediaPipe Face Landmarker, 478 landmarks incl. iris).
 * Runs entirely on-device; no image ever leaves the phone, nothing is stored except the
 * derived numbers (iris diameters in pixels, mean luma).
 */
export class FaceTracker {
  private landmarker: FaceLandmarker | null = null;
  private stream: MediaStream | null = null;
  private raf = 0;
  private lumaCanvas = document.createElement('canvas');
  readonly video: HTMLVideoElement;
  onFrame: (r: FrameResult) => void = () => {};

  constructor() {
    this.video = document.createElement('video');
    this.video.playsInline = true;
    this.video.muted = true;
    this.lumaCanvas.width = 32;
    this.lumaCanvas.height = 24;
  }

  async start(): Promise<void> {
    const base = import.meta.env.BASE_URL;
    if (!this.landmarker) {
      const fileset = await FilesetResolver.forVisionTasks(`${base}wasm`);
      const opts = (delegate: 'GPU' | 'CPU') => ({
        baseOptions: { modelAssetPath: `${base}models/face_landmarker.task`, delegate },
        runningMode: 'VIDEO' as const,
        numFaces: 2,
      });
      try {
        this.landmarker = await FaceLandmarker.createFromOptions(fileset, opts('GPU'));
      } catch {
        this.landmarker = await FaceLandmarker.createFromOptions(fileset, opts('CPU'));
      }
    }
    this.stream = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: 'user', width: { ideal: 1280 }, height: { ideal: 720 } },
      audio: false,
    });
    this.video.srcObject = this.stream;
    await this.video.play();
    this.loop();
  }

  private loop = () => {
    const v = this.video;
    if (this.landmarker && v.readyState >= 2 && v.videoWidth > 0) {
      const t = performance.now();
      const res = this.landmarker.detectForVideo(v, t);
      const faces = res.faceLandmarks?.length ?? 0;
      const features = faces === 1 ? featuresFromLandmarks(res.faceLandmarks[0], v.videoWidth, v.videoHeight) : null;
      this.onFrame({ t, faces, features, frameW: v.videoWidth, frameH: v.videoHeight, luma: this.luma() });
    }
    this.raf = requestAnimationFrame(this.loop);
  };

  private lumaFrame = 0;
  private lastLuma: number | null = null;
  private luma(): number | null {
    if (this.lumaFrame++ % 10 !== 0) return this.lastLuma;
    const ctx = this.lumaCanvas.getContext('2d', { willReadFrequently: true });
    if (!ctx) return null;
    ctx.drawImage(this.video, 0, 0, 32, 24);
    const d = ctx.getImageData(0, 0, 32, 24).data;
    let s = 0;
    for (let i = 0; i < d.length; i += 4) s += 0.2126 * d[i] + 0.7152 * d[i + 1] + 0.0722 * d[i + 2];
    this.lastLuma = s / (d.length / 4);
    return this.lastLuma;
  }

  stop() {
    cancelAnimationFrame(this.raf);
    this.stream?.getTracks().forEach((t) => t.stop());
    this.stream = null;
  }
}
