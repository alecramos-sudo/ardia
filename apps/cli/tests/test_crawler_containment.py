import asyncio
import json
import os
import subprocess
import sys
from datetime import datetime, timezone
from pathlib import Path
from unittest import mock

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from ardia_cli import endpoint
from ardia_cli.browse import cli as browse_cli
from ardia_cli.browse import commands, daemon, profiletabs, vault
from ardia_cli.browse.errors import BrowseError
from ardia_cli.telemetry import process_started_at
from tests.test_automation import Base

PROFILE = {"id": "crawler", "engine": "p-crawler", "name": "Crawler"}
CRAWLER_CONTEXT = "CTX-CRAWLER"
DEFAULT_CONTEXT = "CTX-DEFAULT"


def stamp(seconds: float) -> str:
    return datetime.fromtimestamp(seconds, timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def entry(**extra):
    return {"name": "Crawler", "source": "profile", "ready": True, "reason": None, "readySince": "2026-11-18T21:04:05Z",
            "navigationHeader": True, "shopify": [], "blocked": {}, **extra}


class FakeBrowser:
    def __init__(self):
        self.sent = []

    async def send(self, method, params=None, **_):
        self.sent.append(method)
        if method == "Target.createTarget":
            return {"targetId": "DEFAULT-NEW"}
        return {}


class FakePage:
    def __init__(self, target_id, href="https://store.example/next"):
        self.target_id = target_id
        self.url = "https://store.example/"
        self.main_frame = "F"
        self.init_scripts = {}
        self.href = href

    async def call(self, *args, **kwargs):
        return self.href

    async def send(self, method, params=None, **_):
        raise AssertionError(f"{method} sent to {self.target_id}")

    async def refresh_frames(self):
        pass

    async def hidden(self):
        return False

    async def takes_input(self):
        return True


class FakeRegistry:
    def note_opened(self, *args):
        pass

    def note_using(self, *args):
        pass

    def numbers(self, *args, **kwargs):
        return {}


class FakeState:
    def __init__(self, current=None, profile_tabs=None):
        self.browser = FakeBrowser()
        self.current = current
        self.extras = {"profile_tabs": dict(profile_tabs or {})}
        self.target_infos = {
            "CRAWLER-1": {"targetId": "CRAWLER-1", "type": "page", "url": "https://store.example/", "browserContextId": CRAWLER_CONTEXT},
            "POPUP": {"targetId": "POPUP", "type": "page", "url": "https://store.example/popup", "browserContextId": CRAWLER_CONTEXT},
            "USER": {"targetId": "USER", "type": "page", "url": "https://mail.example/", "browserContextId": DEFAULT_CONTEXT},
        }
        self.opened, self.labels, self.app_tabs, self.app_generations, self.leases = set(), {}, {}, {}, set()
        self.pin_tab = False
        self.instance = "i"
        self.registry = FakeRegistry()
        self.endpoint = None
        self.config = {"data_root": "/nonexistent"}
        self.caller = None
        self.frames = {}
        self.pages = {}
        self.connected = False
        self.lost = False
        self.gate = None

    async def connect(self):
        if self.gate is not None:
            gate, self.gate = self.gate, None
            await gate.wait()

    async def refresh_targets(self):
        return list(self.target_infos.values())

    def tab_id(self, target):
        return {"CRAWLER-1": "t1", "POPUP": "t2", "USER": "t3"}.get(target, "t9")

    async def find_tab(self, ref):
        return ref

    async def page(self, target=None):
        return FakePage(target or self.current)

    async def locate(self, selector, page=None):
        return FakePage(self.current), mock.Mock(frame="F")


class Containment(Base):
    def ctx(self, state, name):
        return commands.Ctx(state, {"profile": dict(PROFILE)}, str(self.temp), {}, None, name)

    def run_command(self, state, name, argv):
        try:
            return asyncio.run(daemon.dispatch(self.ctx(state, name), name, argv)), None
        except BrowseError as error:
            return None, error

    def opened_in_profile(self):
        calls = []

        async def fake_open(ctx, url, label):
            calls.append(url)
            ctx.state.current = "CRAWLER-NEW"
            ctx.state.target_infos["CRAWLER-NEW"] = {"targetId": "CRAWLER-NEW", "type": "page", "url": url, "browserContextId": CRAWLER_CONTEXT}
            ctx.state.extras["profile_tabs"]["CRAWLER-NEW"] = PROFILE["engine"]
            return FakePage("CRAWLER-NEW")

        return calls, mock.patch.object(profiletabs, "open_tab", fake_open)

    def test_tab_new_opens_in_the_profile_never_the_default_context(self):
        state = FakeState(current="CRAWLER-1", profile_tabs={"CRAWLER-1": PROFILE["engine"]})
        calls, patch = self.opened_in_profile()
        with patch:
            self.run_command(state, "tab", ["new", "https://store.example/"])
        self.assertNotIn("Target.createTarget", state.browser.sent)
        self.assertEqual(calls, ["https://store.example/"])

    def test_click_new_tab_opens_in_the_profile(self):
        state = FakeState(current="CRAWLER-1", profile_tabs={"CRAWLER-1": PROFILE["engine"]})
        calls, patch = self.opened_in_profile()
        with patch:
            result, error = self.run_command(state, "click", ["a", "--new-tab"])
        self.assertNotIn("Target.createTarget", state.browser.sent)
        self.assertEqual(calls, ["https://store.example/next"])
        self.assertEqual(state.current, "CRAWLER-1")

    def test_window_new_and_read_refuse(self):
        state = FakeState(current="CRAWLER-1", profile_tabs={"CRAWLER-1": PROFILE["engine"]})
        for name, argv in (("window", ["new", "https://store.example/"]), ("read", ["https://store.example/"])):
            _, error = self.run_command(state, name, argv)
            self.assertIsNotNone(error, name)
            self.assertEqual(error.code, "profile_unsupported", name)
        self.assertNotIn("Target.createTarget", state.browser.sent)

    def test_auth_login_needs_a_tab_in_the_profile(self):
        state = FakeState(current=None)
        with mock.patch.object(vault, "login", side_effect=AssertionError("auth login ran outside the profile")) as login:
            _, error = self.run_command(state, "auth", ["login", "shop"])
        login.assert_not_called()
        self.assertEqual(getattr(error, "code", None), "not_in_profile")
        self.assertNotIn("Target.createTarget", state.browser.sent)

    def test_a_popup_the_crawler_page_opened_is_in_the_profile_and_a_user_tab_isnt(self):
        state = FakeState(current="CRAWLER-1", profile_tabs={"CRAWLER-1": PROFILE["engine"]})
        _, error = self.run_command(state, "tab", ["USER"])
        self.assertEqual(getattr(error, "code", None), "not_in_profile")
        self.assertEqual(state.current, "CRAWLER-1")
        result, error = self.run_command(state, "tab", ["POPUP"])
        self.assertIsNone(error)
        self.assertEqual(state.current, "POPUP")
        state.current = "USER"
        _, error = self.run_command(state, "eval", ["1"])
        self.assertEqual(getattr(error, "code", None), "not_in_profile")

    def test_navigation_outside_the_profile_is_refused(self):
        state = FakeState(current="USER")
        ctx = self.ctx(state, "open")
        with self.assertRaises(BrowseError) as caught:
            asyncio.run(commands.navigate(ctx, FakePage("USER"), "https://store.example/"))
        self.assertEqual(caught.exception.code, "not_in_profile")

    def test_temporary_tabs_refuse_under_a_profile(self):
        from ardia_cli.browse import temptabs

        state = FakeState(current="CRAWLER-1", profile_tabs={"CRAWLER-1": PROFILE["engine"]})
        with self.assertRaises(BrowseError) as caught:
            asyncio.run(temptabs.create(state, [], dict(PROFILE)))
        self.assertEqual(caught.exception.code, "profile_unsupported")
        self.assertNotIn("Target.createTarget", state.browser.sent)

    def test_read_with_profile_refuses_before_any_daemon(self):
        with mock.patch.object(browse_cli, "crawler_profile", side_effect=AssertionError("resolved a profile for read")):
            status, out, err = self.run_cli("browse", "--profile", "Crawler", "read", "https://store.example/")
        self.assertEqual(status, 1)
        self.assertIn("doesn't run with --profile", out + err)


class Freshness(Base):
    def write_status(self, profiles, **top):
        folder = self.data / "crawler"
        folder.mkdir(exist_ok=True, mode=0o700)
        path = folder / "status.json"
        path.write_text(json.dumps({"version": 1, "rulesVersion": "2026-11-18.2", "profiles": profiles, **top}))
        os.chmod(path, 0o600)
        return path

    def live(self):
        return {"pid": os.getpid(), "startedAt": stamp(process_started_at() + 1)}

    def serve_profile(self, ready=True, reason=None):
        server = self.serve()
        server.replies["crawler.profile"] = lambda params: {"result": {"id": "crawler", "name": "Crawler", "engineProfile": "p-crawler", "ready": ready, "reason": reason}}
        return server

    def gate(self):
        return browse_cli.crawler_profile(self.data, "Crawler")

    def refused_code(self):
        try:
            self.gate()
        except BrowseError as error:
            return error.code, error.message
        return None, "opened"

    def test_a_fresh_ready_status_and_a_ready_app_pass(self):
        self.write_status({"p-crawler": entry()}, **self.live())
        self.serve_profile()
        self.assertEqual(self.gate(), {"id": "crawler", "engine": "p-crawler", "name": "Crawler"})

    def test_the_live_answer_wins_over_the_file(self):
        self.write_status({"p-crawler": entry()}, **self.live())
        self.serve_profile(ready=False, reason="selftest_failed")
        code, message = self.refused_code()
        self.assertEqual(code, "crawler_not_ready")
        self.assertIn("self-test", message)

    def test_a_status_file_without_a_pid_is_stale(self):
        self.write_status({"p-crawler": entry()})
        self.serve_profile()
        code, message = self.refused_code()
        self.assertEqual(code, "crawler_stale_status")
        self.assertIn("stale status file", message)

    def test_a_status_file_from_a_dead_app_is_stale(self):
        done = subprocess.run([sys.executable, "-c", "import os; print(os.getpid())"], capture_output=True, text=True)
        self.write_status({"p-crawler": entry()}, pid=int(done.stdout), startedAt=stamp(process_started_at()))
        self.serve_profile()
        code, message = self.refused_code()
        self.assertEqual(code, "crawler_stale_status")
        self.assertIn("isn't running", message)

    def test_a_reused_pid_is_stale(self):
        self.write_status({"p-crawler": entry()}, pid=os.getpid(), startedAt=stamp(process_started_at() - 3600))
        self.serve_profile()
        code, message = self.refused_code()
        self.assertEqual(code, "crawler_stale_status")
        self.assertIn("newer process", message)

    def test_a_status_file_from_another_instance_than_the_control_file_is_stale(self):
        self.write_status({"p-crawler": entry()}, **self.live())
        control = self.data / "Chromium" / endpoint.CONTROL_FILE
        control.parent.mkdir()
        control.write_text(json.dumps({"pid": os.getppid()}))
        os.chmod(control, 0o600)
        self.serve_profile()
        code, message = self.refused_code()
        self.assertEqual(code, "crawler_stale_status")
        self.assertIn("running Ardia is pid", message)

    def test_status_command_says_stale_and_exits_2(self):
        self.write_status({"p-crawler": entry()})
        status, _, err = self.run_cli("crawler", "status")
        self.assertEqual(status, 2)
        self.assertIn("stale status file", err)
        self.write_status({"p-crawler": entry()}, **self.live())
        self.assertEqual(self.run_cli("crawler", "status")[0], 0)


class ConcurrentRequests(Base):
    def test_an_unprofiled_request_waiting_for_the_lock_cant_strip_a_running_profiled_open(self):
        state = FakeState(current="USER")
        opened = []

        async def fake_open(ctx, url, label):
            opened.append(url)
            ctx.state.current = "CRAWLER-NEW"
            ctx.state.target_infos["CRAWLER-NEW"] = {"targetId": "CRAWLER-NEW", "type": "page", "url": url, "browserContextId": CRAWLER_CONTEXT}
            return FakePage("CRAWLER-NEW")

        session = daemon.Daemon.__new__(daemon.Daemon)
        session.state, session.stopping, session.config = state, False, {}

        async def scenario():
            session.lock = asyncio.Lock()
            gate = state.gate = asyncio.Event()
            profiled = asyncio.ensure_future(session.execute({"argv": ["open", "https://store.example/"], "options": {"profile": dict(PROFILE), "no_changes": True}}))
            await asyncio.sleep(0.05)
            plain = asyncio.ensure_future(session.execute({"argv": ["get", "url"], "options": {}}))
            await asyncio.sleep(0.05)
            gate.set()
            return await profiled, await plain

        with mock.patch.object(profiletabs, "open_tab", fake_open):
            (code, out, err), _ = asyncio.run(scenario())
        self.assertNotIn("Page.navigate sent to USER", out + err)
        self.assertEqual(opened, ["https://store.example/"])
        self.assertEqual(code, 0, out + err)
