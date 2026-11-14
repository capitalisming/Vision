import type { DistanceCalibration } from './distance';

export type Eye = 'OD' | 'OS'; // OD = right eye, OS = left eye
export type Orientation = 'right' | 'down' | 'left' | 'up';
export const ORIENTATIONS: Orientation[] = ['right', 'down', 'left', 'up'];

/** Data provenance category, carried on every exported record. */
export type DataCategory = 'MEASURED' | 'SIMULATED';

export interface ScreenCalibration {
  /** physical size of one CSS pixel, mm (from ID-1 card match: 85.60 mm) */
  mmPerCssPx: number;
  method: 'id1-card' | 'ruler' | 'manual-ppi';
  at: string;
}

export interface Trial {
  i: number;
  orientation: Orientation;
  response: Orientation;
  correct: boolean;
  requestedLogMAR: number;
  strokeDevPx: number;
  strokeMm: number;
  distanceCmOnset: number;
  distanceCmResponse: number;
  /** distance used for the realised logMAR = mean(onset, response) */
  distanceCm: number;
  logMAR: number; // realised
  rtMs: number;
  distanceSource: 'camera' | 'manual';
  rawDistance?: { irisA: number | null; irisB: number | null; ipd: number | null };
  /** mean camera-frame luma 0–255 at onset (ambient light proxy), if camera on */
  ambientLuma?: number | null;
  pausedForDistance: number; // how many times the stimulus was hidden for leaving the window
}

export interface EyeResult {
  eye: Eye;
  trials: Trial[];
  estimate: { logMAR: number; sd: number; mle: number; atBoundary: boolean; nCorrect: number; n: number };
  valid: boolean;
  durationS: number;
}

export interface Session {
  id: string;
  dataCategory: DataCategory;
  appVersion: string;
  startedAt: string;
  endedAt: string;
  mode: 'monitor' | 'experiment';
  /** label of what the person wears, e.g. "own glasses", "none", "SAG +0.75" */
  correction: string;
  experiment?: { participantId: string; experimentId: string; addedLensD: number | null; note: string };
  targetDistanceCm: number;
  distanceWindow: [number, number];
  distanceMode: 'camera' | 'manual';
  device: { userAgent: string; dpr: number; cssW: number; cssH: number; mmPerDevicePx: number };
  screenCalibration: ScreenCalibration;
  distanceCalibration: DistanceCalibration | null;
  psych: { guess: number; lapse: number; slope: number };
  trialsPerEye: number;
  eyes: EyeResult[];
  notes: string;
}

/** Protocol E0: camera distance vs tape-measured distance. */
export interface DistanceCheck {
  at: string;
  dataCategory: DataCategory;
  participantId: string;
  trueCm: number;
  condition: 'both-open' | 'right-covered' | 'left-covered';
  appCm: number | null; // median of the window
  irisA: number | null;
  irisB: number | null;
  ipd: number | null;
  frames: number;
  sdCm: number | null; // frame-to-frame SD within the 1.5 s window
}

export interface Profile {
  version: 1;
  createdAt: string;
  screen: ScreenCalibration | null;
  camera: DistanceCalibration | null;
  sessions: Session[];
  distanceChecks?: DistanceCheck[];
}
