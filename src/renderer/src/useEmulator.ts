import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { RegisterSession, type WireMessage, type SessionSnapshot, type TenderKind } from '../../core/RegisterSession';
import {
  DEFAULT_POS_CONFIG,
  DEFAULT_LOL_PRESET,
  DEFAULT_PLAYER_CONFIG,
  normalizePlayerConfig,
  normalizePosConfig,
  normalizeLolPreset,
  lolConfigForLane,
  channelsForRegisterType,
  isUsRegisterType,
  type LolPreset,
  type PosConfig,
  type PlayerConfig,
  type RegisterType,
  type Status,
} from '../../core/posTypes';
import type { PosLocale } from '../../core/currency';
import {
  buildPricebookIndex,
  pickQuickKeys,
  type PricebookEntry,
  type QuickKeyItem,
  type PricebookLoadResult,
} from '../../core/pricebook';
import type { GlobalInitConfig } from '../../core/globalInit';
import { loyaltyCardFromScan } from '../../core/scanProtocol';
import { quickKeyColor, type QuickKeyColor, type QuickKeyEntry, type QuickKeyFile } from '../../core/quickkeys';
import {
  extractTriggersCompleters,
  isLegitimateAd,
  orderManifest,
  type AdTriggersCompleters,
  type AdManifestEntry,
} from '../../core/adTriggers';
import { assertNever } from '../../core/assertNever';
import type { ScenarioAction } from '../../core/scenario';
import type { ObservedLine } from '../../core/scenarioEngine';

export interface LogEntry {
  id: number;
  channel: WireMessage['channel'] | 'sys';
  text: string;
  at: string;
}

/** A bench action that was performed, with the wire it emitted (recorder feed). */
export interface EmulatorActionEvent {
  action: ScenarioAction;
  lines: ObservedLine[];
  at: number;
}

/** A player inject that was rung up, with the wire the auto-ring emitted. */
export interface EmulatorInjectEvent {
  barcode: string;
  quantity: number;
  lines: ObservedLine[];
  at: number;
}

export type PricebookItem = QuickKeyItem;

/** Fallback CAD quick keys used until a real pricebook is loaded. */
export const PRICEBOOK: PricebookItem[] = [
  { code: '049000000443', description: 'Coke 20oz', priceCents: 229 },
  { code: '012000001291', description: 'Lays Chips', priceCents: 319 },
  { code: '060410000016', description: 'Cafe Moyen', priceCents: 194 },
  { code: '067000001234', description: 'Beignet', priceCents: 159 },
  { code: '628700001111', description: 'Eau 500ml', priceCents: 199 },
  { code: '063500001019', description: 'Barre Choc', priceCents: 249 },
];

const idleStatus: Status = { vj: 'disconnected', pole: 'disconnected', scanner: 'disconnected' };
const PLAYER_CFG_KEY = 'r6ca.playerConfig';
const PRICEBOOK_DIR_KEY = 'r6ca.pricebookDir';
const POS_CFG_KEY = 'r6ca.posConfig';
const LOL_PRESET_KEY = 'r6ca.lolPreset';
// Empty = use the sample pricebook bundled with this repo (resolved in the main
// process). Paste a folder to override (e.g. a local liftck_player checkout with
// real `<playerCode>-<timestamp>.xml` exports).
const DEFAULT_PRICEBOOK_DIR = '';

