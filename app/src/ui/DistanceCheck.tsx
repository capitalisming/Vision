import { useEffect, useRef, useState } from 'react';
import type { DistanceCheck, Profile } from '../core/types';
import { median, sd } from '../core/stats';
import { useTracker } from './useTracker';

const CONDITIONS: { v: DistanceCheck['condition']; l: string }[] = [
  { v: 'both-open', l: 'оба глаза открыты' },
  { v: 'left-covered', l: 'левый закрыт ладонью' },
  { v: 'right-covered', l: 'правый закрыт ладонью' },
];

/** Protocol E0 — validation of camera distance against a tape measure. */
export function DistanceCheckView({ profile, onAdd, onHome }: { profile: Profile; onAdd: (c: DistanceCheck) => void; onHome: () => void }) {
  const { state, latest, start } = useTracker(profile.camera);
  const [live, setLive] = useState<number | null>(null);
  const [trueCm, setTrueCm] = useState('40');
  const [cond, setCond] = useState<DistanceCheck['condition']>('both-open');
  const [pid, setPid] = useState('P01');
  const [busy, setBusy] = useState(false);
  const buf = useRef<{ cm: number | null; a: number | null; b: number | null; i: number | null }[]>([]);
  const checks = profile.distanceChecks ?? [];

  useEffect(() => {
    start();
  }, [start]);
  useEffect(() => {
    const id = setInterval(() => {
      const l = latest.current;
      setLive(l.cm);
      if (busy) buf.current.push({ cm: l.cm, a: l.raw?.irisA ?? null, b: l.raw?.irisB ?? null, i: l.raw?.ipd ?? null });
    }, 50);
    return () => clearInterval(id);
  }, [busy, latest]);

  const record = () => {
    buf.current = [];
    setBusy(true);
    setTimeout(() => {
      setBusy(false);
      const rows = buf.current;
      const pick = (k: 'cm' | 'a' | 'b' | 'i') => {
        const v = rows.map((r) => r[k]).filter((x): x is number => x != null);
        return v.length ? median(v) : null;
      };
      const cms = rows.map((r) => r.cm).filter((x): x is number => x != null);
      onAdd({
        at: new Date().toISOString(),
        dataCategory: 'MEASURED',
        participantId: pid,
        trueCm: Number(trueCm.replace(',', '.')),
        condition: cond,
        appCm: pick('cm'),
        irisA: pick('a'),
        irisB: pick('b'),
        ipd: pick('i'),
        frames: cms.length,
        sdCm: cms.length > 1 ? sd(cms) : null,
      });
    }, 1500);
  };

  return (
    <main className="page">
      <h1>Проверка расстояния (опыт E0)</h1>
      {!profile.camera && <p className="banner warn">Сначала откалибруйте камеру на главном экране.</p>}
      <p>
        Помощник держит рулетку от уголка глаза до экрана. Установите нужное расстояние, примите позу, как при тесте, и
        нажмите «Записать» (1,5 с). Повторите для 30, 35, 40, 45, 50 см в каждом из трёх условий.
      </p>
      <div className="num">{live != null ? `${live.toFixed(1)} см` : state === 'running' ? 'лицо не найдено' : '…'}</div>
      <div className="grid2">
        <label className="field">
          <span>Рулетка, см</span>
          <input inputMode="decimal" value={trueCm} onChange={(e) => setTrueCm(e.target.value)} />
        </label>
        <label className="field">
          <span>Участник</span>
          <input value={pid} onChange={(e) => setPid(e.target.value)} />
        </label>
        <label className="field wide">
          <span>Условие</span>
          <select value={cond} onChange={(e) => setCond(e.target.value as DistanceCheck['condition'])}>
            {CONDITIONS.map((c) => (
              <option key={c.v} value={c.v}>
                {c.l}
              </option>
            ))}
          </select>
        </label>
      </div>
      <div className="actions">
        <button className="btn primary" disabled={busy || state !== 'running' || !profile.camera} onClick={record}>
          {busy ? 'Не двигайтесь…' : 'Записать'}
        </button>
        <button className="btn ghost" onClick={onHome}>
          Готово
        </button>
      </div>
      <table className="tbl">
        <thead>
          <tr>
            <th>Рулетка</th>
            <th>Условие</th>
            <th>Камера</th>
            <th>Δ</th>
          </tr>
        </thead>
        <tbody>
          {[...checks].reverse().slice(0, 15).map((c) => (
            <tr key={c.at}>
              <td>{c.trueCm}</td>
              <td>{CONDITIONS.find((x) => x.v === c.condition)?.l}</td>
              <td>{c.appCm?.toFixed(1) ?? '—'}</td>
              <td>{c.appCm != null ? (c.appCm - c.trueCm).toFixed(1) : '—'}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </main>
  );
}
