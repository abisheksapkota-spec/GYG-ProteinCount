"""PIN/password hashing, signed login tokens and a simple lockout after failed logins."""
import base64
import hashlib
import hmac
import json
import secrets
import time

ITERATIONS = 200_000


def hash_secret(secret: str) -> str:
    salt = secrets.token_hex(16)
    digest = hashlib.pbkdf2_hmac("sha256", secret.encode(), bytes.fromhex(salt), ITERATIONS).hex()
    return f"pbkdf2${ITERATIONS}${salt}${digest}"


def verify_secret(secret: str, stored: str) -> bool:
    try:
        _, iters, salt, digest = stored.split("$")
        check = hashlib.pbkdf2_hmac("sha256", secret.encode(), bytes.fromhex(salt), int(iters)).hex()
        return hmac.compare_digest(check, digest)
    except (ValueError, AttributeError):
        return False


def _b64(data: bytes) -> str:
    return base64.urlsafe_b64encode(data).decode().rstrip("=")


def _unb64(text: str) -> bytes:
    return base64.urlsafe_b64decode(text + "=" * (-len(text) % 4))


class Tokens:
    """Stateless signed tokens: base64(payload).base64(hmac)."""

    def __init__(self, key: str):
        self.key = key.encode()

    def make(self, payload: dict, ttl_seconds: int) -> str:
        body = _b64(json.dumps({**payload, "exp": int(time.time()) + ttl_seconds}, separators=(",", ":")).encode())
        sig = _b64(hmac.new(self.key, body.encode(), hashlib.sha256).digest())
        return f"{body}.{sig}"

    def read(self, token: str) -> dict | None:
        try:
            body, sig = token.split(".")
            good = _b64(hmac.new(self.key, body.encode(), hashlib.sha256).digest())
            if not hmac.compare_digest(good, sig):
                return None
            payload = json.loads(_unb64(body))
            return payload if payload.get("exp", 0) > time.time() else None
        except (ValueError, json.JSONDecodeError):
            return None


class Lockout:
    """After `limit` failed attempts for a key, refuse further attempts for `window` seconds."""

    def __init__(self, limit: int = 5, window: int = 300):
        self.limit, self.window = limit, window
        self.state: dict[str, tuple[int, float]] = {}

    def locked_for(self, key: str) -> int:
        fails, until = self.state.get(key, (0, 0.0))
        return max(0, int(until - time.time())) if fails >= self.limit else 0

    def fail(self, key: str):
        fails, until = self.state.get(key, (0, 0.0))
        if until and until < time.time():
            fails = 0
        fails += 1
        self.state[key] = (fails, time.time() + self.window if fails >= self.limit else until)

    def success(self, key: str):
        self.state.pop(key, None)
