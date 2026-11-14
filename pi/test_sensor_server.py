# AI-assisted (Claude Code), reviewed by a team member.
"""Tests for pi/sensor_server.py and pi/check_client.py. Run: python -m unittest discover -s pi

The gpiozero test uses gpiozero's MockFactory (no Pi needed); the end-to-end test needs the websockets
package. Each is skipped when its package is missing.
"""

import asyncio
import json
import sys
import threading
import time
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

import check_client  # noqa: E402
import sensor_server as ss  # noqa: E402

try:
    import gpiozero  # noqa: F401
    HAVE_GPIOZERO = True
except ImportError:
    HAVE_GPIOZERO = False

try:
    import websockets  # noqa: F401
    HAVE_WEBSOCKETS = True
except ImportError:
    HAVE_WEBSOCKETS = False


class MessageTests(unittest.TestCase):
    def test_contract_example(self):
        self.assertEqual(ss.dumps(ss.reading_message(512.3, 310.54)), '{"v":1,"mm":512,"ok":1,"lux":310.5}')

    def test_failed_read(self):
        self.assertEqual(ss.reading_message(None, None), {'v': 1, 'mm': None, 'ok': 0, 'lux': None})

    def test_range_100_to_2000(self):
        self.assertEqual(ss.reading_message(99.4, None)['ok'], 0)
        self.assertEqual(ss.reading_message(100, None)['ok'], 1)
        self.assertEqual(ss.reading_message(1999, None)['ok'], 1)
        self.assertEqual(ss.reading_message(2000, None)['ok'], 0)  # gpiozero's clamp value: too far
        self.assertIsNone(ss.reading_message(2000, None)['mm'])

    def test_hello_and_clients(self):
        self.assertEqual(ss.dumps(ss.hello_message(True)), '{"v":1,"hello":"sensor-pi","camera":true}')
        self.assertEqual(ss.clients_message(2), {'v': 1, 'clients': 2})


class FakeSensor:
    def __init__(self, fraction, at):
        self.last_fraction, self.last_ok_at = fraction, at

    def close(self):
        pass


class DistanceReaderTests(unittest.TestCase):
    def test_fresh_reading_in_mm(self):
        r = ss.DistanceReader(FakeSensor(0.25, 10.0), max_distance=2.0, clock=lambda: 10.1)
        self.assertAlmostEqual(r.read(), 500.0)

    def test_stale_reading_is_none(self):
        r = ss.DistanceReader(FakeSensor(0.25, 10.0), max_distance=2.0, clock=lambda: 10.0 + ss.FRESH_S + 0.01)
        self.assertIsNone(r.read())

    def test_no_reading_yet(self):
        self.assertIsNone(ss.DistanceReader(FakeSensor(None, None), clock=lambda: 0).read())


@unittest.skipUnless(HAVE_GPIOZERO, 'gpiozero not installed')
class GpiozeroMockTests(unittest.TestCase):
    def test_mock_echo_gives_distance(self):
        from gpiozero.pins.mock import MockFactory, MockTriggerPin
        factory = MockFactory()
        echo = factory.pin(ss.ECHO_PIN)
        factory.pin(ss.TRIG_PIN, pin_class=MockTriggerPin, echo_pin=echo, echo_time=0.003)
        import warnings
        with warnings.catch_warnings():
            warnings.simplefilter('ignore')
            sensor = ss.make_distance_sensor(pin_factory=factory)
        try:
            reader = ss.DistanceReader(sensor)
            deadline = time.monotonic() + 3
            mm = None
            while mm is None and time.monotonic() < deadline:
                time.sleep(0.05)
                mm = reader.read()
            self.assertIsNotNone(mm)
            # 3 ms echo -> 0.003 * 343.26 / 2 = 515 mm. The mock drives the echo with time.sleep(), which
            # overshoots by up to ~1 ms on a busy machine, so only the order of magnitude is checked here.
            self.assertGreater(mm, 480)
            self.assertLess(mm, 750)
        finally:
            sensor.close()
            factory.reset()


class FixedReader:
    def __init__(self, value):
        self.value = value

    def read(self):
        return self.value

    def close(self):
        pass


@unittest.skipUnless(HAVE_WEBSOCKETS, 'websockets not installed')
class EndToEndTests(unittest.TestCase):
    def test_client_receives_hello_clients_and_readings(self):
        hub = ss.SensorHub(FixedReader(512.0), FixedReader(310.54), camera=True)
        ready, stop_box = threading.Event(), {}

        def run():
            async def main():
                stop = asyncio.Event()
                stop_box['stop'], stop_box['loop'] = stop, asyncio.get_running_loop()
                async with websockets.serve(hub.handler, '127.0.0.1', 0) as server:
                    stop_box['port'] = next(iter(server.sockets)).getsockname()[1]
                    task = asyncio.create_task(hub.broadcast_loop())
                    ready.set()
                    await stop.wait()
                    task.cancel()
            asyncio.run(main())

        t = threading.Thread(target=run, daemon=True)
        t.start()
        self.assertTrue(ready.wait(5))
        try:
            ws = check_client.WebSocketClient('127.0.0.1', stop_box['port'])
            ws.sock.settimeout(2)
            msgs = [json.loads(ws.recv_text()) for _ in range(6)]
            ws.close()
        finally:
            stop_box['loop'].call_soon_threadsafe(stop_box['stop'].set)
            t.join(5)
        self.assertEqual(msgs[0], {'v': 1, 'hello': 'sensor-pi', 'camera': True})
        self.assertIn({'v': 1, 'clients': 1}, msgs)
        self.assertIn({'v': 1, 'mm': 512, 'ok': 1, 'lux': 310.5}, msgs)


class CheckClientTests(unittest.TestCase):
    def test_parse_address(self):
        self.assertEqual(check_client.parse_address('vision.local'), ('vision.local', 8765, '/'))
        self.assertEqual(check_client.parse_address('vision.local:9000'), ('vision.local', 9000, '/'))
        self.assertEqual(check_client.parse_address('ws://10.0.0.5:8765/'), ('10.0.0.5', 8765, '/'))
        with self.assertRaises(ValueError):
            check_client.parse_address('wss://vision.local')

    def test_accept_key_rfc6455_example(self):
        self.assertEqual(check_client.accept_key('dGhlIHNhbXBsZSBub25jZQ=='), 's3pPLMBiTxaQ9kYGzzhZRbK+xOo=')

    def test_summary(self):
        s = check_client.summarize([{'mm': 500, 'ok': 1, 'lux': 10.0}, {'mm': None, 'ok': 0, 'lux': None}], 1.0)
        self.assertIn('ok = 1 in 1 (50 %)', s)
        self.assertIn('median 500 mm', s)


if __name__ == '__main__':
    unittest.main()
