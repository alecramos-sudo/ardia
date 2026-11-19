let refused = 0;

export function noteCrawlerTabRefused() {
  refused++;
}

export function takeCrawlerTabsRefused(): number {
  const taken = refused;
  refused = 0;
  return taken;
}
