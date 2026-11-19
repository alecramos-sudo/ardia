import json
import time

from ardia_cli import control, crawler, endpoint
from ardia_cli.control import MethodError, Unreachable
from ardia_cli.endpoint import DATA_DIR_HELP
from ardia_cli.printable import complain, say, shown

POLL_SECONDS = 0.5
MAX_WAIT = 3600.0
DESCRIPTION = """\
Check and reset crawler profiles: profiles whose tracking requests Ardia blocks before they leave the browser, so an
agent's crawl of a store doesn't show up in its analytics (docs/crawler-mode.md).

status reads <data dir>/crawler/status.json, which Ardia writes (0600, never a signature value), and prints each
crawler profile: ready or not and why, whether the X-Ardia-Crawler header is on, the Shopify domains it signs for
with their expiry, and what it has blocked. reset clears a crawler profile's cookies and storage through the control
socket, between runs.
"""
STATUS_DESCRIPTION = """\
Print each crawler profile from <data dir>/crawler/status.json: ready or not and why, the X-Ardia-Crawler header,
Shopify signature domains with their expiry, and blocked request counts per vendor. The file is trusted only when
it's a regular file the user owns, mode 0600. Signature values are never in it, and anything that looks like one is
printed as [redacted].

--wait SECONDS re-reads it until every crawler profile is ready or the time is up.

A status file is stale, and not used, when the Ardia that wrote it (its pid and startedAt) isn't the one running.

Exit status: 0 every crawler profile is ready, 1 one isn't (or none is listed), 2 no usable status file (missing, unsafe
or stale).
"""
RESET_DESCRIPTION = """\
Clear a crawler profile's cookies, cache and site storage through the control socket (Ardia running with "Let the
ardia command control Ardia" on), so the next run starts as a new visitor. --profile takes the profile's name or id; a profile
that isn't a crawler profile is refused.

Exit status: 0 reset, 1 refused or it failed, 2 Ardia can't be reached.
"""


def add_parser(commands, formatter):
    parser = commands.add_parser("crawler", help="check and reset crawler profiles", description=DESCRIPTION, formatter_class=formatter)
    verbs = parser.add_subparsers(dest="crawler_command", metavar="<command>")
    status = verbs.add_parser("status", help="is each crawler profile ready", description=STATUS_DESCRIPTION, formatter_class=formatter)
    status.add_argument("--data-dir", metavar="DIR", help=DATA_DIR_HELP)
    status.add_argument("--json", action="store_true", help="print the status as JSON")
    status.add_argument("--wait", type=float, metavar="SECONDS", help="wait up to SECONDS for every crawler profile to be ready")
    reset = verbs.add_parser("reset", help="clear a crawler profile's cookies and storage", description=RESET_DESCRIPTION, formatter_class=formatter)
    reset.add_argument("--profile", required=True, metavar="NAME", help="the crawler profile's name or id")
    reset.add_argument("--data-dir", metavar="DIR", help=DATA_DIR_HELP)
    reset.add_argument("--json", action="store_true", help="print the reply as JSON")


def run(args, parser) -> int:
    if args.crawler_command == "status":
        return status(args)
    if args.crawler_command == "reset":
        return reset(args)
    parser.parse_args(["crawler", "--help"])
    return 2


def describe(profile: crawler.CrawlerProfile) -> list[str]:
    head = f"{shown(profile.name)} ({shown(profile.label)}, {profile.source}): "
    if profile.ready:
        head += f"ready since {profile.ready_since}" if profile.ready_since else "ready"
    else:
        head += f"not ready, {profile.why_not_ready()}"
    lines = [head, f"  header: {'on' if profile.header else 'off'}"]
    signed = [f"{s.domain} ({f'expires {s.expires}' if s.expires else 'no expiry'}, {'sent' if s.sent else 'not sent'}{f': {shown(s.detail)}' if s.detail and not s.sent else ''})"
              for s in profile.shopify]
    lines.append(f"  shopify: {'; '.join(signed) or 'none'}")
    blocked = ", ".join(f"{vendor} {count}" for vendor, count in profile.blocked)
    lines.append(f"  blocked: {blocked or 'nothing yet'}")
    return lines


def read_until(root, wait: float | None):
    deadline = time.monotonic() + min(max(wait or 0, 0), MAX_WAIT)
    while True:
        try:
            found = crawler.read_status(root)
        except (crawler.StatusMissing, crawler.StatusUnsafe) as error:
            found = error
        done = isinstance(found, crawler.Status) and found.all_ready
        if done or wait is None or time.monotonic() >= deadline:
            return found
        time.sleep(min(POLL_SECONDS, max(deadline - time.monotonic(), 0)))


def status(args) -> int:
    from ardia_cli import telemetry

    if args.wait is not None and args.wait < 0:
        complain("ardia crawler status: --wait takes a number of seconds, 0 or more")
        return 2
    found = read_until(endpoint.data_root(args.data_dir), args.wait)
    if not isinstance(found, crawler.Status):
        telemetry.note_error_code("status_missing" if isinstance(found, crawler.StatusMissing) else "status_stale" if isinstance(found, crawler.StatusStale) else "status_unsafe")
        complain(f"ardia crawler status: {found}")
        return 2
    if args.json:
        say(json.dumps(found.as_json(), indent=2, ensure_ascii=False))
    elif not found.profiles:
        say(f"no crawler profiles (rules {found.rules_version or 'unknown'})")
    else:
        for profile in found.profiles:
            for line in describe(profile):
                say(line)
        say(f"rules {found.rules_version or 'unknown'}")
    if not found.all_ready:
        telemetry.note_error_code("not_ready")
        return 1
    return 0


def reset(args) -> int:
    from ardia_cli import telemetry

    try:
        reply = control.call(args.data_dir, "crawler.reset", {"profile": args.profile})
    except Unreachable as error:
        if error.sent:
            complain(f"ardia crawler reset: the connection dropped after the request went out, so it may or may not have run ({error})")
        else:
            complain(f"ardia: {error}")
        return 2
    except MethodError as error:
        telemetry.note_error_code(error.code)
        if error.code == "unknown_method":
            complain("ardia crawler reset: this Ardia doesn't know crawler.reset yet; update Ardia")
        else:
            complain(f"ardia crawler reset: {error.message}")
        return 1
    reply = reply if isinstance(reply, dict) else {}
    if args.json:
        say(json.dumps(reply, indent=2, ensure_ascii=False))
    else:
        say(f"reset {shown(reply.get('name') or args.profile)} ({shown(reply.get('profile') or '')}): cookies and storage cleared")
    return 0
