import { useCallback, useEffect, useRef, useState } from 'react';
import type { Eye, EyeResult, Orientation, Profile, Session, Trial } from '../core/types';
import { ORIENTATIONS } from '../core/types';
import { PsiStaircase, candidateLevels } from '../core/psi';
import { DEFAULT_PSYCH } from '../core/psychometric';
import { logMARFromStroke, minRenderableLogMAR, strokeMmForLogMAR } from '../core/optics';
import { SESSION_VALID } from '../core/baseline';
import {
  APP_VERSION,
  DISTANCE_WINDOW,
  MAX_LOGMAR,
  MIN_STROKE_DEV_PX,
  TARGET_DISTANCE_CM,
  TRIALS_PER_EYE,
} from '../core/config';
import { drawE } from '../render/optotype';
import { useTracker } from './useTracker';

export interface TestPlan {
  mode: 'monitor' | 'experiment';
  correction: string;
  experiment?: { participantId: string; experimentId: string; addedLensD: number | null; note: string };
  useCamera: boolean;
  eyes: Eye[];
}

const PRESETS = ['Свои очки', 'Без очков', 'Контактные линзы', 'Запасные +0.50', 'Запасные +1.00'];

export function TestSetup({ profile, onStart, onCancel }: { profile: Profile; onStart: (p: TestPlan) => void; onCancel: () => void }) {
  const last = [...profile.sessions].reverse()[0];
  const [correction, setCorrection] = useState(last?.correction ?? PRESETS[0]);
  const [mode, setMode] = useState<'monitor' | 'experiment'>(last?.mode ?? 'monitor');
  const [pid, setPid] = useState(last?.experiment?.participantId ?? 'P01');
  const [eid, setEid] = useState(last?.experiment?.experimentId ?? 'E1');
  const [lens, setLens] = useState<string>('0');
  const [note, setNote] = useState('');
  const [eyes, setEyes] = useState<'both' | 'OD' | 'OS'>('both');
  const camOk = profile.camera != null;
  return (
    <main className="page">
      <h1>Перед тестом</h1>
      <ul className="checklist">
        <li>Яркость экрана — максимальная, автояркость и ночной режим выключены.</li>
        <li>Освещение то же, что при прошлых тестах; свет не бликует на экране.</li>
        <li>Телефон держите на расстоянии чтения ({TARGET_DISTANCE_CM} см) — приложение подскажет.</li>
        <li>Второй глаз закрывайте ладонью, не надавливая на него.</li>
      </ul>
      <label className="field">
        <span>Что надето на глазах</span>
        <input list="corr" value={correction} onChange={(e) => setCorrection(e.target.value)} />
        <datalist id="corr">
          {PRESETS.map((p) => (
            <option key={p} value={p} />
          ))}
        </datalist>
      </label>
      <div className="seg">
        <button className={mode === 'monitor' ? 'on' : ''} onClick={() => setMode('monitor')}>
          Мониторинг
        </button>
        <button className={mode === 'experiment' ? 'on' : ''} onClick={() => setMode('experiment')}>
          Эксперимент
        </button>
      </div>
      {mode === 'experiment' && (
        <div className="grid2">
          <label className="field">
            <span>Участник</span>
            <input value={pid} onChange={(e) => setPid(e.target.value)} />
          </label>
          <label className="field">
            <span>ID опыта</span>
            <input value={eid} onChange={(e) => setEid(e.target.value)} />
          </label>
          <label className="field">
            <span>Добавочная линза, дптр</span>
            <input inputMode="decimal" value={lens} onChange={(e) => setLens(e.target.value)} />
          </label>
          <label className="field">
            <span>Глаза</span>
            <select value={eyes} onChange={(e) => setEyes(e.target.value as 'both' | 'OD' | 'OS')}>
              <option value="both">оба (сначала правый)</option>
              <option value="OD">только правый</option>
              <option value="OS">только левый</option>
            </select>
          </label>
          <label className="field wide">
            <span>Заметка</span>
            <input value={note} onChange={(e) => setNote(e.target.value)} placeholder="напр. очки для чтения +3.0 поверх своих" />
          </label>
        </div>
      )}
      {!camOk && <p className="banner warn">Камера не откалибрована: расстояние не контролируется. Держите телефон на нитке 40 см.</p>}
      <div className="actions">
        <button
          className="btn primary"
          disabled={!correction.trim()}
          onClick={() =>
            onStart({
              mode,
              correction: correction.trim(),
              useCamera: camOk,
              eyes: eyes === 'both' ? ['OD', 'OS'] : [eyes],
              experiment:
                mode === 'experiment'
                  ? { participantId: pid.trim(), experimentId: eid.trim(), addedLensD: lens.trim() === '' ? null : Number(lens.replace(',', '.')), note }
                  : undefined,
            })
          }
        >
          Начать
        </button>
        <button className="btn ghost" onClick={onCancel}>
          Назад
        </button>
      </div>
    </main>
  );
}

