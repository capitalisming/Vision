# Монитор зрения вблизи (Near Vision Monitor)

Самостоятельный тест остроты зрения вблизи для астронавтов. Человек проверяет себя сам: без врача и без оператора с Земли. Телефон показывает знаки E на 40 см, каждому глазу отдельно. Фронтальная камера контролирует расстояние. Результат сравнивается с **личной нормой**, то есть с собственным разбросом человека.

> Статус (2026-11-14): ПО написано и проверено, **опыты с людьми не проводились, экспериментальных данных нет**. Исследовательский прототип, не медицинское изделие.

## Что где

| Путь | Что |
|---|---|
| `docs/01_materials_audit.md` | Аудит материалов: проверка утверждений по источникам, найденные проблемы (P1–P7), источники ошибок |
| `docs/02_protocol.md` | Протокол опытов E0–E3 с критериями успеха, зафиксированными заранее |
| `docs/03_experiment_register.md` | Реестр: что проведено, что ждёт (включая неудачные варианты) |
| `docs/04_results.md` | Results / Discussion / Limitations / Conclusion |
| `docs/references.md` | Источники, каждый открыт и проверен |
| `docs/templates/` | Журнал опыта (CSV) и случайный порядок линз для E1 |
| `app/` | Приложение: React + TypeScript + Vite, MediaPipe Face Landmarker (работает офлайн) |
| `analysis/` | Обработка на Python: пересчёт порогов из сырых попыток, статистика, графики, симуляции |
| `data/raw/` | Сюда класть экспорты приложения (`nvm-profile-*.json`). **Пусто** |
| `data/simulated/` | Синтетический набор E1 (`dataCategory: SIMULATED`), только для проверки пайплайна |
| `results/` | `calculated/` (C1–C3), `simulated/` (S1–S2), `simulated_pipeline_demo/` (S3), `measured/` (сейчас `NO_DATA`) |
| `site/index.html` | Страница проекта |

Каждая запись данных и каждый график помечены категорией: **MEASURED** (измерено), **CALCULATED** (рассчитано по формулам), **SIMULATED** (синтетика, на графиках водяной знак) или **PROPOSED** (предложено, не реализовано).

## Запуск приложения

Нужен Node.js ≥ 20.

```bash
cd app && npm ci
```

```bash
npm run build
```

```bash
npm run preview
```

`build` скачивает модель распознавания лица (3,6 МБ, Apache-2.0) в `public/models/` и копирует WASM в `public/wasm/`. Камера в браузере работает только по HTTPS или на `localhost`. Чтобы открыть приложение с телефона, используйте GitHub Pages (ниже) или любой HTTPS-хостинг папки `app/dist`.

Тесты:

```bash
cd app && npx vitest run
```

```bash
cd app && npx vite preview --port 4173 & node tests/e2e.mjs
```

Сквозной тест (`tests/e2e.mjs`) требует Playwright. Робот проходит тест, считывает каждый знак из пикселей canvas и сверяет его с журналом. Ответы робота синтетические.

## Воспроизведение анализа

Нужен Python ≥ 3.11.

```bash
cd analysis && pip install -r requirements.txt
```

```bash
python -m pytest -q
```

```bash
python simulate.py
```

```bash
python run_analysis.py
```

```bash
python run_analysis.py --input ../data/simulated --category SIMULATED --out ../results/simulated_pipeline_demo
```

```bash
../site/build.sh
```

- `simulate.py` строит C1–C3 и S1–S3. Он детерминирован (фиксированный seed) и работает около 1 минуты.
- `run_analysis.py` читает `data/raw/*.json` и пишет в `results/measured/` таблицы (`trials.csv`, `eye_estimates.csv`, `lens_detection.csv`, `distance_agreement.csv`, …), `summary.json` с SHA-256 входных файлов и графики PNG + SVG. Исходные файлы не изменяются. Данные другой категории игнорируются, поэтому синтетика не попадает в результаты измерений.

## Как провести опыты

См. `docs/02_protocol.md`. Коротко: E0 (рулетка против камеры, 10 мин) → E1 (очки для чтения +1…+4 D, ~25 мин на человека) → E2 (5–7 дней по одному тесту). Экспорт: в приложении «История → Экспорт JSON», файл положить в `data/raw/`, затем запустить `python analysis/run_analysis.py`.

## Прототип участника 2: камера, норма, действия

Отдельный минимальный прототип по контракту модулей команды (vanilla ES-модули, без сборки):
`src/distance.js`, `src/camera-calib.js`, `src/baseline.js`, `src/ui-trend.js`, `src/ui-action.js`.
Библиотека MediaPipe, WASM и модель лежат в `vendor/` и грузятся локально — интернет во время
работы страницы не нужен.

```bash
python -m http.server 8123
```

Откройте `http://127.0.0.1:8123/` (камера в браузере работает только на `localhost` или HTTPS).
По умолчанию экран тренда и экрана действий показывают **DEMO**-сеансы; если в `localStorage`
лежит ключ `nvm_sessions` (экспорт участника 1), используется он.

Тесты нормы и CSV (Node.js ≥ 20, без зависимостей):

```bash
node --test tests/baseline.test.mjs tests/distance.test.mjs tests/camera-calib.test.mjs
```

Проверка, что MediaPipe и модель грузятся из `vendor/` без сети: откройте
`http://127.0.0.1:8123/tests/vendor-smoke.html` — должно появиться «OK — … created from local
vendor files».

Версия и лицензии сторонних файлов, их SHA-256 и команды обновления — в `vendor/README.md`.

Калибровка камеры личная: `k` хранится в `localStorage` под ключом `cam_k_<participant>`.
Расстояние — медиана длины отрезка между наружными уголками глаз за 0,5 с; `mm = k / eyeSpanPx`.
Порог личной нормы 0,10 logMAR и правило двух сеансов — решения команды, а не клиническая норма;
это написано на экране действий.

## Публикация (GitHub Pages)

`.github/workflows/pages.yml` собирает приложение и страницу проекта. Включите в настройках репозитория **Settings → Pages → Source: GitHub Actions**. После этого страница будет доступна по адресу `https://<owner>.github.io/<repo>/`, а приложение — по `…/app/`.
