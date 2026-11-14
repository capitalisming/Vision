#!/usr/bin/env python3
# AI-assisted (Claude Code), reviewed by a team member.
"""Camera server for a Raspberry Pi 4.

Serves the newest camera frame at /frame and the Vision app itself, so a laptop on the same network can open
http://<pi-address>:8000/ and use the Pi camera for distance tracking. Opening the app from the Pi keeps the
page and the frames on one origin: no CORS, and no https page blocked from loading an http camera.

Only the newest frame is kept, in memory. Nothing is written to disk and nothing is sent anywhere else.

    python3 pi/camera_server.py                 # Pi Camera Module (picamera2), else a USB camera (OpenCV)
    python3 pi/camera_server.py --source fake   # moving test pattern, no camera or extra packages needed
"""

import argparse
import json
import struct
import threading
import time
from functools import partial
from http import HTTPStatus
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from io import BufferedIOBase
from pathlib import Path
from urllib.parse import urlsplit

REPO_ROOT = Path(__file__).resolve().parent.parent


class FrameBuffer:
    """The newest encoded frame and when it arrived (monotonic clock)."""

    def __init__(self):
        self._lock = threading.Lock()
        self._frame = None
        self._content_type = ''
        self._at = 0.0
        self.count = 0

    def put(self, data, content_type):
        with self._lock:
            self._frame = bytes(data)
            self._content_type = content_type
            self._at = time.monotonic()
            self.count += 1

    def get(self):
        """(data, content_type, age_ms) of the newest frame, or None before the first frame."""
        with self._lock:
            if self._frame is None:
                return None
            return self._frame, self._content_type, (time.monotonic() - self._at) * 1000.0


class _BufferWriter(BufferedIOBase):
    """File-like sink for picamera2's FileOutput: each write() is one complete JPEG frame."""

    def __init__(self, buffer):
        super().__init__()
        self._buffer = buffer

    def write(self, buf):
        self._buffer.put(buf, 'image/jpeg')
        return len(buf)


class Picamera2Source:
    """Pi Camera Module through picamera2, using the Pi's hardware MJPEG encoder
    (as in raspberrypi/picamera2-examples, examples/mjpeg_server_2.py). Runs at the camera's default video
    frame rate; --fps applies to the other sources only."""

    name = 'picamera2'

    def __init__(self, width, height, fps):
        from picamera2 import Picamera2  # imported here so other sources work without picamera2
        from picamera2.encoders import MJPEGEncoder
        from picamera2.outputs import FileOutput

        self._camera = Picamera2()
        self._camera.configure(self._camera.create_video_configuration(main={'size': (width, height)}))
        self._encoder = MJPEGEncoder()
        self._file_output = FileOutput
        self.size = (width, height)

    def start(self, buffer):
        self._camera.start_recording(self._encoder, self._file_output(_BufferWriter(buffer)))

    def stop(self):
        self._camera.stop_recording()


class OpenCVSource:
    """USB camera through OpenCV (python3-opencv)."""

    name = 'opencv'

    def __init__(self, width, height, fps, device=0):
        import cv2  # imported here so other sources work without OpenCV

        self._cv2 = cv2
        self._capture = cv2.VideoCapture(device)
        if not self._capture.isOpened():
            raise RuntimeError(f'cannot open camera device {device}')
        self._capture.set(cv2.CAP_PROP_FRAME_WIDTH, width)
        self._capture.set(cv2.CAP_PROP_FRAME_HEIGHT, height)
        self._capture.set(cv2.CAP_PROP_FPS, fps)
        self.size = (width, height)
        self._period = 1.0 / fps
        self._running = False
        self._thread = None

    def start(self, buffer):
        self._running = True
        self._thread = threading.Thread(target=self._loop, args=(buffer,), daemon=True)
        self._thread.start()

    def _loop(self, buffer):
        while self._running:
            started = time.monotonic()
            ok, frame = self._capture.read()
            if ok:
                ok, jpeg = self._cv2.imencode('.jpg', frame, [self._cv2.IMWRITE_JPEG_QUALITY, 80])
                if ok:
                    buffer.put(jpeg.tobytes(), 'image/jpeg')
            time.sleep(max(0.0, self._period - (time.monotonic() - started)))

    def stop(self):
        self._running = False
        if self._thread:
            self._thread.join(timeout=2)
        self._capture.release()


def bmp_frame(width, height, t):
    """A 24-bit BMP test pattern: grey gradient with a bright bar that moves with time `t` (seconds)."""
    row_size = (width * 3 + 3) & ~3
    bar_x = int((t * 80) % width)
    rows = []
    for y in range(height):
        shade = 40 + (y * 120) // max(1, height - 1)
        row = bytearray(bytes((shade, shade, shade)) * width)
        lo, hi = max(0, bar_x - 12), min(width, bar_x + 12)
        row[lo * 3:hi * 3] = b'\xf0\xf0\xf0' * (hi - lo)
        row.extend(b'\0' * (row_size - width * 3))
        rows.append(bytes(row))
    pixels = b''.join(reversed(rows))  # BMP rows are stored bottom-up
    header = struct.pack('<2sIHHI', b'BM', 54 + len(pixels), 0, 0, 54)
    info = struct.pack('<IiiHHIIiiII', 40, width, height, 1, 24, 0, len(pixels), 2835, 2835, 0, 0)
    return header + info + pixels


class FakeSource:
    """Moving test pattern, for trying the app without a Pi camera. Pure standard library."""

    name = 'fake'

    def __init__(self, width, height, fps):
        self.size = (width, height)
        self._period = 1.0 / fps
        self._running = False
        self._thread = None

    def start(self, buffer):
        self._running = True
        self._thread = threading.Thread(target=self._loop, args=(buffer,), daemon=True)
        self._thread.start()

    def _loop(self, buffer):
        t0 = time.monotonic()
        while self._running:
            started = time.monotonic()
            buffer.put(bmp_frame(*self.size, started - t0), 'image/bmp')
            time.sleep(max(0.0, self._period - (time.monotonic() - started)))

    def stop(self):
        self._running = False
        if self._thread:
            self._thread.join(timeout=2)