export function useEmulator(): {
  snapshot: SessionSnapshot;
  injectSeq: number;
  status: Status;
  config: PosConfig;
  setConfig: (c: PosConfig) => void;
  /** Lift-on-Linux lane preset state (persisted). */
  lol: LolPreset;
  /** Update the LoL preset; enabling (or changing lane) re-stamps the connection config. */
  setLolPreset: (p: LolPreset) => void;
  playerConfig: PlayerConfig;
  setPlayerConfig: (c: PlayerConfig) => void;
  registerPlayer: () => Promise<void>;
  globalInit: GlobalInitConfig | null;
  globalInitError: string | null;
  connect: () => Promise<void>;
  disconnect: () => Promise<void>;
  log: LogEntry[];
  clearLog: () => void;
  setLocale: (l: PosLocale) => void;
  quickKeys: PricebookItem[];
  quickKeyFiles: QuickKeyFile[];
  quickKeyColorFor: (upc: string) => QuickKeyColor;
  fireQuickKey: (entry: QuickKeyEntry) => void;
  reloadQuickKeys: () => Promise<void>;
  adManifest: AdManifestEntry[];
  adDetails: Record<string, AdTriggersCompleters>;
  adsStatus: { loading: boolean; error: string | null };
  loadAds: () => Promise<void>;
  loadAdDetail: (id: string) => Promise<AdTriggersCompleters | null>;
  pricebookDir: string;
  setPricebookDir: (dir: string) => void;
  pricebookStatus: PricebookLoadResult | null;
  /**
   * Human-readable name for a UPC: pricebook, then quick keys, then the bare
   * code. Ad triggers/completers often arrive from the backend without a
   * description, so the bench would otherwise show a raw barcode.
   */
  resolveItemName: (code: string) => string;
  loadPricebook: () => Promise<void>;
  addItem: (item: PricebookItem) => void;
  addCustom: (input: { code: string; description: string; priceCents: number; quantity: number }) => void;
  scan: (code: string, description?: string) => void;
  voidLine: (lineNumber: number) => void;
  setQuantity: (lineNumber: number, qty: number) => void;
  setPrice: (lineNumber: number, priceCents: number) => void;
  /** EasyPay / loyalty sign-in (1024). `cardId` overrides DiscountCardId. */
  loyalty: (cardNumber: string, cardId?: string) => void;
  /** Sign a cashier in (Radiant6 2010 / Topaz `CSH:`). */
  cashier: (operatorId: string, operatorName: string) => void;
  /** Answer an age prompt (Topaz ID-check journal line). No-op elsewhere. */
  ageVerify: (verified: boolean, dob?: string) => void;
  /** Park the open basket (Radiant6 1003). No-op on Topaz/Bulloch. */
  suspendBasket: () => void;
  /** Recall the parked basket (Radiant6 1004). No-op on Topaz/Bulloch. */
  resumeBasket: () => void;
  tender: (kind: TenderKind, amountCents?: number) => void;
  voidTicket: () => void;
  /** Perform any bench action through one funnel; returns the wire it emitted. */
  performAction: (action: ScenarioAction) => ObservedLine[];
  /** Live basket snapshot straight off the session (not the React state copy). */
  getSnapshot: () => SessionSnapshot;
  /** Subscribe to performed actions (scenario recorder feed). */
  onAction: (cb: (ev: EmulatorActionEvent) => void) => () => void;
  /** Subscribe to player injects after they are rung up (scenario wait steps). */
  onInjectEvent: (cb: (ev: EmulatorInjectEvent) => void) => () => void;
} {
  // Connection target survives restarts (host + ports + register type).
  const [config, setConfig] = useState<PosConfig>(() => {
    try {
      return normalizePosConfig(JSON.parse(localStorage.getItem(POS_CFG_KEY) ?? 'null'));
    } catch {
      return DEFAULT_POS_CONFIG;
    }
  });
  useEffect(() => {
    localStorage.setItem(POS_CFG_KEY, JSON.stringify(config));
  }, [config]);

  // Lift-on-Linux lane preset. Enabling it (or picking a lane while enabled)
  // stamps the whole connection target — host, register type, offset ports —
  // from `lolConfigForLane`; the fields stay editable afterwards, so a manual
  // tweak simply diverges from the preset without fighting it.
  const [lol, setLolState] = useState<LolPreset>(() => {
    try {
      return normalizeLolPreset(JSON.parse(localStorage.getItem(LOL_PRESET_KEY) ?? 'null'));
    } catch {
      return DEFAULT_LOL_PRESET;
    }
  });
  const setLolPreset = useCallback((next: LolPreset) => {
    const normalized = normalizeLolPreset(next);
    localStorage.setItem(LOL_PRESET_KEY, JSON.stringify(normalized));
    setLolState(normalized);
    if (normalized.enabled) setConfig(lolConfigForLane(normalized.lane));
  }, []);

  // One session per lane. Rebuilt when the register type changes so the wire
  // protocol matches (Radiant6 Canada = VJ + pole, Bulloch = pole-only). The
  // cashier/shopper locale and the signed-in cashier carry across the switch —
  // switching protocol does not send anyone home.
  const sessionRef = useRef<RegisterSession | null>(null);
  const sessionTypeRef = useRef<RegisterType | undefined>(undefined);
  if (sessionRef.current === null || sessionTypeRef.current !== config.registerType) {
    const previous = sessionRef.current;
    const carried = previous?.snapshot();
    const next = new RegisterSession({
      registerType: config.registerType,
      ...(carried ? { operatorId: carried.operatorId, operatorName: carried.operatorName } : {}),
    });
    if (previous) next.setLocale(previous.locale);
    sessionRef.current = next;
    sessionTypeRef.current = config.registerType;
  }
  const session = sessionRef.current;

  const [snapshot, setSnapshot] = useState<SessionSnapshot>(() => session.snapshot());
  const [status, setStatus] = useState<Status>(idleStatus);
  // Increments on each completer inject from the player (CKP2 completing/adding).
  const [injectSeq, setInjectSeq] = useState(0);
  const [playerConfig, setPlayerConfigState] = useState<PlayerConfig>(() => {
    try {
      return normalizePlayerConfig(JSON.parse(localStorage.getItem(PLAYER_CFG_KEY) ?? 'null'));
    } catch {
      return DEFAULT_PLAYER_CONFIG;
    }
  });
  const [log, setLog] = useState<LogEntry[]>([]);
  const logId = useRef(0);

  // When the register type switches the session is rebuilt (new wire protocol);
  // reset the basket view to match the fresh, empty lane.
  useEffect(() => {
    setSnapshot(session.snapshot());
  }, [session]);

  const logSys = useCallback((text: string) => {
    console.log(`[Emulator] ${text}`);
    setLog((prev) =>
      [{ id: logId.current++, channel: 'sys' as const, text, at: new Date().toLocaleTimeString() }, ...prev].slice(0, 300),
    );
  }, []);

  const [pricebookDir, setPricebookDirState] = useState<string>(
    () => localStorage.getItem(PRICEBOOK_DIR_KEY) ?? DEFAULT_PRICEBOOK_DIR,
  );
  const [pricebookEntries, setPricebookEntries] = useState<PricebookEntry[]>([]);
  const [pricebookStatus, setPricebookStatus] = useState<PricebookLoadResult | null>(null);

  const setPricebookDir = useCallback((dir: string) => {
    setPricebookDirState(dir);
    try {
      localStorage.setItem(PRICEBOOK_DIR_KEY, dir);
    } catch {
      // ignore storage failures
    }
  }, []);

  const pricebookIndex = useMemo(() => buildPricebookIndex(pricebookEntries), [pricebookEntries]);
  const quickKeys = useMemo<PricebookItem[]>(
    () => (pricebookEntries.length > 0 ? pickQuickKeys(pricebookEntries) : PRICEBOOK),
    [pricebookEntries],
  );

  // Quick keys loaded from the bundled .qk files (legacy usualsuspects format).
  const [quickKeyFiles, setQuickKeyFiles] = useState<QuickKeyFile[]>([]);

  // Ads. The manifest (id + name) loads fast; each ad's triggers/completers are
  // fetched lazily on demand and cached in adDetails (keyed by ad id).
  const [adManifest, setAdManifest] = useState<AdManifestEntry[]>([]);
  const [adDetails, setAdDetails] = useState<Record<string, AdTriggersCompleters>>({});
  const [adsStatus, setAdsStatus] = useState<{ loading: boolean; error: string | null }>({
    loading: false,
    error: null,
  });

  // Quick keys turn green when their UPC is a trigger for an inspected ad —
  // sourced from the ad details fetched so far.
  const adCodes = useMemo(
    () => new Set(Object.values(adDetails).flatMap((g) => g.triggers.map((t) => t.code))),
    [adDetails],
  );

  const pricebookCodes = useMemo(() => new Set(pricebookIndex.keys()), [pricebookIndex]);

  // O(1) Map lookup per visible chip — cheap enough to call during render.
  const resolveItemName = useCallback(
    (code: string): string =>
      pricebookIndex.get(code)?.description || quickKeys.find((p) => p.code === code)?.description || code,
    [pricebookIndex, quickKeys],
  );
  const quickKeyColorFor = useCallback(
    (upc: string): QuickKeyColor =>
      quickKeyColor(upc, { pricebookLoaded: pricebookEntries.length > 0, pricebookCodes, adCodes }),
    [pricebookCodes, pricebookEntries.length, adCodes],
  );

  const loadQuickKeys = useCallback(async () => {
    logSys('Loading quick keys from bundled defaults…');
    const res = await window.emulator.loadQuickKeys({});
    if (res.ok) {
      setQuickKeyFiles(res.files);
      const total = res.files.reduce((n, f) => n + f.entries.length, 0);
      logSys(`Quick keys loaded from ${res.dir}: ${res.files.length} file(s), ${total} keys`);
    } else {
      setQuickKeyFiles([]);
      logSys(`Quick keys error: ${res.error}`);
    }
  }, [logSys]);

  // GlobalInit registration result — the datacenter the player.key resolved to
  // (e2e / dev / prod), with that datacenter's endpoint URLs.
  const [globalInit, setGlobalInit] = useState<GlobalInitConfig | null>(null);
  const [globalInitError, setGlobalInitError] = useState<string | null>(null);

  // The backend to talk to is auto-detected from the registered datacenter's
  // endpoints (so an e2e player.key hits e2e even if the Backend field says dev).
  // Falls back to the manually entered Backend URL before registration.
  const resolvedBackendUrl = useMemo(() => {
    const ep = globalInit?.endpoints ?? {};
    return ep['manifest.url'] || ep['contentCron.baseUrl'] || ep['init.url'] || ep['heartbeat.url'] || playerConfig.backendBaseUrl;
  }, [globalInit, playerConfig.backendBaseUrl]);

  const adsRunRef = useRef(0);
  const loadAds = useCallback(async () => {
    const run = ++adsRunRef.current; // invalidates any in-flight prefetch
    setAdsStatus({ loading: true, error: null });
    logSys(`Loading ads for "${playerConfig.playerCode}" from ${resolvedBackendUrl}…`);
    const req = {
      backendBaseUrl: resolvedBackendUrl,
      playerCode: playerConfig.playerCode,
      playerKey: playerConfig.playerKey,
    };
    try {
      const res = await window.emulator.loadAds(req);
      if (!res.ok) {
        setAdManifest([]);
        setAdsStatus({ loading: false, error: res.error ?? 'unknown error' });
        logSys(`Ads error: ${res.error}`);
        return;
      }
      const manifest = orderManifest(res.ads);
      setAdManifest(manifest);
      setAdDetails({});
      setAdsStatus({ loading: false, error: null });
      logSys(`Ads loaded: ${manifest.length} ad(s) — fetching details…`);

      // Background-prefetch every ad's triggers/completers (throttled), so the
      // completer dots + template labels fill in without per-page waits.
      // The manifest can't be filtered up front — only the full doc carries the
      // templatename that tells a real ad from a config entry — so config ids
      // are collected here and evicted once the prefetch settles.
      const ids = manifest.map((m) => m.id);
      const configIds = new Set<string>();
      let next = 0;
      const worker = async (): Promise<void> => {
        while (next < ids.length && adsRunRef.current === run) {
          const id = ids[next++];
          try {
            const r = await window.emulator.loadAdDetail({ ...req, id });
            if (adsRunRef.current !== run) return;
            if (r.ok && r.ad) {
              if (!isLegitimateAd(r.ad)) {
                configIds.add(id);
                continue;
              }
              const detail = extractTriggersCompleters(r.ad);
              setAdDetails((prev) => (prev[id] ? prev : { ...prev, [id]: detail }));
            }
          } catch {
            // ignore individual ad failures — others still load
          }
        }
      };
      await Promise.all(Array.from({ length: 5 }, () => worker()));
      if (adsRunRef.current === run) {
        if (configIds.size > 0) {
          setAdManifest((prev) => prev.filter((m) => !configIds.has(m.id)));
          logSys(`Ad details loaded — evicted ${configIds.size} config entry(s), kept ${manifest.length - configIds.size} ad(s)`);
        } else {
          logSys(`Ad details loaded (${manifest.length})`);
        }
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      setAdsStatus({ loading: false, error: msg });
      logSys(`Ads error: ${msg} (restart the app if you just updated it)`);
    }
  }, [resolvedBackendUrl, playerConfig.playerCode, playerConfig.playerKey, logSys]);

  // Fetch one ad's triggers/completers on demand (cached by id).
  const loadAdDetail = useCallback(
    async (id: string): Promise<AdTriggersCompleters | null> => {
      const cached = adDetails[id];
      if (cached) return cached;
      try {
        const res = await window.emulator.loadAdDetail({
          backendBaseUrl: resolvedBackendUrl,
          playerCode: playerConfig.playerCode,
          playerKey: playerConfig.playerKey,
          id,
        });
        if (!res.ok || !res.ad) {
          logSys(`Ad detail error (${id}): ${res.error}`);
          return null;
        }
        if (!isLegitimateAd(res.ad)) {
          setAdManifest((prev) => prev.filter((m) => m.id !== id));
          logSys(`Evicted config entry "${id}" from the ads list (not a real ad)`);
          return null;
        }
        const detail = extractTriggersCompleters(res.ad);
        setAdDetails((prev) => ({ ...prev, [id]: detail }));
        return detail;
      } catch (err) {
        logSys(`Ad detail error (${id}): ${err instanceof Error ? err.message : String(err)}`);
        return null;
      }
    },
    [adDetails, resolvedBackendUrl, playerConfig.playerCode, playerConfig.playerKey, logSys],
  );

  // Auto-load quick keys once on mount.
  const quickKeysLoadedRef = useRef(false);
  useEffect(() => {
    if (quickKeysLoadedRef.current) return;
    quickKeysLoadedRef.current = true;
    void loadQuickKeys();
  }, [loadQuickKeys]);

  const setPlayerConfig = useCallback((c: PlayerConfig) => {
    const normalized = normalizePlayerConfig(c);
    setPlayerConfigState(normalized);
    try {
      localStorage.setItem(PLAYER_CFG_KEY, JSON.stringify(normalized));
    } catch {
      // ignore storage failures (private mode etc.)
    }
  }, []);

  useEffect(() => {
    const unsub = window.emulator.onStatus(setStatus);
    void window.emulator.getStatus().then(setStatus);
    return unsub;
  }, []);

  const dispatch = useCallback(
    (messages: WireMessage[]) => {
      const entries: LogEntry[] = [];
      for (const m of messages) {
        // send() rejects on RPC timeout / queue overflow / closed WebSocket —
        // surface it instead of leaving an unhandled rejection.
        window.emulator.send(m.channel, m.data).catch((err: unknown) => {
          logSys(`Send failed on ${m.channel}: ${err instanceof Error ? err.message : String(err)}`);
        });
        entries.push({
          id: logId.current++,
          channel: m.channel,
          text: m.data.replace(/\r\n$/, ''),
          at: new Date().toLocaleTimeString(),
        });
      }
      setLog((prev) => [...entries.reverse(), ...prev].slice(0, 300));
      setSnapshot(session.snapshot());
    },
    [session, logSys],
  );

  // Scenario-mode taps: every bench action and every player inject flows past
  // these subscriber sets so the recorder and runner can observe the session
  // without owning it.
  const actionSubsRef = useRef(new Set<(ev: EmulatorActionEvent) => void>());
  const injectSubsRef = useRef(new Set<(ev: EmulatorInjectEvent) => void>());

  /**
   * One funnel for every bench action — manual buttons, quick keys and
   * scenario steps all resolve + dispatch here, so a recorded action replays
   * through exactly the code path the manual click took.
   */
  const performAction = useCallback(
    (action: ScenarioAction): ObservedLine[] => {
      const resolve = (code: string): PricebookItem | undefined =>
        pricebookIndex.get(code) ?? quickKeys.find((p) => p.code === code);
      const messages = ((): WireMessage[] => {
        switch (action.kind) {
          case 'ring': {
            const hit = resolve(action.code);
            return session.addItem({
              code: action.code,
              description: action.description?.trim() || hit?.description || `UPC ${action.code}`,
              priceCents: action.priceCents ?? hit?.priceCents ?? 100,
              quantity: action.quantity,
            });
          }
          case 'scan': {
            // Legacy parity: the Radiant6 emulator family (Canada inherits the
            // US class) turns loyalty-prefixed scans into a 1024 sign-in. Topaz
            // has no such intercept — its loyalty is the explicit LOYALTY action.
            const loyaltyCard =
              config.registerType === 'radiant6-us' || config.registerType === 'radiant6-canada'
                ? loyaltyCardFromScan(action.code)
                : null;
            if (loyaltyCard) return session.loyalty(loyaltyCard);
            const hit = resolve(action.code);
            return session.addItem(
              hit
                ? { code: hit.code, description: hit.description, priceCents: hit.priceCents }
                : { code: action.code, description: action.description?.trim() || `UPC ${action.code}`, priceCents: 100 },
            );
          }
          case 'loyalty':
            return session.loyalty(action.card, action.cardId);
          case 'cashier':
            return session.cashierChange({ operatorId: action.operatorId, operatorName: action.operatorName });
          case 'ageVerify':
            return session.ageVerify({ verified: action.verified, dob: action.dob });
          case 'suspendBasket':
            return session.suspendBasket();
          case 'resumeBasket':
            return session.resumeBasket();
          case 'voidLine':
            return session.voidLine(action.lineNumber);
          case 'setQuantity':
            return session.setQuantity(action.lineNumber, action.quantity);
          case 'setPrice':
            return session.setPrice(action.lineNumber, action.priceCents);
          case 'tender':
            return session.tender(action.tender, action.amountCents);
          case 'voidTicket':
            return session.voidTicket();
          default:
            return assertNever(action);
        }
      })();
      dispatch(messages);
      const lines: ObservedLine[] = messages.map((m) => ({ channel: m.channel, text: m.data }));
      const event: EmulatorActionEvent = { action, lines, at: Date.now() };
      for (const cb of [...actionSubsRef.current]) cb(event);
      return lines;
    },
    [session, dispatch, config.registerType, pricebookIndex, quickKeys],
  );

  const getSnapshot = useCallback((): SessionSnapshot => session.snapshot(), [session]);

  const onAction = useCallback((cb: (ev: EmulatorActionEvent) => void): (() => void) => {
    actionSubsRef.current.add(cb);
    return () => actionSubsRef.current.delete(cb);
  }, []);

  const onInjectEvent = useCallback((cb: (ev: EmulatorInjectEvent) => void): (() => void) => {
    injectSubsRef.current.add(cb);
    return () => injectSubsRef.current.delete(cb);
  }, []);

  // Ring up completer injects pushed by the player over the VJ reverse channel:
  // resolve the UPC (pricebook → quick keys → fallback) and add it to the basket,
  // which emits the normal 1011 + pole back so the player's basket reflects it.
  // Each inject bumps injectSeq — the player completing/adding a completer is the
  // signal to close the emulator's now-stale completer modal.
  useEffect(() => {
    return window.emulator.onInject((cmd) => {
      // US-family injects arrive as raw scans on the scanner socket — surface
      // the inbound line under its own channel so the Scan filter reflects it.
      if (isUsRegisterType(config.registerType)) {
        setLog((prev) =>
          [
            { id: logId.current++, channel: 'scanner' as const, text: `← ${cmd.barcode}`, at: new Date().toLocaleTimeString() },
            ...prev,
          ].slice(0, 300),
        );
      }
      const notifyInject = (messages: WireMessage[]): void => {
        const wire: ObservedLine[] = [
          ...(isUsRegisterType(config.registerType)
            ? [{ channel: 'scanner' as const, text: `← ${cmd.barcode}` }]
            : []),
          ...messages.map((m) => ({ channel: m.channel, text: m.data })),
        ];
        const event: EmulatorInjectEvent = { barcode: cmd.barcode, quantity: cmd.quantity, lines: wire, at: Date.now() };
        for (const cb of [...injectSubsRef.current]) cb(event);
      };
      // Legacy Radiant6RegisterEmulator parity: loyalty-prefixed scans
      // (D7826/D8018/8018…) route to an EventId 1024 sign-in, not an item ring.
      const loyaltyCard = config.registerType === 'radiant6-us' ? loyaltyCardFromScan(cmd.barcode) : null;
      if (loyaltyCard) {
        logSys(`Loyalty scan inject: ${cmd.barcode} → 1024 card ${loyaltyCard}`);
        const messages = session.loyalty(loyaltyCard);
        dispatch(messages);
        notifyInject(messages);
        return;
      }
      const hit = pricebookIndex.get(cmd.barcode) ?? quickKeys.find((p) => p.code === cmd.barcode);
      const item = hit
        ? { code: hit.code, description: hit.description, priceCents: hit.priceCents, quantity: cmd.quantity }
        : { code: cmd.barcode, description: `UPC ${cmd.barcode}`, priceCents: 100, quantity: cmd.quantity };
      logSys(`Completer inject: ${cmd.barcode} ×${cmd.quantity} → ${item.description}`);
      const messages = session.addItem(item);
      dispatch(messages);
      notifyInject(messages);
      setInjectSeq((n) => n + 1);
    });
  }, [pricebookIndex, quickKeys, session, dispatch, logSys, config.registerType]);

  const connect = useCallback(async () => {
    const ports: Record<string, number> = { vj: config.vjPort, pole: config.polePort, scanner: config.scannerPort };
    const summary = channelsForRegisterType(config.registerType)
      .map((ch) => `${ch} ${ports[ch]}`)
      .join(', ');
    logSys(`Connecting to ${config.host} (${summary})…`);
    const s = await window.emulator.connect(config);
    setStatus(s);
  }, [config, logSys]);

  const disconnect = useCallback(async () => {
    logSys('Disconnecting…');
    const s = await window.emulator.disconnect();
    setStatus(s);
  }, [logSys]);

  const setLocale = useCallback(
    (l: PosLocale) => {
      session.setLocale(l);
      setSnapshot(session.snapshot());
    },
    [session],
  );

  const loadPricebook = useCallback(async () => {
    logSys(`Loading pricebook for "${playerConfig.playerCode}" from ${pricebookDir || 'bundled sample'}…`);
    const result = await window.emulator.loadPricebook({ dir: pricebookDir, playerCode: playerConfig.playerCode });
    setPricebookStatus(result);
    setPricebookEntries(result.ok ? result.entries : []);
    logSys(
      result.ok
        ? `Pricebook loaded: ${result.count} items (${result.path.split('/').pop()})`
        : `Pricebook error: ${result.error}`,
    );
  }, [pricebookDir, playerConfig.playerCode, logSys]);

  // Auto-load the pricebook once on mount so item descriptions/prices and
  // quick-key colors resolve out-of-the-box from the bundled sample.
  const pricebookLoadedRef = useRef(false);
  useEffect(() => {
    if (pricebookLoadedRef.current) return;
    pricebookLoadedRef.current = true;
    void loadPricebook();
  }, [loadPricebook]);

  // On startup, rehydrate from the persisted player.key file (if a prior
  // registration saved one) so the generated config + endpoints survive a
  // restart — parity with the legacy player reading its player.key file.
  const hydratedRef = useRef(false);
  useEffect(() => {
    if (hydratedRef.current) return;
    hydratedRef.current = true;
    void window.emulator.loadPlayerKey().then((res) => {
      if (res.ok && res.config) {
        setGlobalInit(res.config);
        setPlayerConfig({
          ...playerConfig,
          playerCode: res.config.playerCode,
          playerKey: res.config.playerKey || playerConfig.playerKey,
        });
        logSys(`Loaded persisted player.key: ${res.config.playerCode} (tenant ${res.config.tenant})`);
      }
    });
  }, [playerConfig, setPlayerConfig, logSys]);

  const registerPlayer = useCallback(async () => {
    setGlobalInitError(null);
    logSys(`Registering player.key ${playerConfig.playerKey.slice(0, 8)}… across datacenters`);
    const res = await window.emulator.registerPlayer({ playerKey: playerConfig.playerKey });
    if (res.ok && res.config) {
      setGlobalInit(res.config);
      // Adopt the discovered player code so the rest of the app (pricebook,
      // tenant) lines up with the registered player.
      setPlayerConfig({ ...playerConfig, playerCode: res.config.playerCode });
      logSys(`Registered: ${res.config.playerCode} (tenant ${res.config.tenant}) via ${res.config.datacenter}`);
    } else {
      setGlobalInit(null);
      setGlobalInitError(res.error ?? 'Registration failed');
      logSys(`Register failed: ${res.error ?? 'unknown error'}`);
    }
  }, [playerConfig, setPlayerConfig, logSys]);

  return useMemo(
    () => ({
      snapshot,
      injectSeq,
      status,
      config,
      setConfig,
      lol,
      setLolPreset,
      playerConfig,
      setPlayerConfig,
      registerPlayer,
      globalInit,
      globalInitError,
      connect,
      disconnect,
      log,
      clearLog: () => setLog([]),
      setLocale,
      quickKeys,
      quickKeyFiles,
      quickKeyColorFor,
      fireQuickKey: (entry: QuickKeyEntry) => {
        performAction({
          kind: 'ring',
          code: entry.upc,
          description: entry.description,
          priceCents: entry.priceCents,
          quantity: entry.quantity,
        });
      },
      reloadQuickKeys: loadQuickKeys,
      adManifest,
      adDetails,
      adsStatus,
      loadAds,
      loadAdDetail,
      pricebookDir,
      setPricebookDir,
      pricebookStatus,
      resolveItemName,
      loadPricebook,
      addItem: (item: PricebookItem) => {
        performAction({ kind: 'ring', code: item.code, description: item.description, priceCents: item.priceCents });
      },
      addCustom: (input: { code: string; description: string; priceCents: number; quantity: number }) => {
        performAction({ kind: 'ring', ...input });
      },
      scan: (code: string, description?: string) => {
        performAction({ kind: 'scan', code, description });
      },
      voidLine: (lineNumber: number) => {
        performAction({ kind: 'voidLine', lineNumber });
      },
      setQuantity: (lineNumber: number, qty: number) => {
        performAction({ kind: 'setQuantity', lineNumber, quantity: qty });
      },
      setPrice: (lineNumber: number, priceCents: number) => {
        performAction({ kind: 'setPrice', lineNumber, priceCents });
      },
      loyalty: (cardNumber: string, cardId?: string) => {
        performAction({ kind: 'loyalty', card: cardNumber, ...(cardId ? { cardId } : {}) });
      },
      cashier: (operatorId: string, operatorName: string) => {
        performAction({ kind: 'cashier', operatorId, operatorName });
      },
      ageVerify: (verified: boolean, dob?: string) => {
        performAction({ kind: 'ageVerify', verified, ...(dob ? { dob } : {}) });
      },
      suspendBasket: () => {
        performAction({ kind: 'suspendBasket' });
      },
      resumeBasket: () => {
        performAction({ kind: 'resumeBasket' });
      },
      tender: (kind: TenderKind, amountCents?: number) => {
        performAction({ kind: 'tender', tender: kind, amountCents });
      },
      voidTicket: () => {
        performAction({ kind: 'voidTicket' });
      },
      performAction,
      getSnapshot,
      onAction,
      onInjectEvent,
    }),
    [
      performAction,
      getSnapshot,
      onAction,
      onInjectEvent,
      snapshot,
      injectSeq,
      status,
      config,
      lol,
      setLolPreset,
      playerConfig,
      setPlayerConfig,
      log,
      connect,
      disconnect,
      dispatch,
      setLocale,
      session,
      quickKeys,
      quickKeyFiles,
      quickKeyColorFor,
      loadQuickKeys,
      adManifest,
      adDetails,
      adsStatus,
      loadAds,
      loadAdDetail,
      pricebookDir,
      setPricebookDir,
      pricebookStatus,
      resolveItemName,
      loadPricebook,
      pricebookIndex,
      registerPlayer,
      globalInit,
      globalInitError,
    ],
  );
}
