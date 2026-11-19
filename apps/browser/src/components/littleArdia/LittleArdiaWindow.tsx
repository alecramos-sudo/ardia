import { Button, ContextMenuArea, PinchArea, pinchShrink, pinchSettle, reduceMotion, useHover, WindowBackdrop, WindowDragRegion, type PinchMotion, type SwipeEvent } from "../ui";
import { setTrafficLightsCenter } from "../../state/windows/nativeWindow";
import { useEffect, useMemo, useRef, useState } from "react";
import { Animated, StyleSheet, View } from "react-native";
import { useTheme } from "../ui/theme";
import { openPanel } from "../../state/windows/actions";
import { useActiveTab, useSettings, useWindowFullScreen, useWindowId, useWindowProfile, useWindowUi } from "../../state/browser/hooks";
import type { Tab } from "../../state/browser/types";
import { CommandPanel } from "../omnibox/CommandPanel";
import { ContentCard } from "../window/ContentCard";
import { BrowserWindowControls } from "../window/BrowserWindowControls";
import { DownloadsPopover } from "../downloads/Downloads";
import { ExtensionOverlays } from "../extensions/ExtensionOverlays";
import { ToolbarPopupAnchor } from "../extensions/ToolbarExtensions";
import { setUrlAnchor, usePageFrameInset } from "../../state/windows/layout";
import { showUrlBarMenu } from "../../state/omnibox/paste";
import { ProfileBadge } from "../profiles/ProfileIcons";
import { useProfileDotsShown } from "../profiles/ProfileDots";
import { closeLittleArdia, openInMainWindow, openLittleArdiaProfileMenu } from "../../state/littleArdia/actions";
import { isWindowClosing } from "../../state/windows/closeAnimated";
import { noteLittleArdiaPinch, noteSwipeClose } from "../../state/telemetry/usage";
import { pageOf } from "../../state/tabs/pageState";
import { SwipeCloseContext } from "../window/swipeClose";
import { startLittleArdiaNewTabLinks } from "../../state/littleArdia/newTabLinks";
import { PageLabel, SMALL_BAR_BUTTON, SmallBar } from "./SmallChrome";
import { SMALL_LIGHTS_CENTER } from "../../state/windows/small";
import { littleArdiaBarLayout } from "./barLayout";
import { HistoryButton } from "../toolbar/NavButtons";
import { useCopyLink } from "../toolbar/useCopyLink";
import { toolbarPalette } from "../ui/toolbarColors";
import { useHistoryAvailability } from "../../state/tabs/navigation";
import { LITTLE_ARDIA_PINCH, LITTLE_ARDIA_SWIPE_CLOSE, SMALL_FIELD_MAX_WIDTH, smallBarRow } from "./tokens";
import { perLook } from "../ui/tokens";
import { keyText } from "../../state/commands/keyText";
import { toggleDeviceMode } from "../../state/deviceMode/deviceMode";
import { useShowsAsIphone } from "../../state/deviceMode/hooks";

const BAR = littleArdiaBarLayout();
const NAV_HIT = perLook(() => ({ width: SMALL_BAR_BUTTON, height: SMALL_BAR_BUTTON, plateX: 0, plateY: 0, box: smallBarRow().button, radius: smallBarRow().buttonRadius }));
const BACK_AT = perLook(() => ({ style: { position: "absolute" as const, top: BAR.buttonTop, left: BAR.navLeft }, hit: NAV_HIT() }));
const FORWARD_AT = perLook(() => ({ style: { position: "absolute" as const, top: BAR.buttonTop, left: BAR.navLeft + BAR.navPitch }, hit: NAV_HIT() }));
const alreadyFocused = () => {};

