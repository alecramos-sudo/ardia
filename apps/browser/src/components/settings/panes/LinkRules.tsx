import { useState } from "react";
import { Button, DialogActions, DialogTitle, PopUp, Sheet, space, Text, TextField } from "../../ui";
import { useProfiles, useSettings } from "../../../state/browser/hooks";
import { currentSettings } from "../../../state/browser/current";
import { addLinkRule, moveLinkRule, removeLinkRule, updateLinkRule } from "../../../state/links/linkRouting";
import type { LinkOpen, LinkRule } from "../../../state/links/linkRules";
import { closeSettingsSheet, showSettingsSheet } from "../../../state/settings/sheet";
import { Favicon } from "../../favicon/Favicon";
import { FormField, Group, ProfilePicker, Row, SectionHeader } from "../Form";

type OpenChoice = LinkOpen | "default";

const OPEN_TITLES: Record<OpenChoice, string> = {
  default: "As links from other apps do",
  littleArdia: "Little Ardia",
  tab: "A tab in the profile's window",
  window: "A new window",
};
const OPEN_OPTIONS = (Object.keys(OPEN_TITLES) as OpenChoice[]).map((value) => ({ value, title: OPEN_TITLES[value] }));

const faviconOf = (site: string) => (site.includes("://") ? site.replace(/\*\.?/g, "") : `https://${site.replace(/^\*\./, "").replace(/\/.*$/, "")}`);

export function LinkRulesSection() {
  const rules = useSettings((s) => s.linkRules);
  return (
    <>
      <SectionHeader anchor="general.linkRules" action={<Button title="Add…" icon="plus" onPress={() => showSettingsSheet(<LinkRuleSheet />)} />} />
      <Group of="general.linkRules">
        {rules.length === 0 ? (
          <Row title="No link rules" description="Add one to send a site, like github.com, to the profile you use it in." />
        ) : (
          rules.map((rule, i) => <LinkRuleRow key={rule.id} rule={rule} first={i === 0} last={i === rules.length - 1} />)
        )}
      </Group>
    </>
  );
}

function LinkRuleRow({ rule, first, last }: { rule: LinkRule; first: boolean; last: boolean }) {
  const profile = useProfiles().find((p) => p.id === rule.profileId);
  const where = rule.open ? ` · ${OPEN_TITLES[rule.open]}` : "";
  const from = rule.app ? ` · from ${rule.app}` : "";
  const description = profile ? `Opens in ${profile.name}${where}${from}` : "Its profile was removed, so this rule is skipped";
  return (
    <Row icon={<Favicon url={faviconOf(rule.site)} />} title={rule.site} description={description}>
      <Button variant="icon" icon="chevron.up" size="m" disabled={first} onPress={() => moveLinkRule(rule.id, -1)} tooltip="Check this rule earlier" />
      <Button variant="icon" icon="chevron.down" size="m" disabled={last} onPress={() => moveLinkRule(rule.id, 1)} tooltip="Check this rule later" />
      <Button variant="icon" icon="pencil" size="m" onPress={() => showSettingsSheet(<LinkRuleSheet rule={rule} />)} tooltip="Edit" />
    </Row>
  );
}

function LinkRuleSheet({ rule }: { rule?: LinkRule }) {
  const profiles = useProfiles();
  const [site, setSite] = useState(rule?.site ?? "");
  const [app, setApp] = useState(rule?.app ?? "");
  const [profileId, setProfileId] = useState(rule && profiles.some((p) => p.id === rule.profileId) ? rule.profileId : currentSettings().defaultProfileId);
  const [open, setOpen] = useState<OpenChoice>(rule?.open ?? "default");
  const [error, setError] = useState<string | null>(null);
  const save = () => {
    const input = { site, app, profileId, open: open === "default" ? null : open };
    const problem = rule ? updateLinkRule(rule.id, input) : addLinkRule(input);
    if (problem) return setError(problem);
    closeSettingsSheet();
  };
  return (
    <Sheet onClose={closeSettingsSheet}>
      <DialogTitle>{rule ? "Edit Link Rule" : "Add Link Rule"}</DialogTitle>
      <FormField label="Site (github.com, *.example.com, or a pattern like https://example.com/team/*)">
        <TextField value={site} onChangeText={setSite} placeholder="github.com" onSubmit={save} onEscape={closeSettingsSheet} />
      </FormField>
      <FormField label="Only links from this app (name or bundle ID, optional)">
        <TextField value={app} onChangeText={setApp} placeholder="Any app" onSubmit={save} onEscape={closeSettingsSheet} />
      </FormField>
      {profiles.length > 1 && (
        <FormField label="Open in profile" inline>
          <ProfilePicker value={profileId} onChange={setProfileId} />
        </FormField>
      )}
      <FormField label="Open as" inline>
        <PopUp value={open} options={OPEN_OPTIONS} onChange={setOpen} minWidth={220} />
      </FormField>
      {error && (
        <Text size="caption" tone="destructive" style={ERROR}>
          {error}
        </Text>
      )}
      <DialogActions
        leading={
          rule ? (
            <Button
              title="Delete"
              kind="destructive"
              onPress={() => {
                removeLinkRule(rule.id);
                closeSettingsSheet();
              }}
            />
          ) : null
        }
      >
        <Button title="Cancel" onPress={closeSettingsSheet} />
        <Button title={rule ? "Save" : "Add"} kind="primary" onPress={save} />
      </DialogActions>
    </Sheet>
  );
}

const ERROR = { marginTop: space.ml } as const;
