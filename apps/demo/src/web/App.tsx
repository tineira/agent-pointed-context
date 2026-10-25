import { canonicalTarget, parseFocusAttrs, type FocusTarget } from "@apc/protocol";
import { createViewReporter, enablePinning, flashTargets, initials as initialsOf, markState } from "@apc/web";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { generateDataset, LAST_MONTH, MONTHS, PLANS, REGIONS, type Dataset, type Plan, type Region } from "../model/seed.ts";
import { displayNames, motionFor, type AgentMotion } from "./agent-brands.ts";
import { AgentIcon } from "./agent-icon.tsx";
import { AgentBar, type PulseBarAgent } from "./agent-bar.tsx";
import { createApi, openSession, type Api, type SandboxState } from "./api.ts";
import { activeConflict } from "./connect.tsx";
import { openDock, SIGNALS_ORIGIN, useDockBridge } from "./dock-bridge.ts";
import { HubConsent, type PendingDrop } from "./hub-consent.tsx";
import { productName } from "../model/products.ts";
import { HowTo } from "./howto.tsx";
import { Landing } from "./landing/landing.tsx";
import { AppLink, LogoMark, SiteFooter, ThemeToggle } from "./ui.tsx";
import { Agents, CustomerDetail, Customers, Overview, type Filters } from "./pages.tsx";
import { PinBadges, isSeen, pinLabel } from "./pin-badges.tsx";
import { presenceEffects } from "./presence.ts";
import { Tour } from "./tour.tsx";

type Screen = "howto" | "overview" | "customers" | "agents";
type Route = { screen: Screen } | { screen: "customer"; id: string };

function readRoute(): { route: Route; filters: Filters } {
  const url = new URL(location.href);
  const q = url.searchParams;
  const month = q.get("month");
  const plan = q.get("plan");
  const region = q.get("region");
  const filters: Filters = {
    month: month && MONTHS.includes(month) ? month : LAST_MONTH,
    ...(plan && (PLANS as readonly string[]).includes(plan) ? { plan: plan as Plan } : {}),
    ...(region && (REGIONS as readonly string[]).includes(region) ? { region: region as Region } : {}),
  };
  const customer = url.pathname.match(/^\/customers\/(cus_\d{4})$/);
  if (customer) return { route: { screen: "customer", id: customer[1]! }, filters };
  if (url.pathname.startsWith("/customers")) return { route: { screen: "customers" }, filters };
  if (url.pathname.startsWith("/agents") || url.pathname.startsWith("/connect")) return { route: { screen: "agents" }, filters };
  if (url.pathname.startsWith("/overview")) return { route: { screen: "overview" }, filters };
  return { route: { screen: "howto" }, filters };
}

function writeRoute(route: Route, filters: Filters): void {
  const path = route.screen === "customer" ? `/customers/${route.id}` : route.screen === "howto" ? "/how-to" : `/${route.screen}`;
  const q = new URLSearchParams();
  if (route.screen === "overview" || route.screen === "customers" || route.screen === "customer") {
    q.set("month", filters.month);
    if (filters.plan) q.set("plan", filters.plan);
    if (filters.region) q.set("region", filters.region);
  }
  const next = `${path}${q.size ? `?${q}` : ""}`;
  if (next !== `${location.pathname}${location.search}`) history.pushState(null, "", next);
}

/** APC v2 features stay off in v1 unless the page was opened with ?apc=v2 (remembered for the tab). */
function v2Enabled(): boolean {
  try {
    if (new URLSearchParams(location.search).get("apc") === "v2") sessionStorage.setItem("apc-v2", "1");
    return sessionStorage.getItem("apc-v2") === "1";
  } catch {
    return false;
  }
}

/** The landing is public and opens no sandbox; every other page belongs to the visitor's sandbox. */
export function App() {
  const [path, setPath] = useState(location.pathname);
  useEffect(() => {
    const onPop = () => setPath(location.pathname);
    window.addEventListener("popstate", onPop);
    return () => window.removeEventListener("popstate", onPop);
  }, []);
  return (
    <div className="flex min-h-svh flex-col">
      {path === "/" ? <Landing /> : <SandboxGate />}
      <SiteFooter />
    </div>
  );
}

function SandboxGate() {
  const [sid, setSid] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    openSession().then(setSid, (e: unknown) => setError(String(e)));
  }, []);
  if (error) return <p className="py-12 text-center text-sm text-muted">Could not open a sandbox: {error}</p>;
  if (!sid) return <p className="py-12 text-center text-sm text-muted">Opening your sandbox…</p>;
  return <Sandbox sid={sid} />;
}

