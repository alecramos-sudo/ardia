import errno
import json
import os
import re
import stat
from dataclasses import dataclass
from pathlib import Path

STATUS_FOLDER = "crawler"
STATUS_FILE = "status.json"
MAX_STATUS_FILE = 256 * 1024
REASONS = {
    "selftest_failed": "its tracker blocking didn't pass the self-test",
    "configure_failed": "its request labels couldn't be set",
    "timeout": "its tracker blocking didn't load in time",
    "refused_not_scratch": "crawler mode needs a scratch data folder",
    "other": "something stopped it from getting ready",
}
REDACTED = "[redacted]"
STARTED_SLACK = 5.0
_BYTE_SEQUENCE = re.compile(r":[A-Za-z0-9+/_-]{8,}={0,2}:")
_LONG_TOKEN = re.compile(r"[A-Za-z0-9+/_-]{32,}={0,2}")
_SIGNATURE_PARAMS = re.compile(r"\b(?:sig\d*|signature(?:-input)?)\s*=\s*\S+", re.IGNORECASE)
_VENDOR = re.compile(r"^[a-z][a-z0-9]{0,31}$")
_DOMAIN = re.compile(r"^[a-z0-9.-]{1,253}$")
_STAMP = re.compile(r"^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$")


class StatusMissing(Exception):
    pass


class StatusUnsafe(Exception):
    pass


class StatusStale(StatusUnsafe):
    pass


@dataclass(frozen=True)
class Signature:
    domain: str
    expires: str | None
    sent: bool
    detail: str | None = None


@dataclass(frozen=True)
class CrawlerProfile:
    engine: str
    name: str
    source: str
    ready: bool
    reason: str | None
    ready_since: str | None
    header: bool
    shopify: tuple[Signature, ...]
    blocked: tuple[tuple[str, int], ...]

    @property
    def label(self) -> str:
        return self.engine or "default"

    def why_not_ready(self) -> str:
        if self.ready:
            return ""
        if self.reason is None:
            return "still getting ready"
        return REASONS.get(self.reason, self.reason)

    def as_json(self) -> dict:
        return {
            "profileId": self.engine,
            "name": self.name,
            "source": self.source,
            "ready": self.ready,
            "reason": self.reason,
            "readySince": self.ready_since,
            "navigationHeader": self.header,
            "shopify": [{"domain": s.domain, "expires": s.expires, "sent": s.sent, "detail": s.detail} for s in self.shopify],
            "blocked": dict(self.blocked),
        }


@dataclass(frozen=True)
class Status:
    path: Path
    rules_version: str
    profiles: tuple[CrawlerProfile, ...]
    pid: int | None = None
    started_at: float | None = None

    @property
    def all_ready(self) -> bool:
        return bool(self.profiles) and all(p.ready for p in self.profiles)

    def profile(self, engine: str) -> CrawlerProfile | None:
        return next((p for p in self.profiles if p.engine == engine), None)

    def as_json(self) -> dict:
        return {"path": str(self.path), "rulesVersion": self.rules_version, "ready": self.all_ready, "pid": self.pid,
                "profiles": [p.as_json() for p in self.profiles]}


def status_path(root: Path) -> Path:
    return root / STATUS_FOLDER / STATUS_FILE


def scrub(text: str) -> str:
    text = _SIGNATURE_PARAMS.sub(REDACTED, text)
    text = _BYTE_SEQUENCE.sub(REDACTED, text)
    return _LONG_TOKEN.sub(REDACTED, text)


def _text(value, limit: int = 120) -> str:
    return scrub(value[:limit]) if isinstance(value, str) else ""


def _stamp(value) -> str | None:
    return value if isinstance(value, str) and _STAMP.match(value) else None


def read_raw(path: Path) -> bytes:
    try:
        fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
    except FileNotFoundError:
        raise StatusMissing(f"no crawler status file at {path}: this Ardia isn't running a crawler profile") from None
    except NotADirectoryError:
        raise StatusMissing(f"no crawler status file at {path}") from None
    except OSError as error:
        reason = "is a symbolic link" if error.errno == errno.ELOOP else error.strerror
        raise StatusUnsafe(f"{path} {reason}") from None
    try:
        info = os.fstat(fd)
        if not stat.S_ISREG(info.st_mode):
            raise StatusUnsafe(f"{path} isn't a regular file")
        if info.st_uid != os.getuid():
            raise StatusUnsafe(f"{path} belongs to another user")
        if stat.S_IMODE(info.st_mode) != 0o600:
            raise StatusUnsafe(f"{path} must be mode 0600")
        raw = os.read(fd, MAX_STATUS_FILE + 1)
    finally:
        os.close(fd)
    if len(raw) > MAX_STATUS_FILE:
        raise StatusUnsafe(f"{path} is over {MAX_STATUS_FILE // 1024} KB")
    return raw


def _signatures(value) -> tuple[Signature, ...]:
    out = []
    for entry in value if isinstance(value, list) else []:
        if isinstance(entry, dict) and isinstance(entry.get("domain"), str) and _DOMAIN.match(entry["domain"]):
            out.append(Signature(entry["domain"], _stamp(entry.get("expires")), entry.get("sent") is True, _text(entry.get("detail"), 60) or None))
    return tuple(out)


