import { useEffect, useMemo, useState } from 'react';
import { loadProfile, saveProfile } from '../core/storage';
import type { Eye, Profile, Session } from '../core/types';
import { assess, SessionPoint } from '../core/baseline';
import { advise } from './recommend';
import { ScreenCalibrationView, CameraCalibrationView } from './Calibration';
import { TestSetup, TestRunner, TestPlan } from './Test';
import { ResultView } from './Result';
import { HistoryView } from './History';
import { DistanceCheckView } from './DistanceCheck';
import { decimalAcuity } from '../core/optics';
import { minRenderableLogMAR } from '../core/optics';
import { TARGET_DISTANCE_CM } from '../core/config';

type Screen =
  | { k: 'home' }
  | { k: 'cal-screen' }
  | { k: 'cal-camera' }
  | { k: 'setup' }
  | { k: 'run'; plan: TestPlan }
  | { k: 'result'; session: Session }
  | { k: 'history' }
  | { k: 'distance' };

/** Time-ordered series of one eye under one correction label (monitor mode only). */
export function seriesFor(sessions: Session[], eye: Eye, correction: string): SessionPoint[] {
  return sessions
    .filter((s) => s.mode === 'monitor' && s.correction === correction)
    .flatMap((s) =>
      s.eyes
        .filter((e) => e.eye === eye)
        .map((e) => ({ id: s.id, t: s.startedAt, logMAR: e.estimate.logMAR, sd: e.estimate.sd, valid: e.valid })),
    )
    .sort((a, b) => a.t.localeCompare(b.t));
}

export function App() {
  const [profile, setProfile] = useState<Profile>(() => loadProfile());
  const [screen, setScreen] = useState<Screen>({ k: 'home' });
  const [saveOk, setSaveOk] = useState(true);

  useEffect(() => {
    setSaveOk(saveProfile(profile));
  }, [profile]);

  const update = (f: (p: Profile) => Profile) => setProfile((p) => f(structuredClone(p)));
  const home = () => setScreen({ k: 'home' });

  switch (screen.k) {
    case 'cal-screen':
      return (
        <ScreenCalibrationView
          current={profile.screen}
          onCancel={home}
          onSave={(c) => {
            update((p) => ({ ...p, screen: c }));
            setScreen({ k: 'cal-camera' });
          }}
        />
      );
    case 'cal-camera':
      return (
        <CameraCalibrationView
          onCancel={home}
          onSave={(c) => {
            update((p) => ({ ...p, camera: c }));
            home();
          }}
        />
      );
    case 'setup':
      return <TestSetup profile={profile} onCancel={home} onStart={(plan) => setScreen({ k: 'run', plan })} />;
    case 'run':
      return (
        <TestRunner
          profile={profile}
          plan={screen.plan}
          onAbort={home}
          onDone={(s) => {
            update((p) => ({ ...p, sessions: [...p.sessions, s] }));
            setScreen({ k: 'result', session: s });
          }}
        />
      );
    case 'result':
      return <ResultView session={screen.session} sessions={profile.sessions} onHome={home} />;
    case 'distance':
      return (
        <DistanceCheckView
          profile={profile}
          onHome={home}
          onAdd={(c) => update((p) => ({ ...p, distanceChecks: [...(p.distanceChecks ?? []), c] }))}
        />
      );
    case 'history':
      return <HistoryView profile={profile} setProfile={setProfile} onHome={home} />;
    default:
      return <Home profile={profile} saveOk={saveOk} go={setScreen} />;
  }
}

function Home({ profile, saveOk, go }: { profile: Profile; saveOk: boolean; go: (s: Screen) => void }) {
  const ready = profile.screen != null;
  const lastCorrection = useMemo(() => {
    const m = [...profile.sessions].reverse().find((s) => s.mode === 'monitor');
    return m?.correction ?? null;
  }, [profile.sessions]);
  const devicePx = profile.screen ? profile.screen.mmPerCssPx / window.devicePixelRatio : null;
  const floor = devicePx ? minRenderableLogMAR(devicePx, TARGET_DISTANCE_CM) : null;

  return (
    <main className="page">
      <header className="brand">
        <div className="mark" aria-hidden>
          E
        </div>
        <div>
          <h1>Монитор зрения вблизи</h1>
          <p className="muted">Самоконтроль остроты зрения на 40 см · прототип, не медицинское изделие</p>
        </div>
      </header>

      {!saveOk && <p className="banner warn">Хранилище браузера недоступно: результаты не сохранятся. Экспортируйте их после теста.</p>}

      <section className="card">
        <h2>Калибровка</h2>
        <dl className="kv">
          <dt>Экран</dt>
          <dd>
            {profile.screen
              ? `${(25.4 / devicePx!).toFixed(0)} пикс./дюйм · предел ${floor!.toFixed(2)} logMAR`
              : 'не откалиброван'}
          </dd>
          <dt>Камера</dt>
          <dd>{profile.camera ? `откалибрована на ${profile.camera.distanceCm} см` : 'нет (ручной режим расстояния)'}</dd>
        </dl>
        {floor != null && floor > -0.1 && (
          <p className="banner warn">
            Экран слишком грубый: самый мелкий знак соответствует {floor.toFixed(2)} logMAR. Нормальное зрение
            может оказаться «лучше экрана». Используйте телефон с высокой плотностью пикселей.
          </p>
        )}
        <button className="btn ghost" onClick={() => go({ k: 'cal-screen' })}>
          {ready ? 'Перекалибровать' : 'Начать калибровку'}
        </button>
      </section>

      {lastCorrection && (
        <section className="card">
          <h2>Личная норма · «{lastCorrection}»</h2>
          <div className="eyes">
            {(['OD', 'OS'] as Eye[]).map((eye) => {
              const ser = seriesFor(profile.sessions, eye, lastCorrection);
              const a = assess(ser);
              const adv = advise(a);
              const last = ser[ser.length - 1];
              return (
                <div key={eye} className={`eye tone-${adv.tone}`}>
                  <div className="eye-h">{eye === 'OD' ? 'Правый глаз' : 'Левый глаз'}</div>
                  <div className="num">{last ? last.logMAR.toFixed(2) : '—'}</div>
                  <div className="muted small">
                    logMAR{last ? ` · десятичная ${decimalAcuity(last.logMAR).toFixed(2)}` : ''}
                    {a.norm ? ` · норма ${a.norm.mean.toFixed(2)} ± ${a.norm.limit.toFixed(2)}` : ''}
                  </div>
                  <div className="adv-t">{adv.title}</div>
                  <div className="small">{adv.action}</div>
                </div>
              );
            })}
          </div>
        </section>
      )}

      <div className="actions">
        <button className="btn primary" disabled={!ready} onClick={() => go({ k: 'setup' })}>
          Пройти тест (≈ 2 мин)
        </button>
        <button className="btn ghost" onClick={() => go({ k: 'history' })}>
          История и экспорт данных
        </button>
        <button className="btn ghost" disabled={!profile.camera} onClick={() => go({ k: 'distance' })}>
          Проверка расстояния (опыт E0)
        </button>
      </div>
      <p className="muted small foot">
        Все данные хранятся только на этом устройстве. Камера используется для измерения расстояния; изображения не
        сохраняются и никуда не передаются.
      </p>
    </main>
  );
}
