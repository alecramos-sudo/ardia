import { useState } from "react";
import { View } from "react-native";
import { Button, DialogActions, DialogTitle, Sheet, space, Text, TextField, Toggle } from "../../ui";
import { useProfile, useProfiles } from "../../../state/browser/hooks";
import { confirm, openExternalURL } from "../../../state/app/system";
import { crawlerNotReadyText, crawlerSignatureStatus, DEFAULT_CRAWLER_HEADER, signatureDomain, type CrawlerProfile, type CrawlerShopifySignature } from "../../../state/crawler/crawler";
import { addCrawlerShopifySignature, clearCrawlerData, createCrawlerProfile, DEFAULT_CRAWLER_PROFILE_NAME, removeCrawlerSignature, setCrawlerHeaderValue, setCrawlerProfile } from "../../../state/crawler/actions";
import { useCrawlerInstanceMode, useCrawlerProfile, useIsCrawlerProfile, useIsOriginalProfile, useSharesProfileData } from "../../../state/crawler/hooks";
import { closeSettingsSheet, showSettingsSheet } from "../../../state/settings/sheet";
import { goToSettingsPane } from "../../../state/settings/settingsWindows";
import { ProfileBadge } from "../../profiles/ProfileIcons";
import { FormField, Group, Row, SectionHeader } from "../Form";

const SHOPIFY_CRAWLER_HELP = "https://help.shopify.com/en/manual/promoting-marketing/seo/crawling-your-store";

const problemOf = (write: Promise<string | null>) => write.catch((e: Error) => e.message);

const crawlerStatus = (profile: CrawlerProfile | undefined) =>
  profile?.ready ? "Ready" : !profile?.reason && profile?.detail === "not loaded" ? "Starts when the profile opens" : crawlerNotReadyText(profile?.reason ?? null);

const SWITCH_ON_MESSAGE =
  "It blocks analytics and tracking requests and labels its requests, so QA agents' visits don't count in a site's analytics. Turning it on closes the profile's tabs and clears its cookies, site storage and cache, and clears them again at every launch. Its Shopify signatures stay in the keychain.";

function useCrawlerSwitch(profileId: string) {
  const name = useProfile(profileId, (p) => p?.name ?? "");
  const on = useIsCrawlerProfile(profileId);
  const instance = useCrawlerInstanceMode();
  const shares = useSharesProfileData(profileId);
  const original = useIsOriginalProfile(profileId);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const change = async (enabled: boolean) => {
    setError(null);
    if (enabled) {
      const { confirmed } = await confirm({ title: `Make ${name} a crawler profile?`, message: SWITCH_ON_MESSAGE, confirmTitle: "Turn On", destructive: true });
      if (!confirmed) return;
    }
    setBusy(true);
    setError(await problemOf(setCrawlerProfile(profileId, enabled)));
    setBusy(false);
  };
  const locked = busy || instance || (!on && (shares || original));
  const note = instance
    ? "Every profile in this test instance is a crawler profile."
    : !on && original
      ? "Not for the original profile: it loads before crawler mode can clear it."
      : !on && shares
        ? "Only for a profile with its own data."
        : null;
  return { on, locked, note, error, change };
}

export function CrawlerProfilesSection() {
  const profiles = useProfiles();
  const instance = useCrawlerInstanceMode();
  return (
    <>
      <SectionHeader
        title="Crawler profiles"
        description={instance ? "Every profile in this test instance is a crawler profile." : undefined}
        action={instance ? undefined : <Button title="New Crawler Profile…" icon="plus" onPress={() => showSettingsSheet(<NewCrawlerProfileSheet />)} />}
      />
      <Group>
        <Row anchor="profiles.crawlerProfile" />
        {profiles.map((p) => (
          <CrawlerProfileRow key={p.id} profileId={p.id} />
        ))}
      </Group>
    </>
  );
}

