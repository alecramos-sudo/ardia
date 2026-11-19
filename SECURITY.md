# Security policy

This policy covers **Ardia Fork**, the build of Ardia published from
[alecramos-sudo/ardia](https://github.com/alecramos-sudo/ardia). The fork is not run by the Ardia project. For the
official Ardia app from ardia.dev, use the upstream repository's own policy at
[ardia-browser/ardia](https://github.com/ardia-browser/ardia).

## Reporting a vulnerability

Please report privately, through GitHub's private vulnerability reporting: open the repository's **Security** tab and
choose **Report a vulnerability** ([direct link](https://github.com/alecramos-sudo/ardia/security/advisories/new)).
The report becomes a draft advisory that only you and the maintainer can see, and it can get a CVE if one is needed.

Don't open a public issue, discussion or pull request for a vulnerability, and don't post details anywhere public
before a fix ships.

A useful report says which build you ran (the About window shows the version and build), what you did, what
happened, and what an attacker gains. A proof of concept helps but isn't required.

If the problem is also in upstream Ardia, say so; we'll tell upstream privately, not in public.

## Scope

In scope:

- the engine patches (`engine/patches`) and Ardia's own engine code (`engine/chromium`, `engine/ardiacore`);
- ArdiaCore and the native modules (`packages/*/ios`);
- the control socket and its token, and the `ardia` command line tool that uses them;
- sync, and importing from other browsers;
- the updater;
- the fork's own packaging, signing and update feed (`scripts/fork`).

Out of scope: bugs in Chromium or Helium themselves that the fork hasn't changed (report those to
[Chromium](https://issues.chromium.org) or [Helium](https://github.com/imputnet/helium)), ardia.dev and the services
upstream runs, and anything that needs an attacker who already controls your Mac account.

## Supported versions

Only the latest Ardia Fork build gets fixes. Please check a report against the latest build before sending it.

## Response targets

These are targets, not guarantees:

- an acknowledgement within 7 days;
- for a high or critical issue, a fixed build within 30 days of the acknowledgement, sooner when it is being exploited;
- credit in the advisory, unless you'd rather not be named.

## Chromium security fixes

The engine is built from source for each fork build: today Chromium 158.0.8127.36 with Helium 0.22.1's patches and
Ardia's patch series. A Chromium security fix reaches the fork in two hops, Chromium to Helium to Ardia, so the fork runs
behind Chrome stable.

The target is to follow Helium: a fork build on a new Helium release within 7 days of that release when it carries
Chromium security fixes. It is a target, not a promise, and an engine rebuild can take longer when Ardia's patches need
work on the new tree.
