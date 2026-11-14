import type { Session } from '../core/types';
import { assess, correctionRestores } from '../core/baseline';
import { decimalAcuity, snellen20 } from '../core/optics';
import { advise } from './recommend';
import { seriesFor } from './App';

export function ResultView({ session, sessions, onHome }: { session: Session; sessions: Session[]; onHome: () => void }) {
  return (
    <main className="page">
      <h1>Результат</h1>
      <p className="muted small">
        {new Date(session.startedAt).toLocaleString('ru-RU')} · «{session.correction}» ·{' '}
        {session.mode === 'experiment'
          ? `эксперимент ${session.experiment?.experimentId}, участник ${session.experiment?.participantId}, линза ${session.experiment?.addedLensD ?? '—'} D`
          : 'мониторинг'}
      </p>
      <div className="eyes">
        {session.eyes.map((e) => {
          const ser = seriesFor(sessions, e.eye, session.correction);
          const a = session.mode === 'monitor' ? assess(ser.filter((p) => p.t <= session.startedAt)) : null;
          const adv = a ? advise(a) : null;
          // stronger spare glasses: compare against the norm taken with the usual correction
          // "usual" correction = the other label with a complete norm and the most sessions
          const labels = [...new Set(sessions.filter((s) => s.mode === 'monitor' && s.correction !== session.correction).map((s) => s.correction))];
          const ranked = labels
            .map((l) => ({ l, ser: seriesFor(sessions, e.eye, l) }))
            .map((x) => ({ ...x, norm: assess(x.ser).norm }))
            .filter((x) => x.norm)
            .sort((p, q) => q.ser.length - p.ser.length);
          const usual = ranked[0]?.l;
          const usualNorm = ranked[0]?.norm ?? null;
          const restores = usualNorm && a?.status === 'need_baseline' ? correctionRestores(usualNorm, e.estimate.logMAR) : null;
          const dists = e.trials.map((t) => t.distanceCm);
          return (
            <div key={e.eye} className={`eye ${adv ? `tone-${adv.tone}` : ''}`}>
              <div className="eye-h">{e.eye === 'OD' ? 'Правый глаз' : 'Левый глаз'}</div>
              <div className="num">{e.estimate.logMAR.toFixed(2)}</div>
              <div className="muted small">
                logMAR ± {e.estimate.sd.toFixed(2)} · десятичная {decimalAcuity(e.estimate.logMAR).toFixed(2)} · ≈ 20/
                {snellen20(e.estimate.logMAR).toFixed(0)}
              </div>
              <div className="muted small">
                {e.estimate.nCorrect}/{e.estimate.n} верно · {e.durationS.toFixed(0)} с · расстояние {Math.min(...dists).toFixed(0)}–
                {Math.max(...dists).toFixed(0)} см
              </div>
              {!e.valid && <div className="adv-t">Низкое качество — повторите</div>}
              {adv && (
                <>
                  <div className="adv-t">{adv.title}</div>
                  <div className="small">{adv.action}</div>
                </>
              )}
              {restores != null && (
                <div className="small">
                  {restores
                    ? `В «${session.correction}» острота в пределах нормы, полученной в «${usual}»: ухудшение исправляется оптикой.`
                    : `Даже в «${session.correction}» острота хуже нормы «${usual}». Это не объясняется только оптикой — сообщите врачу.`}
                </div>
              )}
            </div>
          );
        })}
      </div>
      <p className="muted small">
        Прототип для исследования. Не ставит диагноз и не заменяет осмотр: SANS выявляется снимками глаза (ОКТ, МРТ,
        осмотр глазного дна), а изменения часто идут без жалоб на зрение.
      </p>
      <div className="actions">
        <button className="btn primary" onClick={onHome}>
          Готово
        </button>
      </div>
    </main>
  );
}
