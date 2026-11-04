import { canonicalTarget, parseFocusAttrs, type FocusTarget } from "@tineira/apc-protocol";
import { createViewReporter, enablePinning, flashTargets, initials as initialsOf, loadApcProfiles, markState, mergePins, type DockUnsupported } from "@tineira/apc-web";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { generateDataset, LAST_MONTH, MONTHS, PLANS, REGIONS, type Dataset, type Plan, type Region } from "../model/seed.ts";
import { displayNames, motionFor, type AgentMotion } from "./agent-brands.ts";
import { AgentIcon } from "./agent-icon.tsx";
import { AgentBar, type PulseBarAgent } from "./agent-bar.tsx";
import { createApi, openSession, type Api, type SandboxState } from "./api.ts";
import { activeConflict } from "./connect.tsx";
import { HubConsent, type PendingDrop } from "./hub-consent.tsx";
import { productName } from "../model/products.ts";
import { DockHowTo } from "./dock-only.tsx";
import { HowTo } from "./howto.tsx";
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
  // ?start_over=1 (TIN-412): Start over lives on the Agents screen (Settings on the v2 deploy).
  if (url.pathname.startsWith("/agents") || url.pathname.startsWith("/connect") || q.has("start_over")) return { route: { screen: "agents" }, filters };
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

/** Pulse opens a sandbox for the visitor; it is paired with a dock, whose hub the page names. */
export function App() {
  return (
    <div className="flex min-h-svh flex-col">
      <SandboxGate />
      <SiteFooter />
    </div>
  );
}

