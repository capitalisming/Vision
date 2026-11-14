#!/usr/bin/env python3
# AI-assisted (Claude Code), reviewed by a team member.
"""Prints the messages of pi/sensor_server.py. Runs on the Pi and on the laptop (Windows, macOS, Linux).

Standard library only: nothing to install on the laptop.

    python pi/check_client.py vision.local            # same as ws://vision.local:8765
    python pi/check_client.py ws://192.168.1.20:8765 --seconds 5
    python3 pi/check_client.py                        # on the Pi itself: localhost

Prints every message as it arrives, then a one-line summary (messages per second, share with ok = 1, median mm).
"""

import argparse
import base64
import hashlib
import json
import os
import socket
import statistics
import struct
import sys
import time
from urllib.parse import urlsplit

GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11'


def parse_address(address):
    """'vision.local', 'vision.local:8765' or 'ws://vision.local:8765/' -> (host, port, path)."""
    if '://' not in address:
        address = 'ws://' + address
    u = urlsplit(address)
    if u.scheme != 'ws':
        raise ValueError(f'only ws:// is supported, got {u.scheme}://')
    if not u.hostname:
        raise ValueError(f'no host in {address!r}')
    return u.hostname, u.port or 8765, u.path or '/'


def accept_key(key):
    return base64.b64encode(hashlib.sha1((key + GUID).encode()).digest()).decode()


class WebSocketClient:
    """The client half of RFC 6455, just enough to read text messages from a server."""

    def __init__(self, host, port, path='/', timeout=5.0):
        self.sock = socket.create_connection((host, port), timeout=timeout)
        key = base64.b64encode(os.urandom(16)).decode()
        self.sock.sendall((
            f'GET {path} HTTP/1.1\r\nHost: {host}:{port}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n'
            f'Sec-WebSocket-Key: {key}\r\nSec-WebSocket-Version: 13\r\n\r\n').encode())
        head = b''
        while b'\r\n\r\n' not in head:
            chunk = self.sock.recv(1024)
            if not chunk:
                raise ConnectionError('server closed the connection during the handshake')
            head += chunk
        head, self._buf = head.split(b'\r\n\r\n', 1)
        lines = head.decode('latin-1').split('\r\n')
        if ' 101 ' not in lines[0] + ' ':
            raise ConnectionError(f'handshake refused: {lines[0]}')
        headers = {k.strip().lower(): v.strip() for k, _, v in (l.partition(':') for l in lines[1:])}
        if headers.get('sec-websocket-accept') != accept_key(key):
            raise ConnectionError('handshake: wrong Sec-WebSocket-Accept')

    def _read(self, n):
        while len(self._buf) < n:
            chunk = self.sock.recv(4096)
            if not chunk:
                raise ConnectionError('connection closed')
            self._buf += chunk
        out, self._buf = self._buf[:n], self._buf[n:]
        return out

    def _send(self, opcode, payload=b''):
        mask = os.urandom(4)  # client frames must be masked
        masked = bytes(b ^ mask[i % 4] for i, b in enumerate(payload))
        n = len(payload)
        if n < 126:
            header = struct.pack('!BB', 0x80 | opcode, 0x80 | n)
        elif n < 65536:
            header = struct.pack('!BBH', 0x80 | opcode, 0x80 | 126, n)
        else:
            header = struct.pack('!BBQ', 0x80 | opcode, 0x80 | 127, n)
        self.sock.sendall(header + mask + masked)

    def recv_text(self):
        """Next text message, or None when the server closed the connection."""
        parts = []
        while True:
            b0, b1 = self._read(2)
            fin, opcode, n = b0 & 0x80, b0 & 0x0F, b1 & 0x7F
            if n == 126:
                n = struct.unpack('!H', self._read(2))[0]
            elif n == 127:
                n = struct.unpack('!Q', self._read(8))[0]
            mask = self._read(4) if b1 & 0x80 else None
            payload = self._read(n)
            if mask:
                payload = bytes(b ^ mask[i % 4] for i, b in enumerate(payload))
            if opcode == 0x8:  # close
                try:
                    self._send(0x8, payload[:2])
                except OSError:
                    pass
                return None
            if opcode == 0x9:  # ping
                self._send(0xA, payload)
                continue
            if opcode in (0x1, 0x0):
                parts.append(payload)
                if fin:
                    return b''.join(parts).decode('utf-8')
            # binary (0x2) and pong (0xA) are ignored

    def close(self):
        try:
            self._send(0x8, struct.pack('!H', 1000))
        except OSError:
            pass
        self.sock.close()


def summarize(readings, seconds):
    if not readings:
        return 'no readings'
    ok = [r['mm'] for r in readings if r.get('ok') == 1 and isinstance(r.get('mm'), (int, float))]
    lux = [r['lux'] for r in readings if isinstance(r.get('lux'), (int, float))]
    parts = [f'{len(readings)} readings in {seconds:.1f} s ({len(readings) / seconds:.1f}/s)',
             f'ok = 1 in {len(ok)} ({100 * len(ok) / len(readings):.0f} %)']
    if ok:
        parts.append(f'median {statistics.median(ok):.0f} mm, min {min(ok)}, max {max(ok)}')
    parts.append(f'median lux {statistics.median(lux):.1f}' if lux else 'lux: null')
    return '; '.join(parts)


def main(argv=None):
    p = argparse.ArgumentParser(description='Print messages from pi/sensor_server.py.')
    p.add_argument('address', nargs='?', default='ws://localhost:8765',
                   help='Pi address: vision.local, vision.local:8765 or ws://<ip>:8765 (default: localhost)')
    p.add_argument('--seconds', type=float, default=0, help='stop after this many seconds (default: run until Ctrl+C)')
    p.add_argument('--quiet', action='store_true', help='print only the summary')
    args = p.parse_args(argv)

    host, port, path = parse_address(args.address)
    try:
        ws = WebSocketClient(host, port, path)
    except (OSError, ConnectionError, ValueError) as e:
        print(f'cannot connect to ws://{host}:{port}{path}: {e}', file=sys.stderr)
        return 1
    print(f'connected to ws://{host}:{port}{path}', file=sys.stderr)
    ws.sock.settimeout(2.0)

    readings = []
    start = time.monotonic()
    code = 0
    try:
        while not args.seconds or time.monotonic() - start < args.seconds:
            try:
                text = ws.recv_text()
            except socket.timeout:
                print('no message for 2 s', file=sys.stderr)
                continue
            if text is None:
                print('server closed the connection', file=sys.stderr)
                code = 1
                break
            if not args.quiet:
                print(text, flush=True)
            try:
                msg = json.loads(text)
            except ValueError:
                continue
            if isinstance(msg, dict) and 'mm' in msg:
                readings.append(msg)
    except KeyboardInterrupt:
        pass
    except ConnectionError as e:
        print(f'connection lost: {e}', file=sys.stderr)
        code = 1
    finally:
        ws.close()
    print(summarize(readings, max(time.monotonic() - start, 1e-9)), file=sys.stderr)
    return code


if __name__ == '__main__':
    sys.exit(main())
