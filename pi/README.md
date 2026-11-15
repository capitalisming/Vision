<!-- AI-assisted (Claude Code), reviewed by a team member. -->
# pi/: Raspberry Pi 4 camera

There are two ways to use a camera with a Raspberry Pi 4.

1. **The browser on the Pi uses the camera itself.** Open https://capitalisming.github.io/Vision/ (or the app
   served on the Pi at `http://localhost:8000`) in Chromium on the Pi and choose **Camera** in step 3. The
   browser asks for the camera; the list above the picture shows the Pi's cameras. No server is needed.
2. **`camera_server.py` streams the Pi camera to another computer.** It keeps only the newest camera frame in
   memory and serves it at `/frame`. It also serves the app itself, so a laptop on the same network opens the
   app from the Pi and gets its camera. Frames are never written to disk. The face detection (MediaPipe,
   `vendor/`) runs in the laptop's browser; the Pi only streams pictures.

## Camera in Chromium on the Pi (way 1)

- **USB webcam:** Chromium sees it directly. Check that the Pi sees it with `ls /dev/video*` and
  `v4l2-ctl --list-devices` (`sudo apt install v4l-utils`).
- **Camera Module on the ribbon cable:** Raspberry Pi OS drives it through libcamera, which Chromium does not
  use by default, so Chromium reports *No camera was found*. Two ways to make it visible (not yet tried on our
  Pi, see Status):
  - PipeWire: `sudo apt install pipewire-libcamera`, then in Chromium open
    `chrome://flags/#enable-webrtc-pipewire-camera`, set it to *Enabled* and restart Chromium.
  - libcamera's V4L2 wrapper: `sudo apt install libcamera-v4l2`, then start Chromium with
    `libcamerify chromium-browser` (the command is `chromium` on Trixie).
  - Or use way 2 with `--https`.
- **Only one program can hold a camera.** While `camera_server.py` runs, Chromium on the same Pi gets
  *Another program is using the camera*: stop the server, or choose *Raspberry Pi over the network* in the list.
- The picture is asked for at 640x480 on the Pi (1280x720 elsewhere) to spare the CPU. If the GPU does not
  start the face tracker within 8 s, it runs on the CPU.
- Browser version: Chromium 92 or newer (Raspberry Pi OS Bookworm or Trixie). Check at `chrome://version`.

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
3. Open **Test**, fill in step 1 (you) and step 2 (screen), then in step 3 (distance) choose **Camera**. In the
   *Camera* list choose **Raspberry Pi over the network** and leave the address empty. You should see the live
   picture, the eye points and a message such as `No face found`, or the distance.
4. Look at the screen and hold still: the calibration is automatic. *Check with a tape* makes it precise.
   **Each camera has its own calibration**: the app stores it per camera and does not start a camera test for a
   camera that was not calibrated.
   Note: `http://raspberrypi.local:8000` is not a secure page, so there the laptop's own webcam is not
   available, only the Pi camera.
5. Press **Start test**.

### App served by the laptop instead

You can run the app on the laptop and take only the camera from the Pi. Start the server with the laptop
page's origin:

```bash
python3 pi/camera_server.py --allow-origin http://localhost:5178
```

Then enter the Pi address (e.g. `raspberrypi.local:8000`) under *Camera source* in step 3 of the Test flow. Without `--allow-origin` the
server refuses cross-origin reads, so other web pages cannot read the camera.

### From the https GitHub Pages app

An https page may only load an https camera, so start the server with `--https`:

```bash
python3 pi/camera_server.py --https --allow-origin https://capitalisming.github.io
```

1. The first start makes a self-signed certificate for the Pi's name and IP with `openssl` (kept in `pi/.cert/`,
   never served). Your own certificate: `--cert file.pem --key key.pem`.
2. In the laptop's browser open `https://raspberrypi.local:8000/health` (or `https://<pi-ip>:8000/health`) once
   and accept the certificate warning.
3. In the app, step 3, choose *Raspberry Pi over the network* and enter `raspberrypi.local:8000` (https is
   taken from the page). Newer Chrome versions may ask whether the site may access devices on your local
   network: allow it.

## Without a Pi, and running the site locally

`python3 pi/camera_server.py --source fake` serves the app and a moving test pattern. It needs only the Python
standard library, so the whole chain can be tried on any computer. The pattern has no face, so the distance
shows `no_face`.

Careful with `python -m http.server`: on Windows it can serve `.mjs` files as `text/plain`, and the browser then
refuses to load MediaPipe ("Failed to fetch dynamically imported module"). `pi/camera_server.py` and
`node serve.mjs` (open `/index.html`) set the right types.

Tests: `python -m unittest discover -s pi`

## Status and limits

- Tested with `--source fake` (this repository's tests and a browser on macOS): stream into the app, MediaPipe
  running on that stream, camera off/on and release, a camera test that refuses a number when no face is seen,
  and `--https` with a self-signed certificate (Python tests). **Not run on a real Raspberry Pi 4, not with a
  real face, and the Camera Module setup for Chromium above has not been tried by us.** The accuracy of the
  camera distance is unmeasured (Experiment 3 covers it).
- The picamera2 part follows `examples/mjpeg_server_2.py` in raspberrypi/picamera2-examples.
- Anyone on the same network can open the camera page. Use a trusted network, or pass `--host` to limit the
  listening address.

## Checking on a physical Raspberry Pi 4

1. `chrome://version` shows Chromium 92 or newer.
2. Open https://capitalisming.github.io/Vision/: Home shows the iris and no red error line.
3. Test → step 2: calibrate the screen with a card; step 3 → Camera: the browser asks for the camera; after
   *Allow* the list shows the camera's name and the picture appears with the eye points.
4. Hold still: the status says *Calibrated automatically* and the distance appears in cm. Check it once with a
   tape (*Check with a tape*).
5. *Turn camera off*: the camera light goes off. Deny the permission once (site settings): the app says how to
   allow it. Unplug the USB camera: *No camera was found*.
6. Run a test with the camera and one with the tape measure; both appear in History and in the CSV export.
