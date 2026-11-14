<!-- AI-assisted (Claude Code), reviewed by a team member. -->
# pi/: Raspberry Pi 4 camera

`camera_server.py` lets the Vision app use a camera attached to a Raspberry Pi 4. It keeps only the newest
camera frame in memory and serves it at `/frame`. It also serves the app itself, so a laptop on the same network
opens the app from the Pi and gets its camera. Frames are never written to disk.

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
2. Calibrate the screen on that page. Calibration is stored per address, so it has to be done once here too.
3. Go to **Test → Study options**. Set **Distance measured by** to **Camera** and **Camera** to **Raspberry Pi**.
   Leave the address empty.
4. Press **Check camera**. You should see the live picture and a line like `Live · 640×480 · 15 fps`.

### App served by the laptop instead

You can run the app on the laptop (`http://localhost:...`) and take only the camera from the Pi. In that case,
start the server with the laptop page's origin:

```bash
python3 pi/camera_server.py --allow-origin http://localhost:5178
```

Then enter the Pi address (e.g. `raspberrypi.local:8000`) in the app. Without `--allow-origin` the server
refuses cross-origin reads, so other web pages cannot read the camera.

This does **not** work from GitHub Pages: an https page cannot load an http camera.

## Without a Pi

`python3 pi/camera_server.py --source fake` serves a moving test pattern. It needs only the Python standard
library, so the whole chain can be tried on any computer.

Tests: `python -m unittest discover -s pi`

## Status and limits

- The Pi camera reaches the app as an ordinary `<video>` stream (`src/pi-camera.js`). Distance tracking
  (`src/distance.js`, participant 2) must use that stream as it is. Its contract `startDistance(videoEl)` does not
  say yet whether an existing `srcObject` is kept, so this needs the team's agreement.
- Not run on a real Raspberry Pi 4 yet. The picamera2 part follows `examples/mjpeg_server_2.py` in
  raspberrypi/picamera2-examples. The rest was tested with `--source fake`.
- Anyone on the same network can open the camera page. Use a trusted network, or pass `--host` to limit the
  listening address.
- Sessions do not record whether the laptop or the Pi camera was used. This is not part of the data format yet.
