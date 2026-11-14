<!-- AI-assisted (Claude Code), reviewed by a team member. -->
# pi/: Raspberry Pi 4 camera

`camera_server.py` lets the Vision app use a camera attached to a Raspberry Pi 4. It keeps only the newest
camera frame in memory and serves it at `/frame`. It also serves the app itself, so a laptop on the same network
opens the app from the Pi and gets its camera. Frames are never written to disk.

The face detection (MediaPipe, `vendor/`) runs in the laptop's browser. The Pi only streams pictures.

## Run on the Pi

Raspberry Pi OS (Bookworm) with either camera:

- **Pi Camera Module (CSI ribbon):** uses `picamera2` and the Pi's hardware MJPEG encoder. If it is missing,
  install it with `sudo apt install python3-picamera2`.
- **USB webcam:** uses OpenCV. Install it with `sudo apt install python3-opencv`.

```bash
git clone <this repository> && cd Vision
python3 pi/camera_server.py
```

It prints the camera it found. `--source picamera2` or `--source opencv` forces one, and `--device 1` picks
another USB camera. Defaults: 640x480, port 8000.

## Use it from the laptop

1. Open `http://raspberrypi.local:8000/` (or `http://<pi-ip>:8000/`; on the Pi, `hostname -I` shows the IP).
2. Calibrate the screen on that page. Screen calibration is stored per address, so it has to be done once here too.
3. Open **Camera** and choose **Raspberry Pi**. Leave the address empty. You should see the live picture, the
   eye points and `no_face` or a distance.
4. Calibrate the camera on the same screen (sit at the known distance, press Save). **Each camera has its own
   calibration**: the app stores it per camera and refuses a camera test for a camera that was not calibrated.
5. **Test → Study options → Distance measured by → Camera**. The line below it names the camera that will be used.

### App served by the laptop instead

You can run the app on the laptop and take only the camera from the Pi. Start the server with the laptop
page's origin:

```bash
python3 pi/camera_server.py --allow-origin http://localhost:5178
```

Then enter the Pi address (e.g. `raspberrypi.local:8000`) on the Camera screen. Without `--allow-origin` the
server refuses cross-origin reads, so other web pages cannot read the camera.

This does **not** work from GitHub Pages: an https page cannot load an http camera.

## Without a Pi, and running the site locally

`python3 pi/camera_server.py --source fake` serves the app and a moving test pattern. It needs only the Python
standard library, so the whole chain can be tried on any computer. The pattern has no face, so the distance
shows `no_face`.

Careful with `python -m http.server`: on Windows it can serve `.mjs` files as `text/plain`, and the browser then
refuses to load MediaPipe ("Failed to fetch dynamically imported module"). `pi/camera_server.py` and
`node serve.mjs` (open `/index.html`) set the right types.

Tests: `python -m unittest discover -s pi`

## Status and limits

- Tested with `--source fake`: stream into the app, MediaPipe running on that stream, calibration guard,
  camera test that refuses a number when no face is seen. Not run on a real Raspberry Pi 4 and not with a real
  face yet, so the accuracy of the distance from the Pi camera is unmeasured (Experiment 3 covers it).
- The picamera2 part follows `examples/mjpeg_server_2.py` in raspberrypi/picamera2-examples.
- `src/distance.js` (participant 2) got a small change so that the Pi stream can be used:
  `setCameraProvider(provider, id)`, calibration stored per camera id, and `startDistance` starts again when its
  video has no stream. The default webcam path is unchanged.
- Anyone on the same network can open the camera page. Use a trusted network, or pass `--host` to limit the
  listening address.
