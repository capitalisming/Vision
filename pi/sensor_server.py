#!/usr/bin/env python3
# AI-assisted (Claude Code), reviewed by a team member.
"""Sensor server for the optional sensor module on a Raspberry Pi 4.

Reads the HC-SR04 ultrasonic distance sensor (and, if present, the ambient light estimate of the Camera
Module 2) and sends the numbers to every connected browser over WebSocket, one JSON message every 60 ms:

    {"v":1,"mm":512,"ok":1,"lux":310.5}

mm is the raw distance in millimetres (integer, no calibration offset and no averaging on the Pi: the browser
takes the median and adds the offset). ok = 0 and mm = null when the reading failed or is outside 100-2000 mm.
lux is the camera's exposure-based estimate, or null without a camera.

Also serves the pi/ folder over http (port 8000), so pi/status.html can be shown on the Pi's monitor.

Camera frames are never saved or sent; only numbers leave the Pi. Nothing is written to disk.

    python3 pi/sensor_server.py               # HC-SR04 + Camera Module 2
    python3 pi/sensor_server.py --no-camera   # HC-SR04 only, lux = null

Packages (apt, no pip): python3-gpiozero python3-lgpio python3-websockets python3-picamera2
"""

import argparse
import asyncio
import functools
import json
import signal
import threading
import time
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

# HC-SR04 wiring (Raspberry Pi 4, BCM numbering; gpiozero counts BCM numbers, not header pins).
TRIG_PIN = 23  # physical pin 16, green wire
ECHO_PIN = 24  # physical pin 18, purple wire. Echo goes through a 1 kOhm / 2 kOhm voltage divider:
#                the sensor drives Echo at 5 V and a Pi input takes 3.3 V at most. Never connect Echo directly.
MAX_DISTANCE_M = 2.0

MIN_MM = 100  # readings outside [MIN_MM, MAX_MM) are sent as ok = 0
MAX_MM = 2000  # gpiozero clamps anything farther than max_distance to exactly 2000 mm, so 2000 means "too far"
PERIOD_S = 0.060  # one message every 60 ms
FRESH_S = 0.200  # a reading older than this counts as failed (gpiozero keeps the last good value on failure)
LUX_FRESH_S = 2.0

WS_PORT = 8765
HTTP_PORT = 8000
PI_DIR = Path(__file__).resolve().parent


def log(*parts):
    print(time.strftime('%H:%M:%S'), *parts, flush=True)


# --- message format (contract) ---------------------------------------------------------------------------

def reading_message(mm, lux):
    """The 60 ms message. mm: raw distance in mm or None; lux: float or None."""
    ok = mm is not None and MIN_MM <= mm < MAX_MM
    return {'v': 1, 'mm': int(round(mm)) if ok else None, 'ok': 1 if ok else 0,
            'lux': None if lux is None else round(float(lux), 1)}


def hello_message(camera):
    return {'v': 1, 'hello': 'sensor-pi', 'camera': bool(camera)}


def clients_message(n):
    """Sent when the number of connected clients changes; pi/status.html shows it. Not a reading:
    src/hw-link.js ignores it."""
    return {'v': 1, 'clients': n}


def dumps(msg):
    return json.dumps(msg, separators=(',', ':'))


# --- HC-SR04 ----------------------------------------------------------------------------------------------

def make_distance_sensor(echo=ECHO_PIN, trigger=TRIG_PIN, max_distance=MAX_DISTANCE_M, pin_factory=None):
    """gpiozero DistanceSensor that also remembers when its last successful read happened.

    gpiozero (2.0.1) reads the sensor in a background thread every 60 ms (sample_wait=0.06) and silently
    skips failed reads, keeping the previous value. Without a timestamp a dead sensor would keep reporting its
    last distance, so _read() is wrapped to record the time of each successful read. queue_len=1: no
    smoothing on the Pi, the browser takes the median.
    """
    from gpiozero import DistanceSensor  # imported here so the rest of this file works without gpiozero

    class StampedDistanceSensor(DistanceSensor):
        def __init__(self, *args, **kwargs):
            # Set before DistanceSensor.__init__, which starts the reading thread (and before gpiozero
            # freezes the attribute set at the end of construction).
            self.last_ok_at = None
            self.last_fraction = None
            super().__init__(*args, **kwargs)

        def _read(self):
            value = super()._read()
            if value is not None:
                self.last_fraction = value
                self.last_ok_at = time.monotonic()
            return value

    return StampedDistanceSensor(echo=echo, trigger=trigger, max_distance=max_distance, queue_len=1,
                                 partial=True, pin_factory=pin_factory)


class DistanceReader:
    """read() -> raw distance in mm (float), or None when there was no successful read in the last FRESH_S."""

    def __init__(self, sensor, max_distance=MAX_DISTANCE_M, clock=time.monotonic):
        self._sensor = sensor
        self._max_mm = max_distance * 1000.0
        self._clock = clock

    def read(self):
        at, fraction = self._sensor.last_ok_at, self._sensor.last_fraction
        if at is None or fraction is None or self._clock() - at > FRESH_S:
            return None
        return fraction * self._max_mm

    def close(self):
        self._sensor.close()


# --- Camera Module 2: ambient light estimate --------------------------------------------------------------