export function LittleArdiaWindow() {
  const theme = useTheme();
  const windowId = useWindowId();
  const fullScreen = useWindowFullScreen(windowId);
  const [size, setSize] = useState({ width: 0, height: 0 });
  const frame = usePageFrameInset();
  const gestures = !fullScreen;
  const tabId = useActiveTab()?.id;
  const pinch = useLittleArdiaPinch(windowId, tabId);
  const swipe = useLittleArdiaSwipeClose(windowId);
  useEffect(startLittleArdiaNewTabLinks, []);
  return (
    <View
      style={{ flex: 1 }}
      onLayout={(e) => {
        const { width, height } = e.nativeEvent.layout;
        setSize((prev) => (prev.width === width && prev.height === height ? prev : { width, height }));
      }}
    >
      <Animated.View style={{ ...StyleSheet.absoluteFillObject, opacity: swipe.opacity, transform: [{ translateX: swipe.x }] }}>
        <WindowBackdrop vibrancy {...theme.backdrop} colors={theme.windowTint} grainOpacity={theme.grain} style={StyleSheet.absoluteFill} />
        <PinchArea enabled={gestures} passesThrough motion={pinch.motion} style={StyleSheet.absoluteFill}>
          <Animated.View style={{ flex: 1, transform: [{ scale: pinch.scale }] }}>
            <SwipeCloseContext.Provider value={gestures ? swipe.onSwipe : null}>
              <View style={{ flex: 1, flexDirection: "row", paddingTop: BAR.height, paddingLeft: frame, paddingRight: frame, paddingBottom: frame }}>
                <ContentCard />
              </View>
            </SwipeCloseContext.Provider>
            <View style={{ position: "absolute", left: 0, right: 0, top: 0 }}>
              <LittleArdiaBar />
            </View>
          </Animated.View>
        </PinchArea>
      </Animated.View>
      <CommandPanel windowWidth={size.width} />
      <DownloadsPopover />
      <ExtensionOverlays />
      <BrowserWindowControls />
    </View>
  );
}

function useLittleArdiaPinch(windowId: string, tabId: string | undefined) {
  const [scale] = useState(() => new Animated.Value(1));
  const leaving = useRef(false);
  const settle = () => pinchSettle([{ value: scale, to: 1 }]);
  const motion: PinchMotion = {
    get reduce() {
      return reduceMotion() === true;
    },
    accepts: () => {
      const atNormalZoom = pageOf(tabId).pinchScale <= 1;
      if (!atNormalZoom) noteLittleArdiaPinch("pageZoom");
      return atNormalZoom;
    },
    idle: () => leaving.current || isWindowClosing(windowId),
    begin: () => scale.stopAnimation(),
    yieldsAfterSpread: LITTLE_ARDIA_PINCH.pageZoomFrom,
    yielded: () => noteLittleArdiaPinch("pageZoom"),
    follow: (magnification) => scale.setValue(pinchShrink(magnification, LITTLE_ARDIA_PINCH.smallest)),
    settle,
    close: () => {
      noteLittleArdiaPinch("close");
      leaving.current = true;
      closeLittleArdia(windowId);
      if (isWindowClosing(windowId)) return;
      leaving.current = false;
      settle();
    },
  };
  return { scale, motion };
}

function useLittleArdiaSwipeClose(windowId: string) {
  const [x] = useState(() => new Animated.Value(0));
  const opacity = useMemo(() => x.interpolate({ inputRange: [0, LITTLE_ARDIA_SWIPE_CLOSE.fadeOver], outputRange: [1, 0], extrapolate: "clamp" }), [x]);
  const settle = () => pinchSettle([{ value: x, to: 0 }]);
  const close = () => {
    noteSwipeClose(true);
    if (reduceMotion() === true) return closeLittleArdia(windowId);
    Animated.timing(x, { toValue: LITTLE_ARDIA_SWIPE_CLOSE.fadeOver, duration: LITTLE_ARDIA_SWIPE_CLOSE.leaveMs, useNativeDriver: true }).start(() => {
      closeLittleArdia(windowId);
      if (!isWindowClosing(windowId)) x.setValue(0);
    });
  };
  const onSwipe = (e: SwipeEvent) => {
    if (isWindowClosing(windowId)) return;
    if (e.phase === "swipe") return close();
    if (e.phase === "began") return x.stopAnimation();
    if (e.phase === "changed") return x.setValue(Math.max(0, e.distance));
    if (e.phase === "ended" && (e.distance >= LITTLE_ARDIA_SWIPE_CLOSE.distance || (e.distance > 0 && e.velocity >= LITTLE_ARDIA_SWIPE_CLOSE.velocity))) return close();
    if (e.phase === "ended" || e.phase === "cancelled") {
      noteSwipeClose(false);
      settle();
    }
  };
  return { x, opacity, onSwipe };
}

