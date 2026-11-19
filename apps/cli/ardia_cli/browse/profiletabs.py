import asyncio
from pathlib import Path

from ardia_cli.browse.errors import BrowseError
from ardia_cli.browse.tabs import app_tab_rows

CALL_TIMEOUT = 10.0
WAKE_AFTER = 2.0
CHECKS_ITS_OWN_TABS = frozenset({"open", "tab", "close", "session", "batch", "plugin"})
REFUSED = {
    "window": "a new window can't be opened in a crawler profile from here; use `open <url>` (it opens a tab there)",
    "read": "read fetches pages outside the browser or in temporary tabs outside the profile; use `open <url>` then `get text body`",
}


def active(ctx) -> dict | None:
    options = getattr(ctx, "options", None)
    profile = options.get("profile") if isinstance(options, dict) else None
    return dict(profile) if isinstance(profile, dict) else None


def control_path(state) -> Path:
    from ardia_cli import control

    found = state.endpoint
    if found is not None and getattr(found, "explicit", True) is False and isinstance(getattr(found, "source", None), str):
        return control.announce_path(found.source)
    return Path(state.config["data_root"]) / control.SOCKET_FILE


def profile_tabs(state) -> dict:
    return state.extras.setdefault("profile_tabs", {})


def contexts(state) -> dict:
    return state.extras.setdefault("profile_contexts", {})


def context_of(state, target: str | None) -> str | None:
    value = (state.target_infos.get(target) or {}).get("browserContextId") if target else None
    return value if isinstance(value, str) and value else None


async def profile_context(state, profile: dict) -> str | None:
    engine = profile.get("engine")
    known = contexts(state).get(engine)
    if known:
        return known
    for target, owner in profile_tabs(state).items():
        if owner == engine and context_of(state, target):
            contexts(state)[engine] = context_of(state, target)
            return contexts(state)[engine]
    try:
        rows = app_tab_rows(await call(state, "windows"))
    except BrowseError:
        return None
    targets = [row.get("targetId") for row in rows if row.get("profile") == profile.get("id") and isinstance(row.get("targetId"), str)]
    if targets:
        await state.refresh_targets()
    for target in targets:
        if context_of(state, target):
            contexts(state)[engine] = context_of(state, target)
            return contexts(state)[engine]
    return None


async def member(state, profile: dict, target: str | None) -> bool:
    if target is None:
        return False
    if profile_tabs(state).get(target) == profile.get("engine"):
        return True
    own = context_of(state, target)
    return own is not None and own == await profile_context(state, profile)


def outside(profile: dict, what: str, target_tab: str | None = None) -> BrowseError:
    which = f"tab [{target_tab}]" if target_tab else "this session's tab"
    return BrowseError(
        f"{which[0].upper()}{which[1:]} isn't in the crawler profile {profile.get('name')}, so it won't {what} with --profile; "
        f"open one there first: ardia browse --profile {profile.get('name')} open <url>",
        code="not_in_profile",
    )


async def require(ctx, target: str | None, what: str) -> None:
    profile = active(ctx)
    state = ctx.state
    if profile is not None and not await member(state, profile, target):
        raise outside(profile, what, state.tab_id(target) if target and hasattr(state, "tab_id") else None)


async def guard(ctx, name: str) -> None:
    profile = active(ctx)
    if profile is None or name in CHECKS_ITS_OWN_TABS:
        return
    if name in REFUSED:
        raise BrowseError(f"`{name}` doesn't run with --profile: {REFUSED[name]}", code="profile_unsupported")
    if not await member(ctx.state, profile, ctx.state.current):
        raise outside(profile, f"run `{name}`")


def refuse_unprofiled_tab(profile: dict | None, what: str) -> None:
    if profile is not None:
        raise BrowseError(f"With --profile, {what} can't be opened outside the crawler profile {profile.get('name')}; "
                          f"only `open <url>` and `tab new <url>` open tabs there", code="profile_unsupported")