class LuxReader:
    """Keeps the newest 'Lux' value from picamera2 frame metadata. The image itself is dropped at once.

    'Lux' is the camera pipeline's estimate from exposure and gain, not a light-meter reading.
    """

    def __init__(self):
        self._lux = None
        self._at = 0.0
        self._stop = threading.Event()
        self._camera = None
        self._thread = None

    def start(self):
        """Returns True if the camera started; False (and logs why) otherwise."""
        try:
            from picamera2 import Picamera2
            camera = Picamera2()
            camera.configure(camera.create_preview_configuration(main={'size': (640, 480)}))
            camera.start()
        except Exception as e:  # no camera, no picamera2, camera busy (e.g. pi/camera_server.py running)
            log(f'camera: not available ({type(e).__name__}: {e}); continuing without light readings')
            return False
        self._camera = camera
        self._thread = threading.Thread(target=self._loop, name='lux', daemon=True)
        self._thread.start()
        return True

    def _loop(self):
        while not self._stop.is_set():
            try:
                lux = self._camera.capture_metadata().get('Lux')
            except Exception as e:
                log(f'camera: metadata read failed ({type(e).__name__}: {e})')
                time.sleep(1.0)
                continue
            if isinstance(lux, (int, float)):
                self._lux, self._at = float(lux), time.monotonic()

    def read(self):
        if self._lux is None or time.monotonic() - self._at > LUX_FRESH_S:
            return None
        return self._lux

    def close(self):
        self._stop.set()
        if self._thread:
            self._thread.join(timeout=2)
        if self._camera:
            try:
                self._camera.stop()
                self._camera.close()
            except Exception:
                pass


class NoLux:
    def read(self):
        return None

    def close(self):
        pass


# --- WebSocket server -------------------------------------------------------------------------------------

class SensorHub:
    """Connected clients, the hello message and the 60 ms broadcast loop."""

    def __init__(self, distance, lux, camera, period_s=PERIOD_S):
        self.distance = distance
        self.lux = lux
        self.camera = camera
        self.period_s = period_s
        self.clients = set()

    async def handler(self, ws, *_path):  # *_path: older websockets versions pass the request path too
        self.clients.add(ws)
        peer = getattr(ws, 'remote_address', None)
        log(f'client connected {peer}; clients: {len(self.clients)}')
        try:
            await ws.send(dumps(hello_message(self.camera)))
            self._send_all(clients_message(len(self.clients)))
            async for _ in ws:  # clients have nothing to say; just wait for them to leave
                pass
        except Exception:
            pass
        finally:
            self.clients.discard(ws)
            log(f'client left {peer}; clients: {len(self.clients)}')
            self._send_all(clients_message(len(self.clients)))

    def _send_all(self, msg):
        if self.clients:
            import websockets
            websockets.broadcast(self.clients, dumps(msg))  # does not wait for slow clients

    def current_message(self):
        return reading_message(self.distance.read(), self.lux.read())

    async def broadcast_loop(self):
        loop = asyncio.get_running_loop()
        next_at = loop.time()
        while True:
            self._send_all(self.current_message())
            next_at += self.period_s
            delay = next_at - loop.time()
            if delay < 0:  # fell behind (e.g. system busy): skip, do not burst
                next_at, delay = loop.time(), 0
            await asyncio.sleep(delay)


async def serve(hub, host, port, stop):
    import websockets
    async with websockets.serve(hub.handler, host, port):
        log(f'websocket: ws://{host}:{port}')
        task = asyncio.create_task(hub.broadcast_loop())
        try:
            await stop.wait()
        finally:
            task.cancel()


# --- http: pi/ folder for status.html ---------------------------------------------------------------------

class QuietHandler(SimpleHTTPRequestHandler):
    def log_message(self, *args):
        pass

    def end_headers(self):
        self.send_header('Cache-Control', 'no-store')
        super().end_headers()


def start_http(host, port):
    handler = functools.partial(QuietHandler, directory=str(PI_DIR))
    httpd = ThreadingHTTPServer((host, port), handler)
    threading.Thread(target=httpd.serve_forever, name='http', daemon=True).start()
    log(f'http: http://{host}:{port}/status.html')
    return httpd


def main(argv=None):
    p = argparse.ArgumentParser(description=__doc__.split('\n\n')[0])
    p.add_argument('--no-camera', action='store_true', help='HC-SR04 only; lux is always null')
    p.add_argument('--host', default='0.0.0.0')
    p.add_argument('--port', type=int, default=WS_PORT, help=f'WebSocket port (default {WS_PORT})')
    p.add_argument('--http-port', type=int, default=HTTP_PORT,
                   help=f'port for pi/status.html (default {HTTP_PORT}; 0 = off)')
    args = p.parse_args(argv)

    sensor = make_distance_sensor()
    distance = DistanceReader(sensor)
    log(f'HC-SR04: trigger GPIO{TRIG_PIN}, echo GPIO{ECHO_PIN}, max {MAX_DISTANCE_M} m, '
        f'pin factory {type(sensor.pin_factory).__name__}')

    lux = NoLux()
    camera = False
    if args.no_camera:
        log('camera: off (--no-camera)')
    else:
        reader = LuxReader()
        if reader.start():
            lux, camera = reader, True
            log('camera: on (ambient light estimate from frame metadata; frames are not kept)')

    httpd = start_http(args.host, args.http_port) if args.http_port else None
    hub = SensorHub(distance, lux, camera)

    async def run():
        stop = asyncio.Event()
        loop = asyncio.get_running_loop()
        for sig in (signal.SIGINT, signal.SIGTERM):
            loop.add_signal_handler(sig, stop.set)
        await serve(hub, args.host, args.port, stop)

    try:
        asyncio.run(run())
    finally:
        log('stopping')
        if httpd:
            httpd.shutdown()
        lux.close()
        distance.close()


if __name__ == '__main__':
    main()
