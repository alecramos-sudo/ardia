import type { ClientSiteGroup } from "./clientSiteRows";
import { useMemo } from "react";
import { readClientSites } from "./clientSites";

const NONE: readonly ClientSiteGroup[] = [];

export const useClientSites = (enabled: boolean): readonly ClientSiteGroup[] => useMemo(() => (enabled ? readClientSites() : NONE), [enabled]);
