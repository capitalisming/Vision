import { useCallback, useEffect, useRef, useState } from 'react';
import { FaceTracker, FrameResult } from '../camera/faceTracker';
import { DistanceCalibration, DistanceEstimate, DistanceSmoother, estimateDistance } from '../core/distance';

export type TrackerState = 'idle' | 'loading' | 'running' | 'error';

/** Live smoothed distance (cm) from the front camera, given a calibration. */
export function useTracker(cal: DistanceCalibration | null) {
  const tracker = useRef<FaceTracker | null>(null);
  const smoother = useRef(new DistanceSmoother());
  const [state, setState] = useState<TrackerState>('idle');
  const [lastFrame, setLastFrame] = useState<FrameResult | null>(null);
  const latest = useRef<{ cm: number | null; raw: DistanceEstimate | null; luma: number | null; faces: number }>({
    cm: null,
    raw: null,
    luma: null,
    faces: 0,
  });

  const start = useCallback(async () => {
    setState('loading');
    try {
      const t = new FaceTracker();
      tracker.current = t;
      t.onFrame = (f) => {
        let raw: DistanceEstimate | null = null;
        if (cal && f.features) raw = estimateDistance(f.features, cal, f.frameW);
        smoother.current.push(f.t, f.faces === 1 ? raw?.cm ?? null : null);
        latest.current = { cm: f.faces === 1 ? smoother.current.value() : null, raw, luma: f.luma, faces: f.faces };
        setLastFrame(f);
      };
      await t.start();
      setState('running');
    } catch (e) {
      console.error(e);
      setState('error');
    }
  }, [cal]);

  useEffect(() => () => tracker.current?.stop(), []);
  return { state, tracker, lastFrame, latest, start };
}
