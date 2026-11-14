import { useRef } from 'react';
import type { Profile } from '../core/types';
import { distanceChecksCsv, download, emptyProfile, trialsCsv } from '../core/storage';

export function HistoryView({ profile, setProfile, onHome }: { profile: Profile; setProfile: (p: Profile) => void; onHome: () => void }) {
  const file = useRef<HTMLInputElement>(null);
  const stamp = new Date().toISOString().slice(0, 10);
  const ss = [...profile.sessions].reverse();
  return (
    <main className="page">
      <h1>История</h1>
      <div className="actions row">
        <button className="btn ghost" onClick={() => download(`nvm-profile-${stamp}.json`, JSON.stringify(profile, null, 1), 'application/json')}>
          Экспорт JSON (всё)
        </button>
        <button className="btn ghost" onClick={() => download(`nvm-trials-${stamp}.csv`, trialsCsv(profile.sessions), 'text/csv')}>
          Экспорт CSV (попытки)
        </button>
        <button className="btn ghost" onClick={() => download(`nvm-distance-${stamp}.csv`, distanceChecksCsv(profile.distanceChecks ?? []), 'text/csv')}>
          Экспорт CSV (расстояние E0)
        </button>
        <button className="btn ghost" onClick={() => file.current?.click()}>
          Импорт JSON
        </button>
        <input
          ref={file}
          type="file"
          accept="application/json"
          hidden
          onChange={async (e) => {
            const f = e.target.files?.[0];
            if (!f) return;
            try {
              const p = JSON.parse(await f.text()) as Profile;
              if (p.version !== 1 || !Array.isArray(p.sessions)) throw new Error('format');
              setProfile(p);
            } catch {
              alert('Файл не похож на экспорт этого приложения.');
            }
          }}
        />
      </div>
      <table className="tbl">
        <thead>
          <tr>
            <th>Дата</th>
            <th>Режим</th>
            <th>Коррекция</th>
            <th>OD</th>
            <th>OS</th>
          </tr>
        </thead>
        <tbody>
          {ss.map((s) => {
            const v = (eye: 'OD' | 'OS') => {
              const e = s.eyes.find((x) => x.eye === eye);
              return e ? `${e.estimate.logMAR.toFixed(2)}${e.valid ? '' : ' ⚠'}` : '—';
            };
            return (
              <tr key={s.id}>
                <td>{new Date(s.startedAt).toLocaleString('ru-RU', { dateStyle: 'short', timeStyle: 'short' })}</td>
                <td>{s.mode === 'experiment' ? `${s.experiment?.participantId} · ${s.experiment?.addedLensD ?? '—'} D` : 'монит.'}</td>
                <td>{s.correction}</td>
                <td>{v('OD')}</td>
                <td>{v('OS')}</td>
              </tr>
            );
          })}
          {ss.length === 0 && (
            <tr>
              <td colSpan={5} className="muted">
                Сессий пока нет
              </td>
            </tr>
          )}
        </tbody>
      </table>
      <p className="muted small">⚠ — сессия не прошла проверку качества и не используется в норме. Неудачные сессии не удаляются.</p>
      <div className="actions">
        <button className="btn primary" onClick={onHome}>
          На главную
        </button>
        <button
          className="btn danger"
          onClick={() => {
            if (confirm('Удалить все данные с этого устройства? Сначала сделайте экспорт.')) setProfile(emptyProfile());
          }}
        >
          Удалить все данные
        </button>
      </div>
    </main>
  );
}
