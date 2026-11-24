#!/usr/bin/env python3
"""Reference Python client for Session Manager's paired-service protocol.

A second implementation of src/main/lib/feedback-remote/serviceClient.cjs, so the
protocol is proven by more than one codebase. Needs only the standard library plus
the `cryptography` package (pip install cryptography).

Usage:

    from sm_service_client import ServiceClient
    c = ServiceClient(state_dir="~/.kiln/sm")
    c.pair(code="123456", name="Kiln Service")      # once; stores clientId + identity
    sas = c.connect()                                 # compare with the desktop's SAS
    print(c.call_tool("scheduler_status", {}))
    c.close()

Protocol (same as serviceClient.cjs):
  pair     POST {relay}/client-pair {code, clientName} -> {clientToken, clientId};
           GET {relay}/client/devices (Bearer) picks the desktop: a 6+ char prefix
           matching exactly one deviceId, or the only device. A fresh P-256 identity
           is stored with it in <state_dir>/service-client.json at 0600.
  connect  POST {relay}/client-ticket -> {ticket}; WSS {wss}?ticket=...; send
           e2e:hello {pubKey, role:'service', name, clientId}. Session key =
           HKDF-SHA256(ECDH, salt=deviceId, info='sm-e2e-v1', 32 bytes); SAS =
           HKDF(..., info='sm-sas-v1', 3 bytes) as a 24-bit big-endian int % 1e6,
           zero-padded to 6 digits. Ready after e2e:ready + boxed event:remote:ready.
  boxes    e2e:box payload {nonce, ciphertext}: AES-256-GCM, 12-byte nonce,
           ciphertext || 16-byte tag, both base64url without padding.
  call_tool  JSON-RPC 2.0 tools/call inside a boxed cmd:mcp envelope; the boxed
           mcp:result is matched by JSON-RPC id.

This reference does not reconnect; a production client should (see serviceClient.cjs).

Vector mode (used by serviceClientPython.test.cjs, no network):
    python3 -I sm_service_client.py --vectors < vectors.json
"""

import base64
import json
import os
import socket
import ssl
import struct
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
import uuid

from cryptography.hazmat.primitives import hashes, serialization
from cryptography.hazmat.primitives.asymmetric import ec
from cryptography.hazmat.primitives.ciphers.aead import AESGCM
from cryptography.hazmat.primitives.kdf.hkdf import HKDF

DEFAULT_RELAY_BASE = "https://bilko.run/api/sm-relay"
DEFAULT_WSS_URL = "wss://bilko.run/projects/session-manager/relay"
STATE_FILE = "service-client.json"
DEVICE_PREFIX_MIN = 6
CLIENT_NAME_MAX = 64
SHORT_ID_LEN = 8


# --- crypto (mirrors remoteE2eCrypto.cjs) ---------------------------------

def b64url_encode(data):
    return base64.urlsafe_b64encode(data).rstrip(b"=").decode("ascii")


def b64url_decode(text):
    text = text.strip()
    return base64.urlsafe_b64decode(text + "=" * (-len(text) % 4))


def generate_keypair():
    """Return (private PKCS8 DER b64url, public SPKI DER b64url)."""
    key = ec.generate_private_key(ec.SECP256R1())
    priv = key.private_bytes(serialization.Encoding.DER, serialization.PrivateFormat.PKCS8,
                             serialization.NoEncryption())
    pub = key.public_key().public_bytes(serialization.Encoding.DER,
                                        serialization.PublicFormat.SubjectPublicKeyInfo)
    return b64url_encode(priv), b64url_encode(pub)


def _shared_secret(my_private_b64, peer_public_b64):
    priv = serialization.load_der_private_key(b64url_decode(my_private_b64), password=None)
    pub = serialization.load_der_public_key(b64url_decode(peer_public_b64))
    return priv.exchange(ec.ECDH(), pub)


def _hkdf(secret, device_id, info, length):
    return HKDF(algorithm=hashes.SHA256(), length=length, salt=device_id.encode("utf-8"),
                info=info.encode("utf-8")).derive(secret)