const rndOrientation = (): Orientation => {
  const a = new Uint32Array(1);
  crypto.getRandomValues(a);
  return ORIENTATIONS[a[0] % 4];
};

type Phase = 'instruct' | 'trial' | 'gap';

export function TestRunner({
  profile,
  plan,
  onDone,
  onAbort,
}: {
  profile: Profile;
  plan: TestPlan;
  onDone: (s: Session) => void;
  onAbort: () => void;
}) {
  const screen = profile.screen!;
  const dpr = window.devicePixelRatio;
  const mmPerDevPx = screen.mmPerCssPx / dpr;
  const cam = plan.useCamera ? profile.camera : null;
  const { state: camState, latest, start } = useTracker(cam);
  const [eyeIdx, setEyeIdx] = useState(0);
  const [phase, setPhase] = useState<Phase>('instruct');
  const [inWindow, setInWindow] = useState<'ok' | 'near' | 'far' | 'none'>(cam ? 'none' : 'ok');
  const [shownDist, setShownDist] = useState<number | null>(null);
  const canvas = useRef<HTMLCanvasElement>(null);
  const startedAt = useRef(new Date().toISOString());
  const results = useRef<EyeResult[]>([]);
  const staircase = useRef<PsiStaircase | null>(null);
  const trials = useRef<Trial[]>([]);
  const eyeStart = useRef(0);
  const cur = useRef<{
    x: number;
    o: Orientation;
    strokeDevPx: number;
    strokeMm: number;
    onset: number;
    dOnset: number;
    dSum: number;
    dN: number;
    paused: number;
    luma: number | null;
    raw: Trial['rawDistance'];
  } | null>(null);
  const wake = useRef<WakeLockSentinel | null>(null);

  const floor = minRenderableLogMAR(mmPerDevPx, DISTANCE_WINDOW[1], MIN_STROKE_DEV_PX);
  const levels = candidateLevels(Math.ceil(floor * 50) / 50, MAX_LOGMAR);

  useEffect(() => {
    if (cam) start();
    navigator.wakeLock?.request('screen').then((w) => (wake.current = w)).catch(() => {});
    return () => {
      wake.current?.release().catch(() => {});
    };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const distanceNow = useCallback((): number | null => (cam ? latest.current.cm : TARGET_DISTANCE_CM), [cam, latest]);

  // distance monitor (~15 Hz): window check + accumulate distance during display
  useEffect(() => {
    const id = setInterval(() => {
      const d = distanceNow();
      setShownDist(d);
      const w = d == null ? 'none' : d < DISTANCE_WINDOW[0] ? 'near' : d > DISTANCE_WINDOW[1] ? 'far' : 'ok';
      setInWindow(w);
      const c = cur.current;
      if (c && d != null && w === 'ok') {
        c.dSum += d;
        c.dN += 1;
      }
    }, 66);
    return () => clearInterval(id);
  }, [distanceNow]);

  const eye = plan.eyes[eyeIdx];

  const present = useCallback(() => {
    const st = staircase.current!;
    const d = distanceNow() ?? TARGET_DISTANCE_CM;
    const x = st.next();
    const wantMm = strokeMmForLogMAR(x, d);
    const strokeDevPx = Math.max(MIN_STROKE_DEV_PX, wantMm / mmPerDevPx);
    cur.current = {
      x,
      o: rndOrientation(),
      strokeDevPx,
      strokeMm: strokeDevPx * mmPerDevPx,
      onset: performance.now(),
      dOnset: d,
      dSum: d,
      dN: 1,
      paused: 0,
      luma: latest.current.luma,
      raw:
        cam && latest.current.raw
          ? { irisA: latest.current.raw.irisA, irisB: latest.current.raw.irisB, ipd: latest.current.raw.ipd }
          : undefined,
    };
    setPhase('trial');
  }, [distanceNow, mmPerDevPx, cam, latest]);

  // draw / hide optotype
  const visible = phase === 'trial' && inWindow === 'ok';
  const wasVisible = useRef(false);
  useEffect(() => {
    const cv = canvas.current;
    if (!cv) return;
    // backing store = whole device pixels, CSS size set back from it, so the browser never
    // resamples the bitmap (resampling would blur 1–2 px strokes)
    const box = cv.parentElement!.getBoundingClientRect();
    cv.width = Math.floor(box.width * dpr);
    cv.height = Math.floor(box.height * dpr);
    cv.style.width = `${cv.width / dpr}px`;
    cv.style.height = `${cv.height / dpr}px`;
    const ctx = cv.getContext('2d')!;
    ctx.fillStyle = '#fff';
    ctx.fillRect(0, 0, cv.width, cv.height);
    if (visible && cur.current) drawE(ctx, cv.width / 2, cv.height / 2, cur.current.strokeDevPx, cur.current.o);
    if (wasVisible.current && !visible && phase === 'trial' && cur.current) cur.current.paused += 1;
    wasVisible.current = visible;
  }, [visible, phase, dpr]);

  const beginEye = () => {
    staircase.current = new PsiStaircase(levels, DEFAULT_PSYCH);
    trials.current = [];
    eyeStart.current = performance.now();
    present();
  };

  const respond = (r: Orientation) => {
    const c = cur.current;
    if (!c || !visible) return;
    const dResp = distanceNow() ?? c.dOnset;
    const dMean = c.dSum / c.dN;
    const x = logMARFromStroke(c.strokeMm, dMean);
    const correct = r === c.o;
    staircase.current!.update(x, correct);
    trials.current.push({
      i: trials.current.length + 1,
      orientation: c.o,
      response: r,
      correct,
      requestedLogMAR: c.x,
      strokeDevPx: c.strokeDevPx,
      strokeMm: c.strokeMm,
      distanceCmOnset: c.dOnset,
      distanceCmResponse: dResp,
      distanceCm: dMean,
      logMAR: x,
      rtMs: performance.now() - c.onset,
      distanceSource: cam ? 'camera' : 'manual',
      rawDistance: c.raw ?? undefined,
      ambientLuma: c.luma,
      pausedForDistance: c.paused,
    });
    cur.current = null;
    if (trials.current.length >= TRIALS_PER_EYE) {
      finishEye();
      return;
    }
    setPhase('gap');
    setTimeout(present, 250);
  };

  const finishEye = () => {
    const est = staircase.current!.estimate();
    results.current.push({
      eye,
      trials: trials.current,
      estimate: { logMAR: est.mean, sd: est.sd, mle: est.mle, atBoundary: est.atBoundary, nCorrect: est.nCorrect, n: est.n },
      valid: SESSION_VALID(est.sd, est.atBoundary),
      durationS: (performance.now() - eyeStart.current) / 1000,
    });
    if (eyeIdx + 1 < plan.eyes.length) {
      setEyeIdx(eyeIdx + 1);
      setPhase('instruct');
    } else {
      onDone({
        id: `${new Date().toISOString().replace(/[-:.TZ]/g, '').slice(0, 14)}-${Math.random().toString(36).slice(2, 6)}`,
        dataCategory: 'MEASURED',
        appVersion: APP_VERSION,
        startedAt: startedAt.current,
        endedAt: new Date().toISOString(),
        mode: plan.mode,
        correction: plan.correction,
        experiment: plan.experiment,
        targetDistanceCm: TARGET_DISTANCE_CM,
        distanceWindow: DISTANCE_WINDOW,
        distanceMode: cam ? 'camera' : 'manual',
        device: { userAgent: navigator.userAgent, dpr, cssW: window.innerWidth, cssH: window.innerHeight, mmPerDevicePx: mmPerDevPx },
        screenCalibration: screen,
        distanceCalibration: cam,
        psych: DEFAULT_PSYCH,
        trialsPerEye: TRIALS_PER_EYE,
        eyes: results.current,
        notes: '',
      });
    }
  };

  // keyboard (desktop / bluetooth keyboard)
  useEffect(() => {
    const h = (e: KeyboardEvent) => {
      const m: Record<string, Orientation> = { ArrowRight: 'right', ArrowLeft: 'left', ArrowUp: 'up', ArrowDown: 'down' };
      if (m[e.key]) respond(m[e.key]);
    };
    window.addEventListener('keydown', h);
    return () => window.removeEventListener('keydown', h);
  });

  if (phase === 'instruct') {
    const other = eye === 'OD' ? 'ЛЕВЫЙ' : 'ПРАВЫЙ';
    return (
      <main className="page">
        <h1>{eye === 'OD' ? 'Правый глаз' : 'Левый глаз'}</h1>
        <p className="big">
          Закройте <b>{other}</b> глаз ладонью, не надавливая.
        </p>
        <p>
          На экране появится знак <b>E</b> (как буква «Ш», повёрнутая набок). Нажмите стрелку, куда смотрят его «зубцы». Если не уверены —
          всё равно выберите наугад: это нормально и учтено в расчёте.
        </p>
        {cam && camState === 'loading' && <p className="muted">Включаем камеру…</p>}
        {cam && camState === 'error' && <p className="banner warn">Камера не запустилась. Прервите тест и выберите ручной режим.</p>}
        <div className="actions">
          <button className="btn primary" disabled={!!cam && camState !== 'running'} onClick={beginEye}>
            Начать ({TRIALS_PER_EYE} знаков)
          </button>
          <button className="btn ghost" onClick={onAbort}>
            Прервать
          </button>
        </div>
      </main>
    );
  }

  const msg = { ok: '', near: 'Дальше от лица', far: 'Ближе к лицу', none: 'Лицо не видно камере' }[inWindow];
  return (
    <main className="test">
      <div className="test-top">
        <span>
          {eye} · {trials.current.length + 1}/{TRIALS_PER_EYE}
        </span>
        <span className={`dist ${inWindow}`}>{shownDist != null ? `${shownDist.toFixed(0)} см` : '— см'}</span>
      </div>
      <div className="stage">
        <canvas ref={canvas} className="optocanvas" />
        {phase === 'trial' && inWindow !== 'ok' && <div className="hint">{msg}</div>}
      </div>
      <div className="pad">
        <button aria-label="вверх" className="up" onClick={() => respond('up')}>
          ▲
        </button>
        <button aria-label="влево" className="left" onClick={() => respond('left')}>
          ◀
        </button>
        <button aria-label="вправо" className="right" onClick={() => respond('right')}>
          ▶
        </button>
        <button aria-label="вниз" className="down" onClick={() => respond('down')}>
          ▼
        </button>
      </div>
    </main>
  );
}
