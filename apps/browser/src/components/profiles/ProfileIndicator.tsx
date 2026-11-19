import { useRef } from "react";
import { Pressable, View } from "react-native";
import { profileNameColor, useTheme } from "../ui/theme";
import { useIsIncognito, useProfiles, useWindowId, useWindowProfile, useWindowProfileId } from "../../state/browser/hooks";
import { useIsCrawlerProfile } from "../../state/crawler/hooks";
import { setMeasuredWidth, useMeasuredWidth } from "../../state/windows/measuredWidths";
import { Badge, ContextMenuArea, radius, space, Symbol, Text, useHover } from "../ui";
import { openProfileItemMenu } from "./profileMenu";
import { openProfileMenu } from "../../state/browser/actions";

const PAD = 9;
const HEIGHT = 34;
const MIN_CUT_NAME = 52;
const ICON_WIDTH = 32;
export const PROFILE_INDICATOR_X = 84;

function useIndicator(room: number) {
  const theme = useTheme();
  const incognito = useIsIncognito();
  const profiles = useProfiles();
  const profile = useWindowProfile();
  const title = incognito ? "Incognito" : profile.name;
  const crawler = useIsCrawlerProfile(useWindowProfileId());
  const measureKey = `profile-name|${title}`;
  const nameWidth = useMeasuredWidth(measureKey);
  const chipWidth = useMeasuredWidth(CRAWLER_CHIP_KEY);
  const shown = (incognito || profiles.length >= 2) && room >= ICON_WIDTH;
  const nameRoom = room - 2 * PAD;
  const crawlerMark: CrawlerMark = !crawler ? null : nameWidth && chipWidth && nameWidth + chipWidth <= nameRoom ? "chip" : "icon";
  const markWidth = crawlerMark === "chip" ? (chipWidth ?? 0) : crawlerMark === "icon" ? CRAWLER_ICON_WIDTH : 0;
  const textWidth = nameWidth && (!crawler || chipWidth) ? nameWidth + markWidth : 0;
  const showName = !!textWidth && (textWidth <= nameRoom || nameRoom >= MIN_CUT_NAME);
  const width = !shown ? 0 : showName ? Math.min(room, textWidth + 2 * PAD) : ICON_WIDTH;
  const color = incognito ? theme.textPrimary : profileNameColor(profile, theme.dark);
  return { incognito, title, crawler, crawlerMark, measureKey, textWidth, shown, showName, width, color, profileId: profile.id };
}

export const useProfileIndicatorWidth = (room: number) => useIndicator(room).width;

export function ProfileIndicator({ room }: { room: number }) {
  const theme = useTheme();
  const windowId = useWindowId();
  const { hovered, hoverProps } = useHover();
  const { incognito, title, crawler, crawlerMark, measureKey, textWidth, shown, showName, width, color, profileId } = useIndicator(room);
  const indicator = useRef<View>(null);
  if (!shown) return null;

  return (
    <View {...hoverProps} ref={indicator} tooltip={incognito ? undefined : "Switch between profiles"}>
      <View pointerEvents="none" style={{ position: "absolute", width: 1000, height: 0, overflow: "hidden", opacity: 0 }}>
        <Text numberOfLines={1} weight="semibold" style={{ alignSelf: "flex-start" }} onLayout={(e) => setMeasuredWidth(measureKey, Math.ceil(e.nativeEvent.layout.width))}>
          {title}
        </Text>
        {crawler ? (
          <View style={MEASURED_CHIP} onLayout={(e) => setMeasuredWidth(CRAWLER_CHIP_KEY, Math.ceil(e.nativeEvent.layout.width))}>
            <CrawlerChip />
          </View>
        ) : null}
      </View>
      <ContextMenuArea onContextMenu={() => !incognito && void openProfileItemMenu(profileId, "sidebar", windowId, indicator.current)}>
        <Pressable onPress={() => !incognito && void openProfileMenu(windowId)} disabled={incognito}>
          {({ pressed }) => (
            <View
              style={{
                height: HEIGHT,
                width,
                borderRadius: radius.chrome,
                flexDirection: "row",
                alignItems: "center",
                justifyContent: "center",
                paddingHorizontal: showName ? PAD : 0,
                backgroundColor: incognito ? undefined : pressed ? theme.tabPressed : hovered ? theme.tabHover : undefined,
              }}
            >
              {showName ? (
                <>
                  <Text numberOfLines={1} ellipsizeMode="tail" weight="semibold" style={{ flexShrink: 1, color }}>
                    {title}
                  </Text>
                  {crawlerMark === "chip" ? <CrawlerChip /> : crawlerMark === "icon" ? <CrawlerIcon color={color} /> : null}
                </>
              ) : textWidth ? (
                <Symbol name={crawler ? "ant" : "person.fill"} size={14} weight="semibold" color={color} style={{ width: 16, height: 16 }} />
              ) : null}
            </View>
          )}
        </Pressable>
      </ContextMenuArea>
    </View>
  );
}

type CrawlerMark = "chip" | "icon" | null;

const CRAWLER_CHIP_KEY = "profile-crawler-chip";
const CRAWLER_ICON_SIZE = 16;
const CRAWLER_ICON_WIDTH = CRAWLER_ICON_SIZE + space.xs;

const CrawlerChip = () => <Badge text="Crawler" tone="chip" size="s" style={CRAWLER_MARK} />;

const CrawlerIcon = ({ color }: { color: string }) => (
  <View tooltip="Crawler profile" style={CRAWLER_MARK}>
    <Symbol name="ant" size={12} weight="semibold" color={color} style={{ width: CRAWLER_ICON_SIZE, height: CRAWLER_ICON_SIZE }} />
  </View>
);

const MEASURED_CHIP = { alignSelf: "flex-start", flexDirection: "row" } as const;
const CRAWLER_MARK = { marginLeft: space.xs, flexShrink: 0 } as const;