function SandboxGate() {
  const [sid, setSid] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    // The open is shared (TIN-490); a gate that unmounted before it settled ignores the result.
    let live = true;
    openSession().then(
      (id) => live && setSid(id),
      (e: unknown) => live && setError(String(e)),
    );
    return () => {
      live = false;
    };
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
  // Pulse pairs with a dock's hub (TIN-382); the page has the dock's features on once the sandbox says so.
  const hubMode = !!state?.v2;
  const v2 = hubMode;
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
        // An agent from a hub dock (TIN-389): every drop goes to the server, which decides (TIN-606). One paired
        // here pins, once the dock says the pairing still stands; one not paired, or no longer, comes back
        // consent_required with a nonce, and the person is asked (hub-consent.tsx), never on this page's word.
        onUnknownAgent: hubMode
          ? async (drag, target) => {
              const r = await api.hubPair({ hub: drag.hub, agent: drag.agent, ticket: drag.ticket, region: null, target });
              if (r.error === "consent_required" && r.consent) {
                void refresh();
                return setPendingDrop({ drag, target, at: Date.now(), consent: r.consent });
              }
              setNotice(r.ok ? `Pinned ${namesRef.current.get(r.grant_id ?? "") ?? "your agent"}. Now ask it about "this".` : `Not pinned: ${r.error}`);
              setTimeout(() => setNotice(null), 4000);
              void refresh();
            }
          : undefined,
        // APC 0.5: a Pulse that offers only Direct answers a dock agent's drop with how to connect directly, and
        // opens the Agents screen, where the person does. Its profiles come from its own apc.json (servedProfiles),
        // so a drop before the page's state has loaded is answered right too (held until the file is read).
        profiles: () => loadApcProfiles(),
        direct: { name: "Pulse", connect: `${location.origin}/agents` },
        onDockUnsupported: (answer: DockUnsupported) => {
          navigate({ screen: "agents" }, readRoute().filters);
          setNotice(answer.message);
          setTimeout(() => setNotice(null), 10_000);
        },
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
    [api, regionOf, v2, hubMode, navigate],
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

  if (!state || !data) return <p className="py-12 text-center text-sm text-muted">Loading…</p>;
  // The standard agent bar's agents (TIN-394), on Pulse's v2 deploy. Each shows the path it came by;
  // an agent linked across both (apc_link, APC 0.4) is one entry, under its Direct grant.
  const dockGrants = new Set((state.hub_links ?? []).map((l) => l.grant_id));
  const partners = new Map((state.links ?? []).flatMap(([d, k]) => [[d, k], [k, d]] as Array<[string, string]>));
  const shownUnder = new Set((state.links ?? []).map(([, k]) => k));
  const RANK: Record<AgentMotion, number> = { off: 0, idle: 1, seen: 2, waiting: 3, busy: 4 };
  const barAgents: PulseBarAgent[] = state.grants
    .filter((g) => !shownUnder.has(g.id))
    .map((g) => {
      const partner = partners.get(g.id);
      const other = partner ? state.grants.find((x) => x.id === partner) : undefined;
      const motion = [motionOf(g.id), ...(partner ? [motionOf(partner)] : [])].sort((a, b) => RANK[b] - RANK[a])[0]!;
      return {
        id: g.id,
        name: names.get(g.id) ?? g.label,
        client_name: g.client_name ?? other?.client_name ?? null,
        client_ua: g.client_ua,
        client_icon: g.client_icon ?? other?.client_icon ?? null,
        icon: g.client_icon,
        state: motion,
        // A linked agent holds two grants, so up to two pins: the bar shows both (TIN-607).
        pin: mergePins([g, other].map((x) => (x?.pin ? { label: pinLabel(x.pin), seen: isSeen(x.pin), here: onScreen.has(x.id) } : null))),
        warning: activeConflict(g) ? `${productName(activeConflict(g)!.client_name, activeConflict(g)!.user_agent)} is using ${names.get(g.id)}'s URL. Open Agents to give it its own.` : null,
        restricted: !!g.regions,
        paths: partner ? ["direct", "dock"] : dockGrants.has(g.id) ? ["dock"] : ["direct"],
      };
    });
  const offersDirect = !hubMode || !!state.profiles?.includes("direct");
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
            {tab("agents", offersDirect ? "Agents" : "Settings", route.screen === "agents")}
          </nav>
          {hubMode ? (
            // APC v2 (TIN-394): the standard agent bar. apc.tineira.com keeps its own marks below.
            <AgentBar
              agents={barAgents}
              onOpen={(id) => {
                // A linked agent has two grants and maybe two pins: open the one not on this page, else the first.
                const held = [id, partners.get(id)].flatMap((gid) => state.grants.filter((g) => g.id === gid && g.pin));
                const pin = (held.find((g) => !onScreen.has(g.id)) ?? held[0])?.pin;
                if (pin) openPin(pin);
              }}
              onUnpin={(id) => void Promise.all([id, partners.get(id)].flatMap((gid) => (gid ? [api.unpin(gid)] : [])))}
              onWarning={() => nav("agents")}
              onUnlink={(id) => void api.unlink(id).then(() => refresh())}
              onRevoke={(id) => {
                // Revoke from the app (APC 0.2): at once, here; the dock learns it on its next call.
                const name = names.get(id) ?? "Your agent";
                void api
                  .revoke(id)
                  .then(
                    (r) => (r.ok ? `Revoked ${name}: it can no longer read Pulse. To let it back, connect it again on the Agents screen, or drop it here again from your dock.` : `Not revoked: ${r.error}`),
                    (e: unknown) => `Not revoked: ${e instanceof Error ? e.message : String(e)}`,
                  )
                  .then((message) => {
                    setNotice(message);
                    setTimeout(() => setNotice(null), 8000);
                    void refresh();
                  });
              }}
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
        {route.screen === "howto" && (hubMode ? <DockHowTo state={state} /> : <HowTo api={api} sid={sid} state={state} initials={initials} activity={activity} onChanged={() => void refresh()} />)}
        {route.screen === "agents" && <Agents api={api} sid={sid} state={state} initials={initials} activity={activity} onChanged={() => void refresh()} />}
      </main>
      <Tour api={api} state={state} names={names} screen={route.screen} onOverview={() => navigate({ screen: "overview" }, filters)} onChanged={() => void refresh()} />
      {pendingDrop && (
        <HubConsent
          key={pendingDrop.consent}
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