function Sandbox({ sid }: { sid: string }) {
  const api: Api = useMemo(() => createApi(sid), [sid]);
  const [state, setState] = useState<SandboxState | null>(null);
  const [data, setData] = useState<Dataset | null>(null);
  const [{ route, filters }, setNav] = useState(readRoute);
  const [pulse, setPulse] = useState<Record<string, number>>({});
  // When each agent started a wait_for_focus that has not ended, and when it last read a pin: what its icon does.
  const [waitingSince, setWaitingSince] = useState<Record<string, number>>({});
  const [seenAt, setSeenAt] = useState<Record<string, number>>({});
  // The agents whose pin has a badge on this screen (pin-badges.tsx).
  const [onScreen, setOnScreen] = useState<Set<string>>(new Set());
  const [notice, setNotice] = useState<string | null>(null);
  // Bumped by every message from the sandbox: what the compatibility matrix reloads on.
  const [activity, setActivity] = useState(0);
  const [, tick] = useState(0);
  const stateRef = useRef<SandboxState | null>(null);
  stateRef.current = state;
  // APC v2 features (TIN-369, TIN-370), off unless the tab was opened with ?apc=v2. Pulse's v2 deploy
  // (TIN-382) has them on, and pairs with a dock's hub instead of feeding the bridge dock.
  const flagged = useMemo(v2Enabled, []);
  const hubMode = !!state?.v2;
  const v2 = flagged || hubMode;
  const [pendingDrop, setPendingDrop] = useState<PendingDrop | null>(null);

  const refresh = useCallback(() => api.state().then(setState), [api]);
  useEffect(() => {
    void refresh();
  }, [refresh]);
  // The data is deterministic from the sandbox's seed: the page rebuilds it with the same function
  // the sandbox uses, instead of downloading it (the heaviest call in the load test).
  const seed = state?.seed;
  useEffect(() => {
    if (seed !== undefined) setData(generateDataset(seed));
  }, [seed]);

  const navigate = useCallback((nextRoute: Route, nextFilters: Filters) => {
    writeRoute(nextRoute, nextFilters);
    setNav({ route: nextRoute, filters: nextFilters });
  }, []);
  useEffect(() => {
    const onPop = () => setNav(readRoute());
    window.addEventListener("popstate", onPop);
    return () => window.removeEventListener("popstate", onPop);
  }, []);

  // Initials per agent, from the client name it declared (or its label before it connects).
  const initials = useMemo(() => {
    const taken = new Set<string>();
    const map = new Map<string, string>();
    for (const g of state?.grants ?? []) {
      const value = initialsOf(g.client_name ?? (g.regions ? "Restricted" : "Agent"), taken);
      taken.add(value);
      map.set(g.id, value);
    }
    return map;
  }, [state]);
  // The name each agent shows (TIN-356): the person's, the agent's own, its client's.
  const names = useMemo(() => displayNames(state?.grants ?? []), [state]);
  const namesRef = useRef(names);
  namesRef.current = names;
  const initialsRef = useRef(initials);
  initialsRef.current = initials;

  // Presence and pin updates from the sandbox.
  useEffect(
    () =>
      api.connect((message) => {
        setActivity((n) => n + 1);
        if (message.type === "activity") return;
        if (message.type === "presence") {
          const effects = presenceEffects(stateRef.current?.settings);
          if (effects.pulse) {
            setPulse((p) => ({ ...p, [message.event.grant_id]: Date.now() }));
            setTimeout(() => tick((n) => n + 1), 1600);
          }
          if (effects.flash) flashTargets(message.event, initialsRef.current.get(message.event.grant_id) ?? "AG");
        } else if (message.type === "waiting") {
          setWaitingSince((w) => {
            const { [message.grant_id]: _, ...rest } = w;
            return message.on ? { ...rest, [message.grant_id]: Date.now() } : rest;
          });
        } else if (message.type === "pin") {
          const pin = message.pin;
          if (pin?.seen_at && pin.seen_at >= pin.pinned_at) {
            setSeenAt((s) => ({ ...s, [message.grant_id]: Date.now() }));
            setTimeout(() => tick((n) => n + 1), 1300);
          }
          setState((s) => (s ? { ...s, grants: s.grants.map((g) => (g.id === message.grant_id ? { ...g, pin: message.pin } : g)) } : s));
          // The guided first run advances on pins and reads (its step comes with the state).
          void refresh();
        } else {
          void refresh();
        }
      }),
    [api, refresh],
  );
  useEffect(() => {
    const id = setInterval(() => tick((n) => n + 1), 15_000);
    return () => clearInterval(id);
  }, []);

  // The view, as identifiers, debounced.
  const report = useMemo(() => createViewReporter((view) => void api.reportView(view)), [api]);
  useEffect(() => {
    report({
      screen: route.screen,
      params: { month: filters.month, ...(filters.plan ? { plan: filters.plan } : {}), ...(filters.region ? { region: filters.region } : {}) },
      selection: route.screen === "customer" ? { kind: "customer", id: route.id } : null,
    });
  }, [report, route, filters]);

  // Drag a mark onto anything with data-focus. A restricted agent cannot be dropped outside its regions.
  const regionOf = useMemo(() => new Map((data?.customers ?? []).map((c) => [c.id, c.region])), [data]);
  useEffect(
    () =>
      enablePinning({
        // APC v2 (TIN-369): drops of an agent dragged from a dock in another window, only with ?apc=v2.
        acceptNativeDrops: v2,
        // A grant id: the bridge dock (TIN-370). An agent from a hub dock is never resolved here; it goes below.
        resolveAgent: (handle) => (stateRef.current?.grants.some((g) => g.id === handle) ? handle : null),
        // An agent from a hub dock (TIN-389): one paired here pins through the server, which checks with the
        // dock that the pairing still stands; one not paired, or no longer, asks the person (hub-consent.tsx).
        onUnknownAgent: hubMode
          ? async (drag, target) => {
              const paired = stateRef.current?.hub_links?.some((l) => l.hub === drag.hub && l.agent === drag.agent);
              if (!paired) return setPendingDrop({ drag, target, at: Date.now() });
              const r = await api.hubPair({ hub: drag.hub, agent: drag.agent, ticket: drag.ticket, region: null, target });
              if (r.ok) setNotice(`Pinned ${namesRef.current.get(r.grant_id ?? "") ?? "your agent"}. Now ask it about "this".`);
              else if (r.error === "not_paired") setPendingDrop({ drag, target, at: Date.now() });
              else setNotice(`Not pinned: ${r.error}`);
              setTimeout(() => setNotice(null), 4000);
              void refresh();
            }
          : undefined,
        canTarget: (grantId, target: FocusTarget) => {
          const grant = stateRef.current?.grants.find((g) => g.id === grantId);
          if (!grant?.regions) return true;
          if (target.kind === "customer" && target.id) return grant.regions.includes(regionOf.get(target.id)!);
          const region = target.params?.region;
          return typeof region !== "string" || grant.regions.includes(region as Region);
        },
        onPin: async (grantId, target) => {
          // A badge dropped back on its own target (TIN-354) changes nothing: the pin keeps its read state.
          const current = stateRef.current?.grants.find((g) => g.id === grantId)?.pin;
          if (current && canonicalTarget(current) === canonicalTarget(target)) return;
          const result = await api.pin(grantId, target);
          setNotice(result.ok ? `Pinned ${namesRef.current.get(grantId) ?? "your agent"}. Now ask it about "this".` : `Not pinned: ${result.error}`);
          setTimeout(() => setNotice(null), 4000);
        },
      }),
    [api, regionOf, v2, hubMode],
  );

  // Show each pin on its target when the target is on this page.
  useEffect(() => {
    for (const el of document.querySelectorAll("[data-apc-pinned]")) el.removeAttribute("data-apc-pinned");
    for (const g of state?.grants ?? []) {
      if (!g.pin) continue;
      const want = canonicalTarget(g.pin);
      for (const el of document.querySelectorAll("[data-focus]")) {
        const t = parseFocusAttrs(el.getAttribute("data-focus"), el.getAttribute("data-focus-part"), el.getAttribute("data-focus-params"));
        if (t && canonicalTarget(t) === want) el.setAttribute("data-apc-pinned", initials.get(g.id) ?? "AG");
      }
    }
  });

  const motionOf = (grantId: string): AgentMotion => {
    const g = state?.grants.find((x) => x.id === grantId);
    const since = waitingSince[grantId];
    return motionFor({
      connected: !!g?.client_name,
      // A wait ends within a minute (WAIT_CEILING_S); a lost end message does not leave the icon floating.
      waiting: since !== undefined && Date.now() - since < 70_000,
      busy: !!pulse[grantId] && Date.now() - pulse[grantId]! < 1500,
      seenAt: seenAt[grantId],
      now: Date.now(),
    });
  };
  // APC v2 (TIN-370): a dock window opened from here shows these agents and drags them back.
  useDockBridge(
    v2 && !hubMode,
    state?.grants.map((g) => ({
      handle: g.id,
      name: names.get(g.id) ?? g.label,
      client_name: g.client_name,
      client_ua: g.client_ua,
      client_icon: g.client_icon,
      motion: motionOf(g.id),
      pin: g.pin ? { label: pinLabel(g.pin), seen: isSeen(g.pin) } : null,
    })) ?? null,
  );

  if (!state || !data) return <p className="py-12 text-center text-sm text-muted">Loading…</p>;
  // The standard agent bar's agents (TIN-394), on Pulse's v2 deploy.
  const barAgents: PulseBarAgent[] = state.grants.map((g) => ({
    id: g.id,
    name: names.get(g.id) ?? g.label,
    client_name: g.client_name,
    client_ua: g.client_ua,
    client_icon: g.client_icon,
    icon: g.client_icon,
    state: motionOf(g.id),
    pin: g.pin ? { label: pinLabel(g.pin), seen: isSeen(g.pin), here: onScreen.has(g.id) } : null,
    warning: activeConflict(g) ? `${productName(activeConflict(g)!.client_name, activeConflict(g)!.user_agent)} is using ${names.get(g.id)}'s URL. Open Agents to give it its own.` : null,
    restricted: !!g.regions,
  }));
  /** The screen that shows a pin: a customer's page, or the overview with the figure's filters. */
  const openPin = (pin: NonNullable<SandboxState["grants"][number]["pin"]>) => {
    if (pin.kind === "customer" && pin.id) return navigate({ screen: "customer", id: pin.id }, filters);
    const p = pin.params ?? {};
    const pick = <T extends string>(v: unknown, all: readonly T[]) => (typeof v === "string" && (all as readonly string[]).includes(v) ? (v as T) : undefined);
    const month = pick(p.month, MONTHS) ?? filters.month;
    const plan = pick(p.plan, PLANS);
    const region = pick(p.region, REGIONS);
    navigate({ screen: "overview" }, { month, ...(plan ? { plan } : {}), ...(region ? { region } : {}) });
  };
  const nav = (screen: Screen) => navigate({ screen }, filters);

  const tab = (screen: Screen, label: string, on: boolean) => (
    <button key={screen} type="button" onClick={() => nav(screen)} className={`cursor-pointer rounded-md border px-3 py-1.5 text-sm ${on ? "border-line bg-cream font-medium" : "border-transparent text-muted hover:text-foreground"}`}>
      {label}
    </button>
  );

  return (
    <div className="flex flex-1 flex-col">
      <header className="sticky top-0 z-10 border-b border-line bg-background">
        <div className="mx-auto flex w-full max-w-7xl flex-wrap items-center gap-x-4 gap-y-2 px-5 py-3">
          <AppLink href="/" className="flex items-center gap-2.5">
            <LogoMark />
            <span className="text-sm font-semibold tracking-tight">Pulse</span>
            <span className="hidden font-mono text-[11px] uppercase tracking-[0.06em] text-muted sm:inline">APC demo</span>
          </AppLink>
          <nav className="flex flex-wrap gap-1">
            {tab("howto", "How-to", route.screen === "howto")}
            {tab("overview", "Overview", route.screen === "overview")}
            {tab("customers", "Customers", route.screen === "customers" || route.screen === "customer")}
            {tab("agents", "Agents", route.screen === "agents")}
          </nav>
          {hubMode ? (
            // APC v2 (TIN-394): the standard agent bar. apc.tineira.com keeps its own marks below.
            <AgentBar
              agents={barAgents}
              onOpen={(id) => {
                const pin = state.grants.find((g) => g.id === id)?.pin;
                if (pin) openPin(pin);
              }}
              onUnpin={(id) => void api.unpin(id)}
              onWarning={() => nav("agents")}
            />
          ) : (
            <div className="marks">
            {state.grants.map((g) => {
              const last = Math.max(Date.parse(g.last_active_at ?? "") || 0, pulse[g.id] ?? 0);
              const status = markState(last ? new Date(last).toISOString() : null);
              const pulsing = pulse[g.id] && Date.now() - pulse[g.id]! < 1500;
              const motion = motionOf(g.id);
              return (
                <div key={g.id} className="mark-wrap">
                  <button
                    data-apc-mark
                    data-grant={g.id}
                    className={`mark mark-logo mark-${status}${pulsing ? " mark-pulse" : ""}${g.regions ? " mark-restricted" : ""}`}
                    title={`${names.get(g.id)}${g.client_name ? "" : " (not connected yet)"}. Drag onto anything to point this agent.`}
                    aria-label={names.get(g.id)}
                  >
                    <AgentIcon clientName={g.client_name} clientUa={g.client_ua} clientIcon={g.client_icon} motion={motion} />
                  </button>
                  {activeConflict(g) && (
                    <button type="button" className="mark-alert" onClick={() => nav("agents")} title={`${productName(activeConflict(g)!.client_name, activeConflict(g)!.user_agent)} is using ${names.get(g.id)}'s URL. Open Agents to give it its own.`} aria-label={`Another agent is using ${names.get(g.id)}'s URL`}>
                      !
                    </button>
                  )}
                  {g.pin && (
                    <span className="pin-dot">
                      <button
                        type="button"
                        className={`pin-dot-go${isSeen(g.pin) ? " seen" : ""}${onScreen.has(g.id) ? "" : " away"}`}
                        onClick={() => !onScreen.has(g.id) && openPin(g.pin!)}
                        title={`Pinned to ${pinLabel(g.pin)}: ${isSeen(g.pin) ? "your agent read it" : "waiting for your agent's next call"}${onScreen.has(g.id) ? "" : ". Click to open it."}`}
                        aria-label={`${names.get(g.id)} pinned to ${pinLabel(g.pin)}${isSeen(g.pin) ? ", read" : ", not read yet"}`}
                      />
                      <button className="unpin" onClick={() => void api.unpin(g.id)} aria-label="Remove pin">
                        ×
                      </button>
                    </span>
                  )}
                </div>
              );
            })}
            </div>
          )}
          {hubMode && (
            <a
              href={`${SIGNALS_ORIGIN}/?seed=${state.seed}`}
              target="_blank"
              rel="noreferrer"
              className="rounded-md border border-line px-2.5 py-1 text-sm text-muted hover:text-foreground"
              title="APC v2: Signals, the market around this sandbox (competitor offers and our ads), built from the same seed"
            >
              Signals
            </a>
          )}
          {v2 && (
            <button
              type="button"
              onClick={() => openDock(hubMode)}
              className="cursor-pointer rounded-md border border-line px-2.5 py-1 text-sm text-muted hover:text-foreground"
              title={hubMode ? "APC v2: open your agent dock, and drag an agent from it onto Pulse" : "APC v2: open a dock window with your agents, and drag them back onto Pulse from there"}
            >
              Dock
            </button>
          )}
          <ThemeToggle />
        </div>
      </header>
      {notice && (
        <div className="mx-auto mt-3 w-full max-w-7xl px-5">
          <div className="rounded-lg border border-filament/40 bg-filament-soft px-3 py-2 text-sm">{notice}</div>
        </div>
      )}
      <main className={`mx-auto flex w-full flex-1 flex-col gap-4 px-5 py-8 ${route.screen === "howto" ? "max-w-4xl" : "max-w-7xl"}`}>
        {route.screen === "overview" && <Overview sid={sid} state={state} data={data} filters={filters} onFilters={(f) => navigate(route, f)} />}
        {route.screen === "customers" && <Customers sid={sid} state={state} data={data} filters={filters} onFilters={(f) => navigate(route, f)} onOpen={(id) => navigate({ screen: "customer", id }, filters)} />}
        {route.screen === "customer" && <CustomerDetail sid={sid} state={state} data={data} id={route.id} onBack={() => navigate({ screen: "customers" }, filters)} />}
        {route.screen === "howto" && <HowTo api={api} sid={sid} state={state} initials={initials} activity={activity} onChanged={() => void refresh()} />}
        {route.screen === "agents" && <Agents api={api} sid={sid} state={state} initials={initials} activity={activity} onChanged={() => void refresh()} />}
      </main>
      <Tour api={api} state={state} names={names} screen={route.screen} onOverview={() => navigate({ screen: "overview" }, filters)} onChanged={() => void refresh()} />
      {pendingDrop && (
        <HubConsent
          api={api}
          drop={pendingDrop}
          onDone={(message) => {
            setPendingDrop(null);
            if (message) {
              setNotice(message);
              setTimeout(() => setNotice(null), 8000);
            }
            void refresh();
          }}
        />
      )}
      <PinBadges grants={state.grants} motionOf={motionOf} onUnpin={(id) => void api.unpin(id)} onPlaced={setOnScreen} />
    </div>
  );
}