def derive_session_key(my_private_b64, peer_public_b64, device_id):
    return _hkdf(_shared_secret(my_private_b64, peer_public_b64), device_id, "sm-e2e-v1", 32)


def derive_sas(my_private_b64, peer_public_b64, device_id):
    b = _hkdf(_shared_secret(my_private_b64, peer_public_b64), device_id, "sm-sas-v1", 3)
    return str(((b[0] << 16) | (b[1] << 8) | b[2]) % 1_000_000).zfill(6)


def encrypt_box(plaintext, session_key, nonce=None):
    nonce = nonce if nonce is not None else os.urandom(12)
    ct = AESGCM(session_key).encrypt(nonce, plaintext.encode("utf-8"), None)  # ct || tag
    return {"nonce": b64url_encode(nonce), "ciphertext": b64url_encode(ct)}


def decrypt_box(nonce_b64, ciphertext_b64, session_key):
    """Return the UTF-8 plaintext, or None when authentication fails."""
    try:
        data = b64url_decode(ciphertext_b64)
        if len(data) < 16:
            return None
        return AESGCM(session_key).decrypt(b64url_decode(nonce_b64), data, None).decode("utf-8")
    except Exception:
        return None


# --- device choice (mirrors pickDevice in serviceClient.cjs) ---------------

class ServiceClientError(Exception):
    def __init__(self, message, code=None):
        super().__init__(message)
        self.code = code


def _short_ids(devices):
    return ", ".join(str(d["deviceId"])[:SHORT_ID_LEN] for d in devices)


def pick_device(devices, device=None):
    lst = [d for d in devices if isinstance(d, dict) and isinstance(d.get("deviceId"), str)]
    if device is None or device == "":
        if len(lst) == 1:
            return lst[0]
        raise ServiceClientError("choose a device (%d paired): %s" % (len(lst), _short_ids(lst) or "none"),
                                 "device_ambiguous")
    prefix = str(device)
    if len(prefix) < DEVICE_PREFIX_MIN:
        raise ServiceClientError("device prefix needs %d+ chars; devices: %s" % (DEVICE_PREFIX_MIN, _short_ids(lst)),
                                 "device_ambiguous")
    hits = [d for d in lst if d["deviceId"].startswith(prefix)]
    if len(hits) == 1:
        return hits[0]
    raise ServiceClientError("device '%s' matches %d devices; devices: %s" % (prefix, len(hits), _short_ids(lst)),
                             "device_ambiguous")


# --- minimal RFC 6455 WebSocket client (stdlib only) -----------------------

