import { useCallback, useRef, useState } from "react";
import { Animated, Pressable, View } from "react-native";
import { useShallow } from "zustand/react/shallow";
import { switchProfile } from "../../state/browser/actions";
import { noteSwitcherPress } from "../../state/telemetry/switcherPresses";
import { layout, useTheme } from "../ui/theme";
import { useIsIncognito, useProfile, useSettings, useWindow } from "../../state/browser/hooks";
import { useProfileOrder, useProfileRecords } from "../../state/profiles/hooks";
import { useIsCrawlerProfile } from "../../state/crawler/hooks";
import { useNativePagerPosition, usePagerPages, type PagerPage } from "../../state/windows/profilePager";
import { ContextMenuArea, useHover } from "../ui";
import { TooltipAbove } from "../ui/TooltipAbove";
import { useDropProfile, useDropRegion } from "../sidebar/DragProvider";
import { profileRegion } from "../sidebar/dragModel";
import { SIDEBAR_FOOTER_DOWNLOADS } from "../sidebar/geometry";
import { switcherCellWidth, switcherIcons, SwitcherMark } from "./ProfileIcons";
import { openProfileItemMenu } from "./profileMenu";
import { profileSwitcherShown } from "../../state/profiles/switcherShown";
import { profileSwitcher } from "./tokens";
import { buttonMotion, usePressScaleMotion } from "../ui/motion";

export const PROFILE_DOTS_HEIGHT = profileSwitcher.height;
const { band: BAND, dotTooltipLift, dropScale } = profileSwitcher;
const SIDE_ROOM = layout.sidebarInset;
const SIDE_ROOM_BESIDE_DOWNLOADS = SIDEBAR_FOOTER_DOWNLOADS.left + SIDEBAR_FOOTER_DOWNLOADS.size + 4;

export function useProfileDotsShown() {
  const incognito = useIsIncognito();
  const count = useProfileOrder((o) => o.length);
  const enabled = useSettings((s) => s.showProfileDots);
  return profileSwitcherShown({ showProfileDots: enabled }, count, incognito);
}

export function ProfileDots({ windowId, width, besideDownloads }: { windowId: string; width: number; besideDownloads: boolean }) {
  const ids = useProfileOrder(useShallow((o) => o));
  const saved = useProfileRecords(useShallow((profiles) => ids.map((id) => profiles[id]?.icon ?? null)));
  const shown = useSettings((s) => s.profileSwitcherIcons);
  const icons = switcherIcons(saved, shown, width - 2 * (besideDownloads ? SIDE_ROOM_BESIDE_DOWNLOADS : SIDE_ROOM));
  const { pages, pager } = usePagerPages(windowId);
  return (
    <View style={{ height: PROFILE_DOTS_HEIGHT, alignItems: "center" }}>
      <View style={{ marginTop: (PROFILE_DOTS_HEIGHT - 3 - BAND) / 2, height: BAND, flexDirection: "row" }}>
        {ids.map((id, i) => (
          <Dot key={id} id={id} windowId={windowId} icon={icons[i] ?? null} page={pages.find((p) => p.id === id)} pos={pager.pos} />
        ))}
      </View>
    </View>
  );
}

function Dot({ id, windowId, icon, page, pos }: { id: string; windowId: string; icon: string | null; page: PagerPage | undefined; pos: Animated.Value }) {
  const theme = useTheme();
  useNativePagerPosition(windowId);
  const profileName = useProfile(id, (p) => p?.name ?? "");
  const name = useIsCrawlerProfile(id) ? `${profileName} · Crawler` : profileName;
  const { hovered, hoverProps } = useHover();
  const pressMotion = usePressScaleMotion(true, buttonMotion.iconPressScale);
  const [pressed, setPressed] = useState(false);
  if (pressed && !hovered) setPressed(false);
  const levels = icon ? profileSwitcher.icons : profileSwitcher.dots;
  const current = useWindow(windowId, (w) => w?.profileId === id);
  const dropRegion = useDropRegion(current ? null : profileRegion(id));
  const dropTarget = useDropProfile(id);
  const rest = hovered ? levels.hovered : levels.idle;
  const opacity = dropTarget
    ? levels.selected
    : page
      ? pos.interpolate({ inputRange: [page.slot - 1, page.slot, page.slot + 1], outputRange: [rest, levels.selected, rest], extrapolate: "clamp" })
      : rest;
  const cell = switcherCellWidth(icon);
  const mark = useRef<View | null>(null);
  const markRef = useCallback(
    (view: View | null) => {
      mark.current = view;
      dropRegion(view);
    },
    [dropRegion],
  );
  return (
    <View {...hoverProps} ref={markRef}>
      <TooltipAbove text={name} active={dropTarget || (hovered && !pressed)} immediate={dropTarget} centerX={cell / 2} bottom={BAND / 2 + dotTooltipLift} />
      <ContextMenuArea onContextMenu={() => void openProfileItemMenu(id, "sidebar", windowId, mark.current)}>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={name}
          onPressIn={pressMotion.onPressIn}
          onPressOut={pressMotion.onPressOut}
          onPress={() => {
            setPressed(true);
            noteSwitcherPress(windowId, id, !!icon);
            switchProfile(windowId, id, true);
          }}
        >
          <View style={{ width: cell, height: BAND, alignItems: "center", justifyContent: "center" }}>
            <Animated.View style={[{ opacity }, dropTarget ? { transform: [{ scale: dropScale }] } : pressMotion.scale ? { transform: [{ scale: pressMotion.scale }] } : null]}>
              <SwitcherMark icon={icon} color={theme.mark} />
            </Animated.View>
          </View>
        </Pressable>
      </ContextMenuArea>
    </View>
  );
}