def _blocked(value) -> tuple[tuple[str, int], ...]:
    if not isinstance(value, dict):
        return ()
    counts = [(vendor, count) for vendor, count in value.items()
              if isinstance(vendor, str) and _VENDOR.match(vendor) and isinstance(count, int) and not isinstance(count, bool) and count >= 0]
    return tuple(sorted(counts, key=lambda item: (-item[1], item[0])))


def _profile(engine: str, entry: dict) -> CrawlerProfile:
    reason = entry.get("reason")
    return CrawlerProfile(
        engine=_text(engine, 200),
        name=_text(entry.get("name")) or (engine or "Default"),
        source=entry.get("source") if entry.get("source") in ("instance", "profile") else "unknown",
        ready=entry.get("ready") is True,
        reason=_text(reason, 40) or None if reason is not None else None,
        ready_since=_stamp(entry.get("readySince")),
        header=entry.get("navigationHeader") is True,
        shopify=_signatures(entry.get("shopify")),
        blocked=_blocked(entry.get("blocked")),
    )


def parse(raw: bytes, path: Path) -> Status:
    try:
        doc = json.loads(raw)
    except ValueError:
        raise StatusUnsafe(f"{path} isn't valid JSON") from None
    if not isinstance(doc, dict) or doc.get("version") != 1 or not isinstance(doc.get("profiles"), dict):
        raise StatusUnsafe(f"{path} isn't a version 1 crawler status file")
    profiles = tuple(_profile(engine, entry) for engine, entry in sorted(doc["profiles"].items())
                     if isinstance(engine, str) and isinstance(entry, dict))
    pid = doc.get("pid") if isinstance(doc.get("pid"), int) and not isinstance(doc.get("pid"), bool) and doc["pid"] > 1 else None
    return Status(path, _text(doc.get("rulesVersion"), 40), profiles, pid, _seconds(doc.get("startedAt")))


def _seconds(value) -> float | None:
    from datetime import datetime

    if isinstance(value, bool):
        return None
    if isinstance(value, (int, float)) and value > 0:
        return value / 1000 if value > 1e11 else float(value)
    if isinstance(value, str) and _STAMP.match(value):
        return datetime.fromisoformat(value.replace("Z", "+00:00")).timestamp()
    return None


def control_pid(root: Path) -> int | None:
    from ardia_cli.endpoint import CONTROL_FILE

    try:
        control = json.loads(read_raw(root / "Chromium" / CONTROL_FILE))
    except (ValueError, StatusMissing, StatusUnsafe):
        return None
    pid = control.get("pid") if isinstance(control, dict) else None
    return pid if isinstance(pid, int) and not isinstance(pid, bool) else None


def check_fresh(status: Status, root: Path, started_of=None) -> Status:
    from ardia_cli.telemetry import process_started_at

    started_of = started_of or process_started_at
    stale = f"stale status file {status.path}"
    if status.pid is None:
        raise StatusStale(f"{stale}: it names no app pid (an Ardia from before crawler status had one, or a damaged file)")
    if status.started_at is None:
        raise StatusStale(f"{stale}: it has no startedAt")
    process_start = started_of(status.pid)
    if process_start is None:
        raise StatusStale(f"{stale}: the Ardia that wrote it (pid {status.pid}) isn't running")
    if process_start - status.started_at > STARTED_SLACK:
        raise StatusStale(f"{stale}: pid {status.pid} is a newer process than the Ardia that wrote it")
    live = control_pid(root)
    if live is not None and live != status.pid:
        raise StatusStale(f"{stale}: it was written by pid {status.pid}, but the running Ardia is pid {live}")
    return status


def read_status(root: Path, started_of=None) -> Status:
    path = status_path(root)
    return check_fresh(parse(read_raw(path), path), root, started_of)


class NotReady(Exception):
    pass


def require_ready(root: Path, wanted: str, resolve) -> dict:
    status = read_status(root)
    if not status.profiles:
        raise NotReady(f"this Ardia has no crawler profile ({status.path} lists none)")
    answer = resolve(wanted)
    engine = answer.get("engineProfile") if isinstance(answer, dict) else None
    if not isinstance(engine, str):
        raise NotReady(f"Ardia didn't say which engine profile {wanted} uses")
    entry = status.profile(engine)
    name = answer.get("name") if isinstance(answer.get("name"), str) else wanted
    if entry is None:
        raise NotReady(f"{name} isn't listed as a crawler profile in {status.path}")
    if not entry.ready:
        raise NotReady(f"{name} isn't ready: {entry.why_not_ready()}")
    if answer.get("ready") is not True:
        live = answer.get("reason") if isinstance(answer.get("reason"), str) else None
        raise NotReady(f"{name} isn't ready according to Ardia right now: {REASONS.get(live, live) if live else 'still getting ready'}")
    return {"id": answer.get("id"), "engine": engine, "name": name}