function CrawlerProfileRow({ profileId }: { profileId: string }) {
  const profile = useProfile(profileId, (p) => p);
  const crawler = useCrawlerProfile(profileId);
  const { on, locked, note, error, change } = useCrawlerSwitch(profileId);
  if (!profile) return null;
  const description = error ?? (on ? crawlerStatus(crawler) : note);
  return (
    <Row icon={<ProfileBadge profile={profile} size={20} />} title={profile.name} description={description ?? undefined} onPress={on ? () => goToSettingsPane("profiles", profileId) : undefined}>
      <Toggle value={on} disabled={locked} accessibilityLabel={`Crawler profile: ${profile.name}`} onChange={(enabled) => void change(enabled)} />
    </Row>
  );
}

function NewCrawlerProfileSheet() {
  const [name, setName] = useState(DEFAULT_CRAWLER_PROFILE_NAME);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const create = async () => {
    if (busy) return;
    setBusy(true);
    setError(null);
    const { profileId, problem } = await createCrawlerProfile(name);
    setBusy(false);
    if (problem || !profileId) return setError(problem ?? "The crawler profile wasn't created.");
    closeSettingsSheet();
    goToSettingsPane("profiles", profileId);
  };
  return (
    <Sheet onClose={closeSettingsSheet}>
      <DialogTitle>New Crawler Profile</DialogTitle>
      <Text size="small" tone="textSecondary" style={NOTE}>
        A new, empty profile that blocks tracking and labels its requests. It has no private windows, and its site data is cleared at every launch.
      </Text>
      <FormField label="Name">
        <TextField value={name} onChangeText={setName} onSubmit={() => void create()} onEscape={closeSettingsSheet} />
      </FormField>
      {error ? (
        <Text size="caption" tone="destructive" style={ERROR}>
          {error}
        </Text>
      ) : null}
      <DialogActions>
        <Button title="Cancel" onPress={closeSettingsSheet} />
        <Button title="Create" kind="primary" disabled={busy} onPress={() => void create()} />
      </DialogActions>
    </Sheet>
  );
}

export function CrawlerProfileDetails({ profileId }: { profileId: string }) {
  const name = useProfile(profileId, (p) => p?.name ?? "");
  const crawler = useCrawlerProfile(profileId);
  const { on, locked, note, error, change } = useCrawlerSwitch(profileId);
  const [header, setHeader] = useState("");
  const [headerError, setHeaderError] = useState<string | null>(null);
  const [clearError, setClearError] = useState<string | null>(null);
  const commitHeader = () => {
    setHeaderError(null);
    void problemOf(setCrawlerHeaderValue(profileId, header)).then(setHeaderError);
  };
  const clear = async () => {
    const { confirmed } = await confirm({
      title: `Clear crawler data for ${name}?`,
      message: "Closes its tabs and removes its cookies, site storage and cache, then checks its tracker blocking again.",
      confirmTitle: "Clear",
      destructive: true,
    });
    if (confirmed) setClearError(await problemOf(clearCrawlerData(profileId)));
  };

  return (
    <>
      <SectionHeader title="Crawler" />
      <Group>
        <Row
          title="Crawler profile"
          description={
            error ??
            note ??
            (on
              ? "Blocks analytics and tracking and labels its requests. No private windows; its site data is cleared at every launch."
              : "Blocks analytics and tracking requests and labels requests, so QA agents' visits don't count in a site's analytics.")
          }
        >
          <Toggle value={on} disabled={locked} accessibilityLabel="Crawler profile" onChange={(enabled) => void change(enabled)} />
        </Row>
        {on ? <Row title="Status" description={crawlerStatus(crawler)} /> : null}
        {on ? (
          <Row title="Request label" description={headerError ?? "Sent as X-Ardia-Crawler on page and frame loads. Leave it empty for the default."}>
            <TextField value={header} onChangeText={setHeader} onSubmit={commitHeader} onBlur={commitHeader} placeholder={DEFAULT_CRAWLER_HEADER} width={220} />
          </Row>
        ) : null}
        {on ? (
          <Row title="Clear Crawler Data" description={clearError ?? "Closes its tabs and clears its cookies, site storage and cache, between runs."}>
            <Button title="Clear…" onPress={() => void clear()} />
          </Row>
        ) : null}
      </Group>
      {on ? <ShopifySignaturesDetails profileId={profileId} signatures={crawler?.shopify ?? []} /> : null}
    </>
  );
}

