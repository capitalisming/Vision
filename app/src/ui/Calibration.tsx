import { useEffect, useRef, useState } from 'react';
import type { ScreenCalibration } from '../core/types';
import { ID1_LONG_MM, ID1_SHORT_MM, TARGET_DISTANCE_CM } from '../core/config';
import { calibrate, DistanceCalibration, FaceFeaturesPx } from '../core/distance';
import { useTracker } from './useTracker';

/**
 * Screen scale: the user lays a bank card (ISO/IEC 7810 ID-1, 85.60 × 53.98 mm) upright on
 * the screen and widens a rectangle until its width equals the card's SHORT side.
 */
export function ScreenCalibrationView({
  current,
  onSave,
  onCancel,
}: {
  current: ScreenCalibration | null;
  onSave: (c: ScreenCalibration) => void;
  onCancel: () => void;
}) {
  const initial = current ? ID1_SHORT_MM / current.mmPerCssPx : 300;
  const [w, setW] = useState(initial);
  const maxW = Math.min(window.innerWidth - 8, 700);
  const minW = 120;
  const h = (w * ID1_LONG_MM) / ID1_SHORT_MM;
  const mmPerCssPx = ID1_SHORT_MM / w;
  const ppi = 25.4 / (mmPerCssPx / window.devicePixelRatio);
  return (
    <main className="page">
      <h1>Шаг 1. Размер экрана</h1>
      <p>
        Приложите банковскую карту к экрану <b>вертикально</b> (короткой стороной по горизонтали) к левому верхнему углу
        рамки. Двигайте ползунок, пока рамка не совпадёт с картой <b>точно по ширине</b>. Смотрите на край строго сверху.
      </p>
      <div className="cardbox" style={{ width: w, height: h }} />
      <input
        className="slider"
        type="range"
        min={minW}
        max={maxW}
        step={0.25}
        value={w}
        onChange={(e) => setW(+e.target.value)}
        aria-label="Ширина рамки"
      />
      <div className="row">
        <button className="btn ghost" onClick={() => setW((x) => x - 0.25)}>
          − тоньше
        </button>
        <button className="btn ghost" onClick={() => setW((x) => x + 0.25)}>
          + шире
        </button>
      </div>
      <p className="muted small">
        Оценка: {ppi.toFixed(0)} пикселей на дюйм · 1 пиксель = {((mmPerCssPx / window.devicePixelRatio) * 1000).toFixed(1)} мкм.
        Ошибка ширины в 1 мм даёт ошибку размера знаков ≈ 1,9 % (0,008 logMAR).
      </p>
      <div className="actions">
        <button className="btn primary" onClick={() => onSave({ mmPerCssPx, method: 'id1-card', at: new Date().toISOString() })}>
          Совпадает — дальше
        </button>
        <button className="btn ghost" onClick={onCancel}>
          Отмена
        </button>
      </div>
    </main>
  );
}

/**
 * Camera: the user holds the phone so that eyes→screen = 40 cm, checked with a tape measure
 * or a 40 cm string, and keeps still while 45 frames are collected.
 */
export function CameraCalibrationView({
  onSave,
  onCancel,
}: {
  onSave: (c: DistanceCalibration | null) => void;
  onCancel: () => void;
}) {
  const { state, tracker, lastFrame, start } = useTracker(null);
  const [collecting, setCollecting] = useState(false);
  const [result, setResult] = useState<DistanceCalibration | null>(null);
  const samples = useRef<FaceFeaturesPx[]>([]);
  const preview = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (state === 'running' && preview.current && tracker.current) {
      const v = tracker.current.video;
      v.className = 'preview';
      preview.current.appendChild(v);
    }
  }, [state, tracker]);

  useEffect(() => {
    if (!collecting || !lastFrame) return;
    if (lastFrame.features) samples.current.push(lastFrame.features);
    if (samples.current.length >= 45) {
      setCollecting(false);
      setResult(calibrate(samples.current, TARGET_DISTANCE_CM, lastFrame.frameW, lastFrame.frameH));
    }
  }, [lastFrame, collecting]);

  const faces = lastFrame?.faces ?? 0;
  return (
    <main className="page">
      <h1>Шаг 2. Камера и расстояние</h1>
      <p>
        Камера будет следить за расстоянием от глаз до экрана. Для этого один раз нужна рулетка или нитка длиной{' '}
        <b>{TARGET_DISTANCE_CM} см</b>: держите телефон так, чтобы от глаз до экрана было ровно {TARGET_DISTANCE_CM} см,
        оба глаза открыты, смотрите в экран, и нажмите «Зафиксировать».
      </p>
      {state === 'idle' && (
        <button className="btn primary" onClick={start}>
          Включить камеру
        </button>
      )}
      {state === 'loading' && <p className="muted">Загрузка модели распознавания лица…</p>}
      {state === 'error' && (
        <p className="banner warn">Камера недоступна. Можно продолжить в ручном режиме: держите телефон на нитке 40 см.</p>
      )}
      <div ref={preview} className="preview-box" />
      {state === 'running' && (
        <p className="muted small">
          Лиц в кадре: {faces} {faces !== 1 && '— нужно ровно одно лицо'}
          {lastFrame?.features?.irisA ? ` · радужка ${lastFrame.features.irisA.toFixed(1)} пикс.` : ''}
        </p>
      )}
      {result && (
        <p className="banner ok">
          Калибровка: K(радужка A) = {result.kIrisA?.toFixed(0) ?? '—'}, K(радужка B) = {result.kIrisB?.toFixed(0) ?? '—'},
          K(межзрачковое) = {result.kIpd?.toFixed(0) ?? '—'} пикс.·см
        </p>
      )}
      <div className="actions">
        {state === 'running' && !result && (
          <button
            className="btn primary"
            disabled={faces !== 1 || collecting}
            onClick={() => {
              samples.current = [];
              setCollecting(true);
            }}
          >
            {collecting ? `Не двигайтесь… ${samples.current.length}/45` : 'Зафиксировать 40 см'}
          </button>
        )}
        {result && (
          <button
            className="btn primary"
            onClick={() => {
              tracker.current?.stop();
              onSave(result);
            }}
          >
            Сохранить
          </button>
        )}
        <button
          className="btn ghost"
          onClick={() => {
            tracker.current?.stop();
            onSave(null);
          }}
        >
          Без камеры (ручной режим)
        </button>
        <button
          className="btn ghost"
          onClick={() => {
            tracker.current?.stop();
            onCancel();
          }}
        >
          Отмена
        </button>
      </div>
    </main>
  );
}
