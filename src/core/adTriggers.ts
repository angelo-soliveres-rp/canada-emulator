/**
 * Ad triggers & completers extraction.
 *
 * Given a backend ad document (`elastic/ads/_doc` → `data[0].json`), pull out the
 * items that FIRE the ad (triggers) and the items that COMPLETE its offer
 * (completers), so the emulator can show — per ad — exactly what to scan.
 *
 * Schema mirrors CKPlayer2.0 `electron/core/BackendAPIClient.ts` (AdConfig /
 * AdTrigger / AdCompleter): item codes live in a condition's `items[]` (string
 * UPCs OR objects), or directly on `upc` / `itemcode` / `couponupc`, and a
 * trigger/completer may also carry a top-level `items[]`.
 *
 * Pure / browser-safe (no Node or Electron imports).
 */

export interface AdItem {
  /** UPC / item code to scan. */
  code: string;
  /** Human-readable description, when the backend provides one. */
  description?: string;
}

/** One ad's triggers + completers, ready for the UI. */
export interface AdTriggersCompleters {
  id: string;
  name: string;
  /** Backend template name (e.g. 'Static Image Or Video', 'Basket Offer'). */
  template: string;
  triggers: AdItem[];
  completers: AdItem[];
}

interface RawCondition {
  items?: Array<string | Record<string, unknown>>;
  upc?: string;
  itemcode?: string;
  couponupc?: string;
  itemdescription?: string;
  description?: string;
}

interface RawGroup {
  items?: Array<string | Record<string, unknown>>;
  adtriggerconditions?: RawCondition[];
  adcompleterconditions?: RawCondition[];
}

export interface RawAdConfig {
  id?: number | string;
  name?: string;
  templatename?: string;
  adtriggers?: RawGroup[];
  adcompleters?: RawGroup[];
}

/** One ad in the manifest (id + name) — enough to list before fetching details. */
export interface AdManifestEntry {
  id: string;
  name: string;
}

/** Result of fetching the ads manifest (the ad list). */
export interface AdsManifestResult {
  ok: boolean;
  ads: AdManifestEntry[];
  error?: string;
}

/** Result of fetching ONE ad's full doc (lazy, on demand). */
export interface AdDetailResult {
  ok: boolean;
  ad?: RawAdConfig;
  error?: string;
}

function str(v: unknown): string {
  return typeof v === 'string' ? v.trim() : typeof v === 'number' ? String(v) : '';
}

/** Normalize one `items[]` entry (string UPC or object) into an AdItem, or null. */
function itemFromEntry(entry: string | Record<string, unknown>): AdItem | null {
  if (typeof entry === 'string') {
    const code = entry.trim();
    return code ? { code } : null;
  }
  if (entry && typeof entry === 'object') {
    const code = str(entry.code) || str(entry.upc) || str(entry.itemcode);
    if (!code) return null;
    const description = str(entry.description) || str(entry.itemdescription) || str(entry.name);
    return description ? { code, description } : { code };
  }
  return null;
}

/** Collect AdItems from a trigger/completer group (its conditions + top-level items). */
function itemsFromGroup(group: RawGroup, conditions: RawCondition[]): AdItem[] {
  const out: AdItem[] = [];
  const push = (item: AdItem | null): void => {
    if (item) out.push(item);
  };

  for (const entry of group.items ?? []) push(itemFromEntry(entry));

  for (const cond of conditions) {
    for (const entry of cond.items ?? []) push(itemFromEntry(entry));
    const desc = str(cond.itemdescription) || str(cond.description);
    for (const raw of [cond.upc, cond.itemcode, cond.couponupc]) {
      const code = str(raw);
      if (code) push(desc ? { code, description: desc } : { code });
    }
  }

  return dedupeByCode(out);
}

/** Dedupe by code, keeping the first description seen (or filling one in later). */
function dedupeByCode(items: AdItem[]): AdItem[] {
  const byCode = new Map<string, AdItem>();
  for (const item of items) {
    const existing = byCode.get(item.code);
    if (!existing) {
      byCode.set(item.code, item);
    } else if (!existing.description && item.description) {
      existing.description = item.description;
    }
  }
  return [...byCode.values()];
}

/** Extract the triggers + completers for one ad document. */
export function extractTriggersCompleters(ad: RawAdConfig): AdTriggersCompleters {
  const triggers: AdItem[] = [];
  for (const group of ad.adtriggers ?? []) {
    triggers.push(...itemsFromGroup(group, group.adtriggerconditions ?? []));
  }
  const completers: AdItem[] = [];
  for (const group of ad.adcompleters ?? []) {
    completers.push(...itemsFromGroup(group, group.adcompleterconditions ?? []));
  }
  return {
    id: str(ad.id),
    name: str(ad.name) || str(ad.id) || '(unnamed ad)',
    template: str(ad.templatename),
    triggers: dedupeByCode(triggers),
    completers: dedupeByCode(completers),
  };
}

/**
 * Whether a template renders interactive figs (microsite) rather than a plain
 * image/video. 'Static Image Or Video' is the non-interactive walkup template;
 * everything else (Basket Offer, Combo, 2 Or 3 For, Discount Club, Sweeps,
 * Punch Card, Generic, …) is an interactive microsite. Unknown/empty → false.
 */
export function isInteractiveTemplate(template: string | undefined): boolean {
  const t = (template ?? '').trim().toLowerCase();
  return t !== '' && t !== 'static image or video';
}

/** Order ads by name (case-insensitive), matching the legacy emulator list. */
export function orderAds(ads: AdTriggersCompleters[]): AdTriggersCompleters[] {
  return [...ads].sort((a, b) => a.name.toLowerCase().localeCompare(b.name.toLowerCase()));
}

/** Order manifest entries by name (case-insensitive). */
/**
 * Whether a raw ad doc is a real ad rather than a config entry that happens to
 * live in the same ads collection. Config docs carry a templatename ending in
 * "Config" ("Beat The Target Config", "Top 5 Promos Config"); a doc with no
 * templatename at all is not renderable either. Both are evicted from the
 * manifest so the bench lists only things you can actually trigger.
 */
export function isLegitimateAd(ad: RawAdConfig): boolean {
  const template = (ad.templatename ?? '').trim().toLowerCase();
  return template !== '' && !template.endsWith('config');
}

export function orderManifest(ads: AdManifestEntry[]): AdManifestEntry[] {
  return [...ads].sort((a, b) => a.name.toLowerCase().localeCompare(b.name.toLowerCase()));
}
