# AI-assisted (Claude Code), reviewed by a team member.
"""Tests for pi/camera_server.py. No camera needed: run with  python -m unittest discover -s pi"""

import json
import shutil
import ssl
import struct
import tempfile
import threading
import unittest
from pathlib import Path
import urllib.error
import urllib.request

import camera_server as cs


def _serve(buffer, **kwargs):
    server = cs.make_server(buffer, 'fake', (32, 24), host='127.0.0.1', port=0, **kwargs)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    return server, f'http://127.0.0.1:{server.server_address[1]}'


def _get(url, method='GET', headers=None, context=None):
    req = urllib.request.Request(url, method=method, headers=headers or {})
    try:
        with urllib.request.urlopen(req, timeout=5, context=context) as res:
            return res.status, dict(res.headers), res.read()
    except urllib.error.HTTPError as err:
        with err:
            return err.code, dict(err.headers), err.read()


class BmpFrameTest(unittest.TestCase):
    def test_header_and_size(self):
        data = cs.bmp_frame(32, 24, 0.0)
        self.assertEqual(data[:2], b'BM')
        self.assertEqual(struct.unpack('<I', data[2:6])[0], len(data))
        width, height = struct.unpack('<ii', data[18:26])
        self.assertEqual((width, height), (32, 24))
        self.assertEqual(len(data), 54 + 24 * ((32 * 3 + 3) & ~3))

    def test_pattern_moves(self):
        self.assertNotEqual(cs.bmp_frame(32, 24, 0.0), cs.bmp_frame(32, 24, 0.2))


class ServerTest(unittest.TestCase):
    def setUp(self):
        self.buffer = cs.FrameBuffer()
        self.server, self.base = _serve(self.buffer)

    def tearDown(self):
        self.server.shutdown()
        self.server.server_close()

    def test_frame_is_503_before_the_first_frame(self):
        status, headers, _ = _get(self.base + '/frame')
        self.assertEqual(status, 503)
        self.assertEqual(headers.get('Retry-After'), '1')

    def test_frame_returns_newest_frame_with_age_and_no_cache(self):
        self.buffer.put(b'one', 'image/jpeg')
        self.buffer.put(b'two', 'image/jpeg')
        status, headers, body = _get(self.base + '/frame')
        self.assertEqual((status, body), (200, b'two'))
        self.assertEqual(headers['Content-Type'], 'image/jpeg')
        self.assertEqual(headers['Cache-Control'], 'no-store')
        self.assertGreaterEqual(int(headers['X-Frame-Age-Ms']), 0)

    def test_no_cross_origin_access_by_default(self):
        self.buffer.put(b'x', 'image/jpeg')
        _, headers, _ = _get(self.base + '/frame', headers={'Origin': 'http://example.test'})
        self.assertNotIn('Access-Control-Allow-Origin', headers)

    def test_health_reports_source_and_frames(self):
        self.buffer.put(b'x', 'image/jpeg')
        status, _, body = _get(self.base + '/health')
        info = json.loads(body)
        self.assertEqual(status, 200)
        self.assertEqual((info['source'], info['width'], info['height'], info['frames']), ('fake', 32, 24, 1))

    def test_app_files_have_the_types_the_browser_needs(self):
        for path, expected in (('/src/app.js', 'text/javascript'), ('/vendor/mediapipe/vision_bundle.mjs', 'text/javascript'),
                               ('/vendor/mediapipe/wasm/vision_wasm_internal.wasm', 'application/wasm')):
            _, headers, _ = _get(self.base + path)
            content_type = {k.lower(): v for k, v in headers.items()}['content-type']
            self.assertTrue(content_type.startswith(expected), (path, content_type))

    def test_serves_the_app_but_not_dot_files_or_listings(self):
        status, _, body = _get(self.base + '/index.html')
        self.assertEqual(status, 200)
        self.assertIn(b'Vision', body)
        self.assertEqual(_get(self.base + '/.git/config')[0], 404)
        self.assertEqual(_get(self.base + '/src/')[0], 404)


class CorsTest(unittest.TestCase):
    def setUp(self):
        self.buffer = cs.FrameBuffer()
        self.buffer.put(b'x', 'image/jpeg')
        self.server, self.base = _serve(self.buffer, allow_origin='http://localhost:5178', serve_app=False)

    def tearDown(self):
        self.server.shutdown()
        self.server.server_close()

    def test_allowed_origin_can_read_frames_and_age(self):
        _, headers, _ = _get(self.base + '/frame')
        self.assertEqual(headers['Access-Control-Allow-Origin'], 'http://localhost:5178')
        self.assertEqual(headers['Access-Control-Expose-Headers'], 'X-Frame-Age-Ms')

    def test_preflight_allows_private_network(self):
        status, headers, _ = _get(self.base + '/frame', method='OPTIONS')
        self.assertEqual(status, 204)
        self.assertEqual(headers['Access-Control-Allow-Private-Network'], 'true')

    def test_app_files_can_be_switched_off(self):
        self.assertEqual(_get(self.base + '/index.html')[0], 404)


@unittest.skipUnless(shutil.which('openssl'), 'openssl is needed to make a test certificate')
class HttpsTest(unittest.TestCase):
    """--https: an https page (GitHub Pages) can only load the camera from an https server."""

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        cert_dir = Path(self.tmp.name) / '.cert'
        self.cert, key = cs.self_signed_certificate(cert_dir)
        self.buffer = cs.FrameBuffer()
        self.buffer.put(b'jpeg', 'image/jpeg')
        self.server = cs.make_server(self.buffer, 'fake', (32, 24), host='127.0.0.1', port=0,
                                     allow_origin='https://capitalisming.github.io',
                                     ssl_context=cs.tls_context(self.cert, key))
        threading.Thread(target=self.server.serve_forever, daemon=True).start()
        self.base = f'https://127.0.0.1:{self.server.server_address[1]}'

    def tearDown(self):
        self.server.shutdown()
        self.server.server_close()
        self.tmp.cleanup()

    def test_frames_over_https_with_the_certificate_for_this_machine(self):
        context = ssl.create_default_context(cafile=str(self.cert))  # trusts the cert, checks the IP in it
        status, headers, body = _get(self.base + '/frame', context=context)
        self.assertEqual((status, body), (200, b'jpeg'))
        self.assertEqual(headers['Access-Control-Allow-Origin'], 'https://capitalisming.github.io')

    def test_a_client_that_refuses_the_certificate_does_not_stop_the_server(self):
        with self.assertRaises(Exception):
            _get(self.base + '/health', context=ssl.create_default_context())  # untrusted: refused
        context = ssl.create_default_context(cafile=str(self.cert))
        self.assertEqual(_get(self.base + '/health', context=context)[0], 200)

    def test_the_certificate_is_reused_and_its_key_never_served(self):
        self.assertEqual(cs.self_signed_certificate(self.cert.parent)[0], self.cert)
        context = ssl.create_default_context(cafile=str(self.cert))
        self.assertEqual(_get(self.base + '/pi/.cert/key.pem', context=context)[0], 404)


if __name__ == '__main__':
    unittest.main()
