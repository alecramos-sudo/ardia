import { useEffect, useRef, useState } from "react";
import { copyPageUrl } from "../../state/site/selection";

const COPIED_MS = 1400;

export function useCopyLink(tabId: string | undefined, url: string | undefined) {
  const [copied, setCopied] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => () => clearTimeout(timer.current), []);
  const copy = () => {
    if (!tabId || !url) return;
    void copyPageUrl(tabId);
    setCopied(true);
    clearTimeout(timer.current);
    timer.current = setTimeout(() => setCopied(false), COPIED_MS);
  };
  return { copied, copy };
}
