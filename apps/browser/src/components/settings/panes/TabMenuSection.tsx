import { useSettings } from "../../../state/browser/hooks";
import { updateSettings } from "../../../state/settings/actions";
import { closeSettingsSheet, showSettingsSheet } from "../../../state/settings/sheet";
import { DEFAULT_TAB_MENU_SHOWN, TAB_MENU_PLACES, withTabMenuPlace } from "../../../state/sidebar/tabMenuLayout";
import { Box, Button, Checkbox, DialogActions, DialogTitle, Sheet, space } from "../../ui";
import { Group, Row, SectionHeader } from "../Form";

const HALF = Math.ceil(TAB_MENU_PLACES.length / 2);
const COLUMNS = [TAB_MENU_PLACES.slice(0, HALF), TAB_MENU_PLACES.slice(HALF)];

export function TabMenuSection() {
  return (
    <>
      <SectionHeader title="Tab menu" />
      <Group>
        <Row anchor="tabs.tabMenu">
          <Button title="Customize…" onPress={() => showSettingsSheet(<TabMenuSheet />)} />
        </Row>
      </Group>
    </>
  );
}

function TabMenuSheet() {
  const shown = useSettings((s) => s.tabMenuShown);
  return (
    <Sheet size="m" onClose={closeSettingsSheet}>
      <DialogTitle subtitle="Ticked commands show when you right-click a tab. The rest are under More. A command appears only on tabs it applies to.">Tab Menu</DialogTitle>
      <Box row gap="xl" style={COLUMNS_ROW}>
        {COLUMNS.map((places, column) => (
          <Box key={column} gap="m" style={COLUMN}>
            {places.map((place) => (
              <Checkbox key={place.id} value={shown.includes(place.id)} label={place.title} onChange={(on) => updateSettings({ tabMenuShown: withTabMenuPlace(shown, place.id, on) })} />
            ))}
          </Box>
        ))}
      </Box>
      <DialogActions>
        <Button title="Restore Defaults" onPress={() => updateSettings({ tabMenuShown: [...DEFAULT_TAB_MENU_SHOWN] })} />
        <Button title="Done" kind="primary" onPress={closeSettingsSheet} />
      </DialogActions>
    </Sheet>
  );
}

const COLUMNS_ROW = { marginTop: space.l } as const;
const COLUMN = { flex: 1 } as const;