function LittleArdiaBar() {
  const windowId = useWindowId();
  const tab = useActiveTab();
  const panelOpen = useWindowUi().panel.open;
  const switcherShown = useProfileDotsShown();
  const { copied, copy } = useCopyLink(tab?.id, tab?.url);
  const iphone = useShowsAsIphone(windowId);
  useEffect(() => {
    void setTrafficLightsCenter(windowId, SMALL_LIGHTS_CENTER);
  }, [windowId]);

  return (
    <SmallBar
      height={BAR.height}
      trailingRoom={BAR.trailingRoom}
      fieldLeft={BAR.fieldLeft}
      field={tab ? <PageField tab={tab} windowId={windowId} hidden={panelOpen} /> : null}
      buttons={[
        { icon: copied ? "checkmark" : "link", disabled: !tab?.url, tooltip: `Copy Link (${keyText("⇧⌘C")})`, onPress: copy },
        iphone ? { icon: "desktopcomputer", tooltip: "Show as Desktop", onPress: () => toggleDeviceMode(windowId) } : { icon: "iphone", tooltip: "Show as iPhone", onPress: () => toggleDeviceMode(windowId) },
        { icon: "arrow.up.left.and.arrow.down.right", tooltip: `Open in Ardia (${keyText("⌘O")})`, onPress: () => openInMainWindow(windowId) },
      ]}
      trailing={switcherShown ? <ProfileButton windowId={windowId} /> : undefined}
    >
      <WindowDragRegion style={StyleSheet.absoluteFill} />
      {tab ? <HistoryButtons tabId={tab.id} windowId={windowId} /> : null}
      {tab ? <ToolbarPopupAnchor windowId={windowId} tabId={tab.id} top={BAR.buttonTop} right={BAR.controlsRight} /> : null}
    </SmallBar>
  );
}

function HistoryButtons({ tabId, windowId }: { tabId: string; windowId: string }) {
  const palette = toolbarPalette(useTheme(), null);
  const history = useHistoryAvailability(tabId);
  return (
    <>
      <HistoryButton place={BACK_AT()} tabId={tabId} windowId={windowId} direction={-1} disabled={!history.back} palette={palette} onFocus={alreadyFocused} />
      <HistoryButton place={FORWARD_AT()} tabId={tabId} windowId={windowId} direction={1} disabled={!history.forward} palette={palette} onFocus={alreadyFocused} />
    </>
  );
}

function ProfileButton({ windowId }: { windowId: string }) {
  const profile = useWindowProfile();
  const iconsShown = useSettings((s) => s.profileSwitcherIcons);
  return (
    <Button variant="icon" look="row" tooltip={`Profile: ${profile.name}`} onPress={() => void openLittleArdiaProfileMenu(windowId)}>
      <ProfileBadge profile={iconsShown ? profile : { ...profile, icon: null }} size={16} />
    </Button>
  );
}

function PageField({ tab, windowId, hidden }: { tab: Tab; windowId: string; hidden: boolean }) {
  const { hovered, hoverProps } = useHover();
  const field = useRef<View>(null);
  const anchor = () =>
    field.current?.measureInWindow((x, y, width, height) => {
      if (width) setUrlAnchor(windowId, { left: x, top: y, width, sidebar: { height } });
    });

  return (
    <View ref={field} onLayout={anchor} {...hoverProps} style={{ flex: 1, opacity: hidden ? 0 : 1 }}>
      <ContextMenuArea style={{ flex: 1 }} onContextMenu={() => tab.url && void showUrlBarMenu(tab)}>
        <WindowDragRegion
          clickable
          accessibilityRole="button"
          onRegionClick={() => openPanel(windowId, tab.url)}
          style={{ flex: 1 }}
        >
          <PageLabel tab={tab} hovered={hovered} />
        </WindowDragRegion>
      </ContextMenuArea>
    </View>
  );
}