class _WebSocket:
    def __init__(self, url, timeout=30):
        u = urllib.parse.urlsplit(url)
        if u.scheme != "wss":
            raise ValueError("wss:// required")
        host, port = u.hostname, u.port or 443
        raw = socket.create_connection((host, port), timeout=timeout)
        self.sock = ssl.create_default_context().wrap_socket(raw, server_hostname=host)
        key = base64.b64encode(os.urandom(16)).decode("ascii")
        path = (u.path or "/") + ("?" + u.query if u.query else "")
        req = ("GET %s HTTP/1.1\r\nHost: %s\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n"
               "Sec-WebSocket-Key: %s\r\nSec-WebSocket-Version: 13\r\n\r\n") % (path, host, key)
        self.sock.sendall(req.encode("ascii"))
        head = b""
        while b"\r\n\r\n" not in head:
            chunk = self.sock.recv(1)
            if not chunk:
                raise ServiceClientError("websocket handshake closed", "connection_lost")
            head += chunk
        if b" 101 " not in head.split(b"\r\n", 1)[0]:
            raise ServiceClientError("websocket handshake failed: %r" % head.split(b"\r\n", 1)[0], "connection_lost")

    def _read(self, n):
        buf = b""
        while len(buf) < n:
            chunk = self.sock.recv(n - len(buf))
            if not chunk:
                raise ServiceClientError("connection lost", "connection_lost")
            buf += chunk
        return buf

    def _send_frame(self, opcode, payload):
        mask = os.urandom(4)
        n = len(payload)
        if n < 126:
            header = struct.pack("!BB", 0x80 | opcode, 0x80 | n)
        elif n < 65536:
            header = struct.pack("!BBH", 0x80 | opcode, 0x80 | 126, n)
        else:
            header = struct.pack("!BBQ", 0x80 | opcode, 0x80 | 127, n)
        masked = bytes(b ^ mask[i % 4] for i, b in enumerate(payload))
        self.sock.sendall(header + mask + masked)

    def send_text(self, text):
        self._send_frame(0x1, text.encode("utf-8"))

    def recv_text(self):
        """Return the next text message; answers pings; raises on close."""
        parts = []
        while True:
            b0, b1 = self._read(2)
            opcode, n = b0 & 0x0F, b1 & 0x7F
            if n == 126:
                n = struct.unpack("!H", self._read(2))[0]
            elif n == 127:
                n = struct.unpack("!Q", self._read(8))[0]
            mask = self._read(4) if b1 & 0x80 else None
            data = self._read(n)
            if mask:
                data = bytes(b ^ mask[i % 4] for i, b in enumerate(data))
            if opcode == 0x8:
                code = struct.unpack("!H", data[:2])[0] if len(data) >= 2 else 1005
                raise ServiceClientError("connection closed (%d)" % code,
                                         "revoked" if code == 4001 else "connection_lost")
            if opcode == 0x9:
                self._send_frame(0xA, data)
                continue
            if opcode == 0xA:
                continue
            parts.append(data)
            if b0 & 0x80:
                return b"".join(parts).decode("utf-8")

    def close(self):
        try:
            self._send_frame(0x8, struct.pack("!H", 1000))
            self.sock.close()
        except OSError:
            pass


# --- the client ------------------------------------------------------------

