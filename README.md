<!-- AI-assisted (Claude Code), reviewed by a team member. -->
# Vision: astronaut vision self-check (pilot prototype)

A web app for one person to check their own visual acuity, with no operator on the ground. It shows Landolt C
rings sized to the real distance between the eyes and the screen. It keeps a personal baseline and says when a
result is worse than that person's usual range.

NASA Space Apps 2026, challenge *Create Health Monitoring Software for Astronauts on Space Missions*.
This is a pilot prototype that monitors functional vision change. It does not detect any condition and does
not measure diopters.

## Why this test

- **The risk.** NASA tracks the *Risk of Spaceflight Associated Neuro-ocular Syndrome (SANS)*. About 70% of crew
  show at least one of its signs, and one of those signs is a hyperopic shift in refractive error [1].
- **What changes.** After six-month missions to the International Space Station:
  - 6 of 7 astronauts who were examined had worse near vision;
  - five of the seven with near-vision complaints had a hyperopic shift of +0.50 to +1.75 D [2];
  - in a survey of 300 astronauts, about 29% after short missions and 60% after long ones reported worse distant
    and near vision [2].
- **What the app does with it.**
  - By default it tests **near vision at 40 cm**, when the screen can draw logMAR −0.1 there (so good eyes still
    get a number). Otherwise it suggests 1 m and says why.
  - It compares each result with the person's own baseline and flags a result that is worse twice in a row.
  - The same text, with the sources, is in the app under *Why this test*.

On ordinary laptop screens, 40 cm is past the pixel limit for normal vision; on one 96 px/inch test screen the
limit there was logMAR 0.4. That is why the default depends on the screen.

## Run it

```bash
npm run serve          # http://localhost:8000
```

It needs Node.js 18 or newer (22 or newer for `npm test`) and nothing else: there is no build step, no framework and no network access
at run time. Libraries and the face model are in `vendor/`. The camera only works on `http://localhost` or
`https`.

To try it without Node: `python3 pi/camera_server.py --source fake` serves the app at `http://localhost:8000`
with a moving test pattern as the camera.

## Use it

**Test** is one flow in three steps:

1. **You.** Participant code (never a name), which eye, and whether glasses are on.
2. **Screen.** Done once: hold a bank card against the screen and match the outline, so the app knows the size
   of a millimetre. Then check a 100 mm bar with a ruler.
3. **Distance.** *Near · 40 cm* (the default when the screen is sharp enough), *Far · 1 m*, or any other distance. It can be measured in two
   ways:
   - **Tape measure:** you type the distance.
   - **Camera:** it needs a one-time calibration. Sit with your eyes 50 cm from the screen, measured with a tape
     or ruler, and press Calibrate. After that the camera tracks the distance on its own. Each camera has its
     own calibration.

During the test, answer with the arrow keys, or tap or click the arrows on screen. Esc or *Stop* ends the test.

**Progress** shows the advice for the newest test and the trend against the personal baseline. **History**
lists every test and exports `sessions.csv` and `trials.csv`.

A Raspberry Pi 4 can supply the camera; see [pi/README.md](pi/README.md).

## How it decides

- **Test procedure.** First a fast descent from logMAR 1.3, one sign per level. Then five signs per level in
  0.1 steps, until fewer than three of five are correct. The score is
  logMAR = first main level + 0.1 − 0.02 × correct answers.
- **No number without trust.** The test gives no score when:
  - the screen cannot draw the next level (`floor_hit`);
  - level 1.3 is failed (`worse_than_1.3`);
  - the camera loses the face for five trials in a row (`aborted_camera`).
- **Personal baseline.** Built from the first five measured tests with the same participant, eye, glasses and
  distance. The band is the prediction interval mean ± t(0.975, 4) · sd · √(1 + 1/5), and never narrower than
  ±0.10 logMAR.
  - Worse than the band once: *repeat tomorrow*.
  - Worse twice in a row: *persistent change*.
  - Better than the band: *no action*. Practice effects make results improve, so this never raises an alarm.
  - The 0.10 minimum and the two-in-a-row rule are team decisions for this prototype, not a clinical protocol.

## Tests

```bash
npm test               # app logic (Node test runner): test/ and tests/
npm run test:pi        # Raspberry Pi camera server (Python)
```

## Data and analysis

- **Raw data:** `data/raw/` holds the raw exports from the experiments. **It is empty: no measurements on
  people have been made yet**, so this README quotes no accuracy or repeatability numbers.
- **Analysis:** `analysis/analyze.py` turns the exports into every figure and table. See
  [analysis/README.md](analysis/README.md). Synthetic data is only for testing and is labelled as such.

## Limits

- Not tested in microgravity or in a clinical setting.
- Camera distance accuracy has not been measured yet.
- The smallest sign depends on the screen's pixel size and the distance. The app works out this limit and
  reports *Beyond screen* instead of a number.
- No contrast, Amsler grid or blind-spot tests.

## Privacy

- Participants are recorded by code only.
- Camera frames are processed in the browser and never stored.
- Sessions stay in the browser until you export them.
- The only network use is the optional Raspberry Pi camera on your own network.

## Project layout

| Path | What |
|---|---|
| `index.html`, `src/app.js`, `src/styles.css` | Screens and navigation |
| `src/setup-flow.js` | Rules of the three-step Test flow |
| `src/screen-calib.js`, `src/optotype.js`, `src/acuity-test.js`, `src/storage.js` | Screen calibration, ring sizing, test procedure, sessions and export |
| `src/distance.js`, `src/camera-screen.js`, `src/camera-calib.js` | Distance from the camera (MediaPipe), camera step, Experiment 3 recorder |
| `src/baseline.js`, `src/trend-data.js`, `src/ui-trend.js`, `src/ui-action.js` | Personal baseline, trend chart, advice |
| `src/pi-camera.js`, `src/camera-source.js`, `pi/` | Raspberry Pi camera |
| `src/iris.js`, `src/home-scroll.js` | Home screen visuals |
| `analysis/`, `data/raw/` | Analysis script and raw exports |
| `vendor/` | MediaPipe Tasks Vision 1.1.1 and the Face Landmarker model (Apache-2.0), see [vendor/README.md](vendor/README.md) |
| `dev.html` | Dev harness for the camera and baseline modules (`/dev.html`) |

## Sources

1. NASA Human Research Program. *Risk of Spaceflight Associated Neuro-ocular Syndrome (SANS)*. Human Research
   Roadmap. https://humanresearchroadmap.nasa.gov/risks/risk.aspx?i=105
2. Mader TH, Gibson CR, Pass AF, et al. Optic disc edema, globe flattening, choroidal folds, and hyperopic shifts
   observed in astronauts after long-duration space flight. *Ophthalmology*. 2011;118(10):2058–2069.
   doi:10.1016/j.ophtha.2011.06.021 (PMID 21849212)
3. Google. MediaPipe Tasks Vision and Face Landmarker model (Apache-2.0), see [vendor/README.md](vendor/README.md).

## Use of AI

AI tools (Claude Code) were used to write and review code, the interface design and documentation. Every
file written with AI says so in its first line, and team members reviewed the changes. The direction of the
project was also discussed with AI. No measurement, accuracy figure or citation in this repository was
produced by AI.