def open_source(kind, width, height, fps, device):
    """Open the requested camera. 'auto' tries the Pi Camera Module first, then a USB camera."""
    if kind == 'fake':
        return FakeSource(width, height, fps)
    if kind == 'picamera2':
        return Picamera2Source(width, height, fps)
    if kind == 'opencv':
        return OpenCVSource(width, height, fps, device)
    errors = []
    for factory in (lambda: Picamera2Source(width, height, fps), lambda: OpenCVSource(width, height, fps, device)):
        try:
            return factory()
        except Exception as err:  # any failure means 'try the next camera'; all are reported if none works
            errors.append(f'{type(err).__name__}: {err}')
    raise RuntimeError('no camera found (' + '; '.join(errors) + '). Use --source fake to test without one.')


class Handler(SimpleHTTPRequestHandler):
    """/frame and /health for the camera; everything else is a static file of the app."""

    buffer = None
    source_name = ''
    frame_size = (0, 0)
    allow_origin = None  # set to an origin (e.g. http://localhost:5178) to allow cross-origin frame reads
    serve_app = True

    def _cors(self):
        if self.allow_origin:
            self.send_header('Access-Control-Allow-Origin', self.allow_origin)
            self.send_header('Access-Control-Expose-Headers', 'X-Frame-Age-Ms')
            self.send_header('Vary', 'Origin')

    def do_OPTIONS(self):
        self.send_response(HTTPStatus.NO_CONTENT)
        self._cors()
        if self.allow_origin:
            self.send_header('Access-Control-Allow-Methods', 'GET')
            self.send_header('Access-Control-Allow-Private-Network', 'true')
        self.end_headers()

    def do_GET(self):
        path = urlsplit(self.path).path
        if path == '/frame':
            return self._frame()
        if path == '/health':
            return self._health()
        if not self.serve_app:
            return self.send_error(HTTPStatus.NOT_FOUND)
        if any(part.startswith('.') for part in path.split('/')):
            return self.send_error(HTTPStatus.NOT_FOUND)  # never serve .git and other dot files
        return super().do_GET()

    def list_directory(self, path):
        self.send_error(HTTPStatus.NOT_FOUND)  # no directory listings
        return None

    def _frame(self):
        item = self.buffer.get()
        if item is None:
            self.send_response(HTTPStatus.SERVICE_UNAVAILABLE)
            self._cors()
            self.send_header('Retry-After', '1')
            self.send_header('Content-Length', '0')
            self.end_headers()
            return
        data, content_type, age_ms = item
        self.send_response(HTTPStatus.OK)
        self._cors()
        self.send_header('Content-Type', content_type)
        self.send_header('Content-Length', str(len(data)))
        self.send_header('Cache-Control', 'no-store')
        self.send_header('X-Frame-Age-Ms', f'{age_ms:.0f}')
        self.end_headers()
        self.wfile.write(data)

    def _health(self):
        item = self.buffer.get()
        body = json.dumps({
            'source': self.source_name,
            'width': self.frame_size[0],
            'height': self.frame_size[1],
            'frames': self.buffer.count,
            'frame_age_ms': None if item is None else round(item[2]),
        }).encode()
        self.send_response(HTTPStatus.OK)
        self._cors()
        self.send_header('Content-Type', 'application/json')
        self.send_header('Content-Length', str(len(body)))
        self.send_header('Cache-Control', 'no-store')
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, fmt, *args):
        if not self.path.startswith('/frame'):  # frames arrive many times a second; keep the log readable
            super().log_message(fmt, *args)


def make_server(buffer, source_name, frame_size, host='0.0.0.0', port=8000, root=REPO_ROOT,
                allow_origin=None, serve_app=True):
    """HTTP server bound to (host, port). Port 0 picks a free port (used by the tests)."""
    handler = type('VisionHandler', (Handler,), {
        'buffer': buffer, 'source_name': source_name, 'frame_size': frame_size,
        'allow_origin': allow_origin, 'serve_app': serve_app,
    })
    return ThreadingHTTPServer((host, port), partial(handler, directory=str(root)))


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument('--source', choices=('auto', 'picamera2', 'opencv', 'fake'), default='auto')
    parser.add_argument('--device', type=int, default=0, help='OpenCV camera index (USB cameras)')
    parser.add_argument('--width', type=int, default=640)
    parser.add_argument('--height', type=int, default=480)
    parser.add_argument('--fps', type=int, default=15)
    parser.add_argument('--host', default='0.0.0.0', help='address to listen on (0.0.0.0 = whole local network)')
    parser.add_argument('--port', type=int, default=8000)
    parser.add_argument('--allow-origin', default=None,
                        help='let a page from this origin read frames, e.g. http://localhost:5178 (off by default)')
    parser.add_argument('--no-app', action='store_true', help='serve only /frame and /health, not the app files')
    args = parser.parse_args()

    buffer = FrameBuffer()
    source = open_source(args.source, args.width, args.height, args.fps, args.device)
    source.start(buffer)
    server = make_server(buffer, source.name, source.size, args.host, args.port,
                         allow_origin=args.allow_origin, serve_app=not args.no_app)
    print(f'Camera: {source.name} {source.size[0]}x{source.size[1]} @ {args.fps} fps')
    print(f'Open http://<this-pi-address>:{args.port}/ on the laptop (frames at /frame, status at /health)')
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()
        source.stop()


if __name__ == '__main__':
    main()