class ServiceClient:
    def __init__(self, state_dir, relay_base=DEFAULT_RELAY_BASE, wss_url=DEFAULT_WSS_URL):
        if not relay_base.startswith("https://"):
            raise ValueError("relay_base must be https://")
        if not wss_url.startswith("wss://"):
            raise ValueError("wss_url must be wss://")
        self.state_dir = os.path.expanduser(state_dir)
        self.file = os.path.join(self.state_dir, STATE_FILE)
        self.relay_base = relay_base
        self.wss_url = wss_url
        self.stored = self._read_stored()
        self.ws = None
        self.session_key = None
        self.sas = None
        self._rpc_seq = 0

    @property
    def client_id(self):
        return self.stored["clientId"] if self.stored else None

    def _read_stored(self):
        try:
            with open(self.file, "r", encoding="utf-8") as f:
                d = json.load(f)
        except (OSError, ValueError):
            return None
        ok = isinstance(d, dict) and isinstance(d.get("clientToken"), str) and d["clientToken"] \
            and isinstance(d.get("privateKey"), str)
        return d if ok else None

    def _write_stored(self, data):
        os.makedirs(self.state_dir, mode=0o700, exist_ok=True)
        tmp = self.file + ".tmp"
        fd = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
        with os.fdopen(fd, "w", encoding="utf-8") as f:
            json.dump(data, f, indent=2)
        os.replace(tmp, self.file)

    def _request(self, method, route, token=None, body=None):
        headers = {}
        if token:
            headers["Authorization"] = "Bearer " + token
        data = None
        if body is not None:
            headers["Content-Type"] = "application/json"
            data = json.dumps(body).encode("utf-8")
        req = urllib.request.Request(self.relay_base + route, data=data, headers=headers, method=method)
        try:
            with urllib.request.urlopen(req, timeout=30) as res:
                status, raw = res.status, res.read()
        except urllib.error.HTTPError as e:
            status, raw = e.code, e.read()
        try:
            parsed = json.loads(raw.decode("utf-8")) if raw else {}
        except ValueError:
            parsed = {}
        return status, parsed if isinstance(parsed, dict) else {}

    def _devices(self, token):
        status, body = self._request("GET", "/client/devices", token=token)
        if status == 401:
            raise ServiceClientError("service client revoked", "revoked")
        if not 200 <= status < 300:
            raise ServiceClientError(body.get("error") or "HTTP %d" % status, "http")
        return body.get("devices") if isinstance(body.get("devices"), list) else []

    def pair(self, code, name, device=None):
        if not isinstance(name, str) or not name.strip():
            raise ValueError("name is required")
        client_name = name[:CLIENT_NAME_MAX]
        status, body = self._request("POST", "/client-pair",
                                     body={"code": str(code or "").strip(), "clientName": client_name})
        if status != 200 or not body.get("clientToken"):
            raise ServiceClientError("pair failed: %s" % (body.get("error") or "HTTP %d" % status), "pair_failed")
        token, client_id = body["clientToken"], body.get("clientId")
        picked = pick_device(self._devices(token), device)
        priv, pub = generate_keypair()
        self.stored = {
            "clientToken": token, "clientId": client_id, "name": client_name,
            "privateKey": priv, "publicKey": pub,
            "deviceId": picked["deviceId"], "devicePubKey": picked.get("devicePubKey"),
            "pairedAt": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        }
        self._write_stored(self.stored)
        return {"clientId": client_id, "deviceId": picked["deviceId"]}

    def _envelope(self, type_, payload, id_=None):
        return {"type": type_, "id": id_ or str(uuid.uuid4()), "deviceId": self.stored["deviceId"],
                "payload": payload, "ts": int(time.time() * 1000)}

    def _send_boxed(self, inner):
        box = encrypt_box(json.dumps(inner), self.session_key)
        self.ws.send_text(json.dumps({"type": "e2e:box", "id": inner["id"], "deviceId": self.stored["deviceId"],
                                      "payload": box, "ts": int(time.time() * 1000)}))

    def _next(self):
        """Read one relay message; returns ('raw', msg) or ('box', inner); None to skip."""
        try:
            msg = json.loads(self.ws.recv_text())
        except ValueError:
            return None
        if not isinstance(msg, dict):
            return None
        if msg.get("deviceId") is not None and msg.get("deviceId") != self.stored["deviceId"]:
            return None
        if msg.get("type") == "ping":
            self.ws.send_text(json.dumps({"type": "pong", "id": msg.get("id"), "ts": int(time.time() * 1000)}))
            return None
        if msg.get("type") == "e2e:box":
            p = msg.get("payload") or {}
            plain = decrypt_box(p.get("nonce", ""), p.get("ciphertext", ""), self.session_key)
            if plain is None:
                return None
            try:
                inner = json.loads(plain)
            except ValueError:
                return None
            return ("box", inner) if isinstance(inner, dict) else None
        return ("raw", msg)

    def connect(self, on_sas=None):
        """Open the e2e session; returns the SAS once the desktop says remote:ready."""
        if not self.stored:
            raise ServiceClientError("service client is not paired", "unpaired")
        try:
            hit = next((d for d in self._devices(self.stored["clientToken"])
                        if isinstance(d, dict) and d.get("deviceId") == self.stored["deviceId"]), None)
            if hit and isinstance(hit.get("devicePubKey"), str) and hit["devicePubKey"] != self.stored["devicePubKey"]:
                self.stored["devicePubKey"] = hit["devicePubKey"]
                self._write_stored(self.stored)
        except ServiceClientError as e:
            if e.code == "revoked":
                raise
        status, body = self._request("POST", "/client-ticket", token=self.stored["clientToken"], body={})
        if status == 401:
            raise ServiceClientError("service client revoked", "revoked")
        if status != 200 or not isinstance(body.get("ticket"), str):
            raise ServiceClientError("client-ticket failed: HTTP %d" % status, "http")
        self.ws = _WebSocket(self.wss_url + "?ticket=" + urllib.parse.quote(body["ticket"], safe=""))
        s = self.stored
        self.session_key = derive_session_key(s["privateKey"], s["devicePubKey"], s["deviceId"])
        self.sas = derive_sas(s["privateKey"], s["devicePubKey"], s["deviceId"])
        self.ws.send_text(json.dumps(self._envelope("e2e:hello", {
            "pubKey": s["publicKey"], "role": "service", "name": s["name"], "clientId": s["clientId"]})))
        got_ready = got_remote_ready = False
        while not (got_ready and got_remote_ready):
            item = self._next()
            if item is None:
                continue
            kind, msg = item
            if kind == "raw" and msg.get("type") == "e2e:ready" and not got_ready:
                got_ready = True
                if on_sas:
                    on_sas(self.sas)
            elif kind == "raw" and msg.get("type") == "e2e:rekey":
                raise ServiceClientError("desktop asked for a rekey; connect again", "connection_lost")
            elif kind == "box" and msg.get("type") == "event:remote:ready":
                got_remote_ready = True
        return self.sas

    def _rpc(self, method, params, timeout=30):
        if not self.ws or not self.session_key:
            raise ServiceClientError("service client not ready", "not_ready")
        self._rpc_seq += 1
        rpc_id = "svc-%d" % self._rpc_seq
        self._send_boxed(self._envelope("cmd:mcp", {"jsonrpc": "2.0", "id": rpc_id, "method": method,
                                                    "params": params}))
        deadline = time.monotonic() + timeout
        while True:
            left = deadline - time.monotonic()
            if left <= 0:
                raise ServiceClientError("timeout after %ss waiting for %s" % (timeout, method), "timeout")
            self.ws.sock.settimeout(left)
            try:
                item = self._next()
            except socket.timeout:
                raise ServiceClientError("timeout after %ss waiting for %s" % (timeout, method), "timeout")
            if not item or item[0] != "box" or item[1].get("type") != "mcp:result":
                continue
            rpc = item[1].get("payload")
            if not isinstance(rpc, dict) or rpc.get("id") != rpc_id:
                continue
            if rpc.get("error"):
                err = ServiceClientError(str(rpc["error"].get("message") or "mcp error"), "mcp_error")
                err.rpc_code = rpc["error"].get("code")
                raise err
            return rpc.get("result")

    def list_tools(self, timeout=30):
        result = self._rpc("tools/list", {}, timeout)
        return result.get("tools", []) if isinstance(result, dict) else []

    def call_tool(self, name, arguments=None, timeout=30):
        return self._rpc("tools/call", {"name": name, "arguments": arguments or {}}, timeout)

    def close(self):
        if self.ws:
            self.ws.close()
        self.ws = None
        self.session_key = None


# --- vector mode -----------------------------------------------------------

def _run_vectors(v):
    """Input: {privateKey, peerPublicKey, deviceId, box:{nonce,ciphertext}, plaintext, nonce,
    devices, device}. Output: what this implementation derives from them."""
    key = derive_session_key(v["privateKey"], v["peerPublicKey"], v["deviceId"])
    out = {
        "sessionKey": b64url_encode(key),
        "sas": derive_sas(v["privateKey"], v["peerPublicKey"], v["deviceId"]),
        "decrypted": decrypt_box(v["box"]["nonce"], v["box"]["ciphertext"], key),
        "box": encrypt_box(v["plaintext"], key, b64url_decode(v["nonce"])),
    }
    if "devices" in v:
        try:
            out["picked"] = pick_device(v["devices"], v.get("device"))["deviceId"]
        except ServiceClientError as e:
            out["picked"] = {"error": e.code}
    return out


if __name__ == "__main__":
    if sys.argv[1:] == ["--vectors"]:
        json.dump(_run_vectors(json.load(sys.stdin)), sys.stdout)
        sys.stdout.write("\n")
    else:
        sys.stderr.write(__doc__)
        sys.exit(2)
