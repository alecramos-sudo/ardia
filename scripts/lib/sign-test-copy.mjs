#!/usr/bin/env node
import { INJECTION_ENTITLEMENTS, signTestCopy } from "./app-copy.mjs";

const [copy, ...extra] = process.argv.slice(2);
if (!copy || extra.length) {
  console.error("usage: scripts/lib/sign-test-copy.mjs <a copy of Ardia.app>  (signs it ad hoc as <bundle id>.testcopy with the injection entitlements)");
  process.exit(64);
}
signTestCopy(copy, INJECTION_ENTITLEMENTS);