async def call(state, method: str, params: dict | None = None):
    from ardia_cli import control

    try:
        connection = await control.connect(control_path(state), CALL_TIMEOUT, state.caller)
    except control.Unreachable as error:
        raise BrowseError(f"--profile needs Ardia's control socket: {error}", code="crawler_unreachable") from None
    try:
        return await connection.call(method, params, CALL_TIMEOUT)
    except control.MethodError as error:
        raise BrowseError(f"Ardia refused to open the tab: {error.message}", code=f"crawler_{error.code}") from None
    except control.Unreachable as error:
        raise BrowseError(f"Ardia's control socket dropped while opening the tab ({error}); it may have opened", code="outcome_unknown") from None
    finally:
        await connection.close()


async def apply(state, op: dict) -> dict:
    reply = await call(state, "apply", {"ops": [op]})
    if not isinstance(reply, dict) or not reply.get("ok"):
        error = reply.get("error") if isinstance(reply, dict) else None
        message = error.get("message") if isinstance(error, dict) else "it failed"
        raise BrowseError(f"Ardia didn't open the tab: {message}", code="crawler_refused")
    return reply


async def target_of(state, app_tab: str, timeout: float) -> str:
    loop = asyncio.get_running_loop()
    started = loop.time()
    woken = False
    while True:
        rows = app_tab_rows(await call(state, "windows"))
        row = next((row for row in rows if row.get("id") == app_tab), None)
        if row is None:
            raise BrowseError(f"Ardia opened {app_tab} but no longer lists it; a tab.opening rule or the crawler profile closed it", code="tab_gone")
        if "targetId" not in row:
            raise BrowseError("This Ardia doesn't say which page belongs to a tab (an update adds it), so --profile can't attach", code="crawler_unknown")
        target = row.get("targetId")
        if isinstance(target, str):
            await state.refresh_targets()
            if target in state.target_infos:
                return target
        elapsed = loop.time() - started
        if not woken and elapsed >= WAKE_AFTER:
            await apply(state, {"op": "tab.wake", "tabs": [app_tab]})
            woken = True
        if elapsed >= timeout:
            raise BrowseError(f"Ardia opened {app_tab} in the crawler profile but its page didn't load in {timeout:g} s", code="timeout")
        await asyncio.sleep(0.1)


async def settled(page, url: str | None, timeout: float) -> None:
    from ardia_cli.browse.state import wait_until

    async def loaded():
        try:
            href, ready = await page.call("() => [location.href, document.readyState]", frame=page.main_frame, read=True)
        except BrowseError:
            return False
        return ready == "complete" and (url is None or href != "about:blank")

    await wait_until(loaded, timeout, 0.1, "the crawler profile's tab to load")
    await page.refresh_frames()


async def open_tab(ctx, url: str | None, label: str | None):
    from ardia_cli.browse.commands import apply_open_options

    state = ctx.state
    profile = active(ctx)
    if profile is None:
        raise BrowseError("open_tab needs --profile")
    await state.connect()
    if label and label in state.labels:
        raise BrowseError(f"The label {label} is already used by another tab")
    reply = await apply(state, {"op": "open", "urls": [url or "about:blank"], "profile": profile["id"]})
    results = reply.get("results") or [{}]
    app_tab = (results[0].get("tabs") or [None])[0]
    if not isinstance(app_tab, str):
        raise BrowseError("Ardia opened the tab but didn't say which one", code="crawler_refused")
    target = await target_of(state, app_tab, ctx.timeout)
    state.opened.add(target)
    state.registry.note_opened(state.instance, target)
    state.tab_id(target)
    state.app_tabs[target] = app_tab
    profile_tabs(state)[target] = profile["engine"]
    if context_of(state, target):
        contexts(state).setdefault(profile["engine"], context_of(state, target))
    if label:
        state.labels[label] = target
    state.current = target
    if state.pin_tab:
        state.extras["pinned_target"] = target
    page = await state.page(target)
    await apply_open_options(ctx, page)
    await settled(page, url, ctx.timeout)
    return page
