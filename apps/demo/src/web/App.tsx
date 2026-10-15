import { canonicalTarget, parseFocusAttrs, type FocusTarget } from "@apc/protocol";
import { createViewReporter, enablePinning, flashTargets, initials as initialsOf, markState } from "@apc/web";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { LAST_MONTH, MONTHS, PLANS, REGIONS, type Dataset, type Plan, type Region } from "../model/seed.ts";
import { createApi, openSession, type Api, type SandboxState } from "./api.ts";
import { HowTo } from "./howto.tsx";
import { Agents, CustomerDetail, Customers, Overview, type Filters } from "./pages.tsx";

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
  const path = route.screen === "customer" ? `/customers/${route.id}` : `/${route.screen}`;
  const q = new URLSearchParams();
  if (route.screen === "overview" || route.screen === "customers" || route.screen === "customer") {
    q.set("month", filters.month);
    if (filters.plan) q.set("plan", filters.plan);
    if (filters.region) q.set("region", filters.region);
  }
  const next = `${path}${q.size ? `?${q}` : ""}`;
  if (next !== `${location.pathname}${location.search}`) history.pushState(null, "", next);
}

export function App() {
  const [sid, setSid] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    openSession().then(setSid, (e: unknown) => setError(String(e)));
  }, []);
  if (error) return <p className="boot">Could not open a sandbox: {error}</p>;
  if (!sid) return <p className="boot">Opening your sandbox…</p>;
  return <Sandbox sid={sid} />;
}

function Sandbox({ sid }: { sid: string }) {
  const api: Api = useMemo(() => createApi(sid), [sid]);
  const [state, setState] = useState<SandboxState | null>(null);
  const [data, setData] = useState<Dataset | null>(null);
  const [{ route, filters }, setNav] = useState(readRoute);
  const [pulse, setPulse] = useState<Record<string, number>>({});
  const [notice, setNotice] = useState<string | null>(null);
  const [, tick] = useState(0);
  const stateRef = useRef<SandboxState | null>(null);
  stateRef.current = state;

  const refresh = useCallback(() => api.state().then(setState), [api]);
  useEffect(() => {
    void refresh();
    void api.data().then(setData);
  }, [api, refresh]);

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
  const initialsRef = useRef(initials);
  initialsRef.current = initials;

  // Presence and pin updates from the sandbox.
  useEffect(
    () =>
      api.connect((message) => {
        if (message.type === "presence") {
          setPulse((p) => ({ ...p, [message.event.grant_id]: Date.now() }));
          if (stateRef.current?.settings.show_activity) flashTargets(message.event, initialsRef.current.get(message.event.grant_id) ?? "AG");
        } else if (message.type === "pin") {
          setState((s) => (s ? { ...s, grants: s.grants.map((g) => (g.id === message.grant_id ? { ...g, pin: message.pin } : g)) } : s));
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
        canTarget: (grantId, target: FocusTarget) => {
          const grant = stateRef.current?.grants.find((g) => g.id === grantId);
          if (!grant?.regions) return true;
          if (target.kind === "customer" && target.id) return grant.regions.includes(regionOf.get(target.id)!);
          const region = target.params?.region;
          return typeof region !== "string" || grant.regions.includes(region as Region);
        },
        onPin: async (grantId, target) => {
          const result = await api.pin(grantId, target);
          setNotice(result.ok ? `Pinned ${initialsRef.current.get(grantId)}. Now ask your agent about "this".` : `Not pinned: ${result.error}`);
          setTimeout(() => setNotice(null), 4000);
        },
      }),
    [api, regionOf],
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

  if (!state || !data) return <p className="boot">Loading…</p>;
  const nav = (screen: Screen) => navigate({ screen }, filters);

  return (
    <div className="app">
      <header className="topbar">
        <div className="brand">
          <span className="logo">Pulse</span>
          <span className="tag">Agent Pointed Context demo</span>
        </div>
        <nav>
          <button className={route.screen === "howto" ? "on" : ""} onClick={() => nav("howto")}>
            How to
          </button>
          <button className={route.screen === "overview" ? "on" : ""} onClick={() => nav("overview")}>
            Overview
          </button>
          <button className={route.screen === "customers" || route.screen === "customer" ? "on" : ""} onClick={() => nav("customers")}>
            Customers
          </button>
          <button className={route.screen === "agents" ? "on" : ""} onClick={() => nav("agents")}>
            Agents
          </button>
        </nav>
        <div className="marks">
          {state.grants.map((g) => {
            const last = Math.max(Date.parse(g.last_active_at ?? "") || 0, pulse[g.id] ?? 0);
            const status = markState(last ? new Date(last).toISOString() : null);
            const pulsing = pulse[g.id] && Date.now() - pulse[g.id]! < 1500;
            return (
              <div key={g.id} className="mark-wrap">
                <button
                  data-apc-mark
                  data-grant={g.id}
                  className={`mark mark-${status}${pulsing ? " mark-pulse" : ""}${g.regions ? " mark-restricted" : ""}`}
                  title={`${g.label}${g.client_name ? ` (${g.client_name})` : " (not connected yet)"}. Drag onto anything to point this agent.`}
                >
                  {initials.get(g.id)}
                </button>
                {g.pin && (
                  <span className={g.pin.seen_at && g.pin.seen_at >= g.pin.pinned_at ? "pin seen" : "pin"} title={g.pin.seen_at ? "Your agent read the pin" : "Waiting for your agent's next call"}>
                    {g.pin.seen_at && g.pin.seen_at >= g.pin.pinned_at ? "seen" : "pinned"}
                    <button className="unpin" onClick={() => void api.unpin(g.id)} aria-label="Remove pin">
                      ×
                    </button>
                  </span>
                )}
              </div>
            );
          })}
        </div>
      </header>
      {notice && <div className="notice">{notice}</div>}
      <main>
        {route.screen === "overview" && <Overview data={data} filters={filters} onFilters={(f) => navigate(route, f)} />}
        {route.screen === "customers" && <Customers data={data} filters={filters} onFilters={(f) => navigate(route, f)} onOpen={(id) => navigate({ screen: "customer", id }, filters)} />}
        {route.screen === "customer" && <CustomerDetail data={data} id={route.id} onBack={() => navigate({ screen: "customers" }, filters)} />}
        {route.screen === "howto" && <HowTo api={api} sid={sid} state={state} initials={initials} onChanged={() => void refresh()} go={nav} />}
        {route.screen === "agents" && <Agents api={api} sid={sid} state={state} initials={initials} onChanged={() => void refresh()} />}
      </main>
      <footer>
        Synthetic data. Pulse holds no revenue. Paper: <a href="https://doi.org/10.5281/zenodo.23382909">Agent Pointed Context</a>.
      </footer>
    </div>
  );
}
