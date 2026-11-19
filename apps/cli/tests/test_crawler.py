import asyncio
import json
import os
import sys
import threading
import time
from pathlib import Path
from types import SimpleNamespace
from unittest import mock

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from datetime import datetime, timezone

from ardia_cli import crawler
from ardia_cli.telemetry import process_started_at
from ardia_cli.browse import cli as browse_cli
from ardia_cli.browse import client as browse_client
from ardia_cli.browse import profiletabs
from ardia_cli.browse.errors import BrowseError
from tests.test_automation import Base

SIGNATURE = "sig1=:c2VjcmV0LXNpZ25hdHVyZS12YWx1ZQ==:"


def entry(**extra):
    return {
        "name": "Crawler", "source": "instance", "ready": True, "reason": None, "readySince": "2026-11-18T21:04:05Z",
        "navigationHeader": True, "shopify": [{"domain": "signed-store.example.com", "expires": "2027-02-16T00:00:00Z", "sent": True}],
        "blocked": {"google": 12, "shopify": 30}, **extra,
    }


class Crawler(Base):
    def write_status(self, profiles, mode=0o600, version=1):
        folder = self.data / "crawler"
        folder.mkdir(exist_ok=True, mode=0o700)
        path = folder / "status.json"
        started = datetime.fromtimestamp(process_started_at() + 1, timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
        path.write_text(json.dumps({"version": version, "rulesVersion": "2026-11-18.1", "pid": os.getpid(), "startedAt": started, "profiles": profiles}))
        os.chmod(path, mode)
        return path

    def test_missing_file_exits_2(self):
        status, out, err = self.run_cli("crawler", "status")
        self.assertEqual((status, out), (2, ""))
        self.assertIn("no crawler status file", err)

    def test_unsafe_files_exit_2(self):
        path = self.write_status({"": entry()}, mode=0o644)
        status, _, err = self.run_cli("crawler", "status")
        self.assertEqual(status, 2)
        self.assertIn("must be mode 0600", err)
        os.chmod(path, 0o600)
        real = path.with_name("real.json")
        path.rename(real)
        os.symlink(real, path)
        status, _, err = self.run_cli("crawler", "status")
        self.assertEqual(status, 2)
        self.assertIn("symbolic link", err)
        path.unlink()
        path.mkdir()
        status, _, err = self.run_cli("crawler", "status")
        self.assertEqual(status, 2)
        path.rmdir()
        self.write_status({"": entry()}, version=2)
        self.assertEqual(self.run_cli("crawler", "status")[0], 2)
        with mock.patch.object(os, "getuid", return_value=os.getuid() + 1):
            status, _, err = self.run_cli("crawler", "status")
        self.assertEqual(status, 2)
        self.assertIn("belongs to another user", err)

    def test_ready_profiles_print_and_exit_0(self):
        self.write_status({"": entry(), "p-work": entry(name="Work", source="profile", navigationHeader=False, blocked={},
                                                        shopify=[{"domain": "a.example", "expires": None, "sent": False, "detail": "NetLog is on"}])})
        status, out, _ = self.run_cli("crawler", "status")
        self.assertEqual(status, 0)
        lines = out.splitlines()
        self.assertEqual(lines[0], "Crawler (default, instance): ready since 2026-11-18T21:04:05Z")
        self.assertIn("  header: on", lines)
        self.assertIn("  shopify: signed-store.example.com (expires 2027-02-16T00:00:00Z, sent)", lines)
        self.assertIn("  blocked: shopify 30, google 12", lines)
        self.assertIn("Work (p-work, profile): ready since 2026-11-18T21:04:05Z", lines)
        self.assertIn("  header: off", lines)
        self.assertIn("  shopify: a.example (no expiry, not sent: NetLog is on)", lines)
        self.assertIn("  blocked: nothing yet", lines)
        self.assertEqual(lines[-1], "rules 2026-11-18.1")
        status, out, _ = self.run_cli("crawler", "status", "--json")
        doc = json.loads(out)
        self.assertTrue(doc["ready"])
        self.assertEqual([p["profileId"] for p in doc["profiles"]], ["", "p-work"])
        self.assertEqual(doc["profiles"][0]["blocked"], {"shopify": 30, "google": 12})

    def test_not_ready_exits_1_with_the_reason(self):
        self.write_status({"": entry(ready=False, reason="selftest_failed", readySince=None)})
        status, out, _ = self.run_cli("crawler", "status")
        self.assertEqual(status, 1)
        self.assertIn("not ready, its tracker blocking didn't pass the self-test", out)
        self.write_status({})
        status, out, _ = self.run_cli("crawler", "status")
        self.assertEqual(status, 1)
        self.assertIn("no crawler profiles", out)

    def test_signature_like_values_never_print(self):
        self.write_status({"": entry(name=f"x {SIGNATURE}", reason=SIGNATURE, ready=False,
                                     shopify=[{"domain": SIGNATURE, "expires": SIGNATURE, "sent": True}], blocked={SIGNATURE: 1})})
        for argv in (("crawler", "status"), ("crawler", "status", "--json")):
            status, out, err = self.run_cli(*argv)
            self.assertEqual(status, 1)
            self.assertNotIn("c2VjcmV0", out + err)
        self.assertEqual(crawler.scrub("Signature-Input: sig1=(\"@authority\");keyid=\"k\""), "Signature-Input: [redacted]")
        self.assertEqual(crawler.scrub("a " + "Q" * 40 + " b"), "a [redacted] b")

    def test_wait_polls_until_ready_or_the_deadline(self):
        self.write_status({"": entry(ready=False, reason=None, readySince=None)})
        timer = threading.Timer(0.6, lambda: self.write_status({"": entry()}))
        timer.start()
        self.addCleanup(timer.cancel)
        started = time.monotonic()
        status, out, _ = self.run_cli("crawler", "status", "--wait", "10")
        self.assertEqual(status, 0)
        self.assertLess(time.monotonic() - started, 5)
        self.assertIn("ready since", out)
        self.write_status({"": entry(ready=False, reason="timeout", readySince=None)})
        started = time.monotonic()
        status, _, _ = self.run_cli("crawler", "status", "--wait", "0.7")
        self.assertEqual(status, 1)
        self.assertGreaterEqual(time.monotonic() - started, 0.6)
        (self.data / "crawler" / "status.json").unlink()
        self.assertEqual(self.run_cli("crawler", "status", "--wait", "0.3")[0], 2)

    def test_reset_goes_through_the_control_socket(self):
        server = self.serve()
        server.replies["crawler.reset"] = lambda params: (
            {"result": {"ok": True, "profile": "default", "name": "Personal", "engineProfile": ""}} if params["profile"] == "Personal"
            else {"error": {"code": "refused", "message": f"{params['profile']} isn't a crawler profile"}})
        status, out, _ = self.run_cli("crawler", "reset", "--profile", "Personal")
        self.assertEqual(status, 0)
        self.assertIn("reset Personal (default)", out)
        status, _, err = self.run_cli("crawler", "reset", "--profile", "Work")
        self.assertEqual(status, 1)
        self.assertIn("Work isn't a crawler profile", err)
        self.assertEqual([p for m, p in server.requests if m == "crawler.reset"], [{"profile": "Personal"}, {"profile": "Work"}])

    def test_reset_unreachable_and_old_apps(self):
        self.assertEqual(self.run_cli("crawler", "reset", "--profile", "Personal")[0], 2)
        self.serve()
        status, _, err = self.run_cli("crawler", "reset", "--profile", "Personal")
        self.assertEqual(status, 1)
        self.assertIn("update Ardia", err)


class BrowseProfile(Base):
    write_status = Crawler.write_status

    def serve_profiles(self, answer):
        server = self.serve()
        server.replies["crawler.profile"] = answer
        return server

    def ready_answer(self, params):
        if params["profile"] in ("Crawler", "default"):
            return {"result": {"id": "default", "name": "Crawler", "engineProfile": "", "ready": True, "reason": None}}
        return {"error": {"code": "refused", "message": f"{params['profile']} isn't a crawler profile"}}

    def gate(self, name="Crawler"):
        return browse_cli.crawler_profile(self.data, name)

    def test_ready_profile_resolves(self):
        self.write_status({"": entry()})
        self.serve_profiles(self.ready_answer)
        self.assertEqual(self.gate(), {"id": "default", "engine": "", "name": "Crawler"})

    def test_refusals(self):
        with self.assertRaises(BrowseError) as caught:
            self.gate()
        self.assertEqual(caught.exception.code, "crawler_no_status")
        self.write_status({})
        with self.assertRaises(BrowseError) as caught:
            self.gate()
        self.assertEqual(caught.exception.code, "crawler_not_ready")
        self.write_status({"": entry(ready=False, reason="selftest_failed", readySince=None)})
        self.serve_profiles(self.ready_answer)
        with self.assertRaises(BrowseError) as caught:
            self.gate()
        self.assertEqual(caught.exception.code, "crawler_not_ready")
        self.assertIn("self-test", caught.exception.message)
        with self.assertRaises(BrowseError) as caught:
            self.gate("Personal")
        self.assertEqual(caught.exception.code, "crawler_refused")
        self.write_status({"p-other": entry()})
        with self.assertRaises(BrowseError) as caught:
            self.gate()
        self.assertEqual(caught.exception.code, "crawler_not_ready")

    def test_unready_profile_never_starts_a_session(self):
        self.write_status({"": entry(ready=False, reason="timeout", readySince=None)})
        self.serve_profiles(self.ready_answer)
        with mock.patch.object(browse_client, "ensure_daemon", side_effect=AssertionError("started a daemon")):
            status, out, err = self.run_cli("browse", "--profile", "Crawler", "open", "https://example.com")
        self.assertEqual(status, 1)
        self.assertIn("isn't ready", err + out)
        self.assertFalse((self.data / "Browse").exists())

    def test_without_profile_nothing_changes(self):
        found, rest = browse_cli.split_globals(["open", "https://example.com"])
        self.assertNotIn("profile", found)
        found, rest = browse_cli.split_globals(["--profile", "Crawler", "open", "https://example.com"])
        self.assertEqual((found["profile"], rest), ("Crawler", ["open", "https://example.com"]))


class ProfileTabs(Base):
    def state(self, current=None, tabs=None, profile=None):
        return SimpleNamespace(current=current, target_infos={}, extras={"profile_tabs": tabs or {}, "profile": profile}, tab_id=lambda t: "t1")

    def test_guard_refuses_a_tab_outside_the_profile(self):
        profile = {"id": "default", "engine": "", "name": "Crawler"}
        outside = SimpleNamespace(options={"profile": profile}, state=self.state(current="T1"))
        with mock.patch.object(profiletabs, "call", side_effect=BrowseError("no socket", code="crawler_unreachable")):
            with self.assertRaises(BrowseError) as caught:
                asyncio.run(profiletabs.guard(outside, "click"))
            self.assertEqual(caught.exception.code, "not_in_profile")
        asyncio.run(profiletabs.guard(outside, "open"))
        asyncio.run(profiletabs.guard(outside, "batch"))
        inside = SimpleNamespace(options={"profile": profile}, state=self.state(current="T1", tabs={"T1": ""}))
        asyncio.run(profiletabs.guard(inside, "click"))
        asyncio.run(profiletabs.guard(SimpleNamespace(options={}, state=self.state()), "click"))

    def test_target_lookup_wakes_an_asleep_tab_once(self):
        calls = []
        rows = [{"id": "tab-1", "targetId": None}]

        async def fake_call(state, method, params=None):
            calls.append((method, params))
            if method == "apply":
                rows[0]["targetId"] = "T1"
                return {"ok": True, "results": [{"op": "tab.wake", "tabs": ["tab-1"]}]}
            return [{"id": "w-1", "tabs": [dict(row) for row in rows]}]

        async def refresh():
            state.target_infos = {"T1": {}}

        state = SimpleNamespace(target_infos={}, refresh_targets=refresh)
        with mock.patch.object(profiletabs, "call", fake_call), mock.patch.object(profiletabs, "WAKE_AFTER", 0.05):
            target = asyncio.run(profiletabs.target_of(state, "tab-1", 5))
        self.assertEqual(target, "T1")
        self.assertEqual([m for m, _ in calls].count("apply"), 1)
        self.assertEqual(next(p for m, p in calls if m == "apply"), {"ops": [{"op": "tab.wake", "tabs": ["tab-1"]}]})

    def test_open_tab_opens_through_apply_in_the_profile(self):
        sent = []

        async def fake_call(state, method, params=None):
            sent.append((method, params))
            if method == "apply":
                return {"ok": True, "results": [{"op": "open", "tabs": ["tab-9"]}]}
            return [{"id": "w-1", "tabs": [{"id": "tab-9", "targetId": "T9"}]}]

        async def refused(state, method, params=None):
            return {"ok": False, "error": {"code": "refused", "message": "Ardia refused it."}}

        state = SimpleNamespace(target_infos={}, extras={"profile": {"id": "work", "engine": "p-work", "name": "Crawler"}}, opened=set(), labels={}, app_tabs={}, pin_tab=False, current=None, instance="i",
                                registry=SimpleNamespace(note_opened=lambda instance, target: None), tab_id=lambda target: "t1")

        async def connect():
            pass

        async def refresh():
            state.target_infos = {"T9": {}}

        page = SimpleNamespace(target_id="T9", init_scripts={}, main_frame="F")

        async def page_of(target):
            return page

        async def loaded(*args, **kwargs):
            return None

        state.connect, state.refresh_targets, state.page = connect, refresh, page_of
        ctx = SimpleNamespace(state=state, options={"profile": {"id": "work", "engine": "p-work", "name": "Crawler"}}, timeout=5)
        with mock.patch.object(profiletabs, "call", fake_call), mock.patch.object(profiletabs, "settled", loaded):
            asyncio.run(profiletabs.open_tab(ctx, "https://shop.example/", None))
        self.assertEqual(sent[0], ("apply", {"ops": [{"op": "open", "urls": ["https://shop.example/"], "profile": "work"}]}))
        self.assertEqual(state.current, "T9")
        self.assertEqual(state.extras["profile_tabs"], {"T9": "p-work"})
        self.assertIn("T9", state.opened)
        with mock.patch.object(profiletabs, "call", refused), self.assertRaises(BrowseError) as caught:
            asyncio.run(profiletabs.open_tab(ctx, "https://shop.example/", None))
        self.assertEqual(caught.exception.code, "crawler_refused")