function ShopifySignaturesDetails({ profileId, signatures }: { profileId: string; signatures: CrawlerShopifySignature[] }) {
  const [problem, setProblem] = useState<{ domain: string; text: string } | null>(null);
  const remove = async (domain: string) => {
    setProblem(null);
    const text = await problemOf(removeCrawlerSignature(profileId, domain));
    if (text) setProblem({ domain, text });
  };
  return (
    <>
      <SectionHeader
        title="Shopify signatures"
        description="Lets this profile through a Shopify store's bot protection. Each signature is for one domain."
        action={<Button title="Add Signature…" icon="plus" onPress={() => showSettingsSheet(<ShopifySignatureSheet profileId={profileId} />)} />}
      />
      <Group>
        {signatures.length === 0 ? (
          <Row title="No signatures" description="Add one for each store this profile crawls." />
        ) : (
          signatures.map((s) => (
            <Row key={s.domain} title={s.domain} description={problem?.domain === s.domain ? problem.text : crawlerSignatureStatus(s)}>
              <Button variant="icon" icon="minus.circle" size="m" onPress={() => void remove(s.domain)} tooltip="Remove" />
            </Row>
          ))
        )}
      </Group>
    </>
  );
}

function ShopifySignatureSheet({ profileId }: { profileId: string }) {
  const [domain, setDomain] = useState("");
  const [signatureInput, setSignatureInput] = useState("");
  const [signature, setSignature] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const ready = !!signatureDomain(domain) && !!signatureInput.trim() && !!signature.trim();
  const save = async () => {
    if (!ready || busy) return;
    setBusy(true);
    setError(null);
    const problem = await problemOf(addCrawlerShopifySignature(profileId, { domain, signatureInput, signature }));
    setBusy(false);
    if (problem) return setError(problem);
    closeSettingsSheet();
  };
  return (
    <Sheet onClose={closeSettingsSheet}>
      <DialogTitle>Add Shopify Signature</DialogTitle>
      <Text size="small" tone="textSecondary" style={NOTE}>
        Create one in the store's admin under Online Store › Preferences › Crawler access.
      </Text>
      <View style={LINK}>
        <Button variant="text" look="link" title="How Shopify signatures work" onPress={() => void openExternalURL(SHOPIFY_CRAWLER_HELP)} />
      </View>
      <FormField label="Domain">
        <TextField value={domain} onChangeText={setDomain} placeholder="your-store.myshopify.com" onSubmit={() => void save()} onEscape={closeSettingsSheet} />
      </FormField>
      <FormField label="Signature-Input">
        <TextField value={signatureInput} onChangeText={setSignatureInput} secure onSubmit={() => void save()} onEscape={closeSettingsSheet} />
      </FormField>
      <FormField label="Signature">
        <TextField value={signature} onChangeText={setSignature} secure onSubmit={() => void save()} onEscape={closeSettingsSheet} />
      </FormField>
      {error ? (
        <Text size="caption" tone="destructive" style={ERROR}>
          {error}
        </Text>
      ) : null}
      <DialogActions>
        <Button title="Cancel" onPress={closeSettingsSheet} />
        <Button title="Add" kind="primary" disabled={!ready || busy} onPress={() => void save()} />
      </DialogActions>
    </Sheet>
  );
}

const NOTE = { marginTop: space.m } as const;
const LINK = { alignItems: "flex-start" } as const;
const ERROR = { marginTop: space.ml } as const;
