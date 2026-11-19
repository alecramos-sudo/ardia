import asyncio
import json
import shutil
import sys
import tempfile
import unittest
from collections import OrderedDict
from pathlib import Path
from types import SimpleNamespace
from unittest import mock

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from ardia_cli import telemetry_scrub
from ardia_cli.browse import capture, commands
from ardia_cli.browse.page import Page

SIGNATURE = "sig1=:c2VjcmV0LXNpZ25hdHVyZS12YWx1ZQ==:"
SIGNATURE_INPUT = 'sig1=("@authority" "signature-agent");created=1763500000;expires=1766000000;keyid="secret-key-id";tag="web-bot-auth"'
AGENT = '"https://shopify.com"'
MARKS = ("c2VjcmV0LXNpZ25hdHVyZS12YWx1ZQ", "secret-key-id", "web-bot-auth", "shopify.com")
SIGNED = {"Signature": SIGNATURE, "signature-input": SIGNATURE_INPUT, "Signature-Agent": AGENT, "Accept": "text/html"}


def leaks(text: str) -> list[str]:
    return [mark for mark in MARKS if mark in text]


class CapturedHeaders(unittest.TestCase):
    def page(self):
        page = Page(SimpleNamespace(sessions={}, on_page_event=lambda *a: None, auto_dialog=True), "T")
        page.network_on = True
        return page

    def test_network_records_never_keep_signature_values(self):
        page = self.page()
        page.on_event("Network.requestWillBeSent", {"requestId": "1", "request": {"url": "https://shop.example/", "method": "GET", "headers": dict(SIGNED)}})
        page.on_event("Network.responseReceived", {"requestId": "1", "response": {"status": 200, "headers": {"Signature": SIGNATURE, "Content-Type": "text/html"}}})
        record = page.requests["1"]
        self.assertEqual(leaks(json.dumps(record)), [])
        self.assertEqual(record["headers"]["Accept"], "text/html")
        self.assertEqual(set(record["headers"]), set(SIGNED))
        self.assertEqual(record["responseHeaders"]["Content-Type"], "text/html")

    def test_a_har_never_holds_signature_values(self):
        temp = Path(tempfile.mkdtemp())
        self.addCleanup(shutil.rmtree, temp, True)
        page = self.page()
        page.requests = OrderedDict({"9": {"requestId": "9", "url": "https://shop.example/", "method": "GET", "headers": dict(SIGNED),
                                           "responseHeaders": {"Signature-Input": SIGNATURE_INPUT}, "status": 200, "timestamp": 1}})

        async def current_page(target=None):
            return page

        state = SimpleNamespace(page=current_page, extras={"har": {"target": "T", "since": 0, "mode": "none", "seen": set()}}, leases={"har"},
                                endpoint=SimpleNamespace(explicit=True))
        ctx = commands.Ctx(state, {}, str(temp), {}, None, "network")
        with mock.patch.object(capture, "release_claim", lambda *a: None):
            asyncio.run(capture.network_har(ctx, ["stop", "out.har"]))
        text = (temp / "out.har").read_text()
        self.assertEqual(leaks(text), [])
        names = [h["name"] for h in json.loads(text)["log"]["entries"][0]["request"]["headers"]]
        self.assertEqual(names, list(SIGNED))


class ScrubbedText(unittest.TestCase):
    def test_feedback_and_telemetry_scrubbing_removes_the_whole_header_values(self):
        for line in (f"Signature: {SIGNATURE}", f"signature-input: {SIGNATURE_INPUT}", f"Signature-Agent: {AGENT}",
                     json.dumps({"Signature-Input": SIGNATURE_INPUT}), f"curl -H 'Signature-Input: {SIGNATURE_INPUT}'"):
            self.assertEqual(leaks(telemetry_scrub.scrub(line)), [], line)
            self.assertEqual(leaks(telemetry_scrub.free_text(line, 4000)[0]), [], line)
        self.assertIn("Accept: text/html", telemetry_scrub.scrub("Accept: text/html"))
