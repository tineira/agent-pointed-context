import { useEffect, useMemo, useState } from "react";
import { MONTHS, PLANS, REGIONS, type Dataset, type Plan, type Region } from "../model/seed.ts";
import { buildMarket } from "../model/market.ts";
import { mrrCsv } from "../user-side/mrr.ts";
import { displayNames } from "./agent-brands.ts";
import { AgentIcon } from "./agent-icon.tsx";
import type { Api, CompatRow, SandboxState } from "./api.ts";
import { AddAgentButtons, AgentCard, ConnectPanel } from "./connect.tsx";
import { ActiveCustomersChart, CustomerBridge } from "./charts.tsx";
import { customerFocus, figureFocus } from "./focus.ts";

export interface Filters {
  month: string;
  plan?: Plan;
  region?: Region;
}

export function FilterBar(props: { filters: Filters; onChange: (f: Filters) => void; showPlan?: boolean }) {
  const { filters, onChange } = props;
  return (
    <div className="filters">
      <label>
        Month
        <select value={filters.month} onChange={(e) => onChange({ ...filters, month: e.target.value })}>
          {MONTHS.map((m) => (
            <option key={m}>{m}</option>
          ))}
        </select>
      </label>
      {props.showPlan !== false && (
        <label>
          Plan
          <select value={filters.plan ?? ""} onChange={(e) => onChange({ ...filters, plan: (e.target.value || undefined) as Plan | undefined })}>
            <option value="">All plans</option>
            {PLANS.map((p) => (
              <option key={p}>{p}</option>
            ))}
          </select>
        </label>
      )}
      <label>
        Region
        <select value={filters.region ?? ""} onChange={(e) => onChange({ ...filters, region: (e.target.value || undefined) as Region | undefined })}>
          <option value="">All regions</option>
          {REGIONS.map((r) => (
            <option key={r}>{r}</option>
          ))}
        </select>
      </label>
    </div>
  );
}

export function Overview(props: { sid: string; state: SandboxState; data: Dataset; filters: Filters; onFilters: (f: Filters) => void }) {
  const { data, filters } = props;
  return (
    <>
      <ConnectPanel sid={props.sid} state={props.state} />
      <FilterBar filters={filters} onChange={props.onFilters} />
      <section className="card" {...figureFocus("active_customers", { month: filters.month, plan: filters.plan, region: filters.region }, "series")}>
        <h2>Active customers per month</h2>
        <p className="hint">Drag your agent's mark onto a bar, or onto the chart for the whole trend, and ask about it.</p>
        <ActiveCustomersChart data={data} month={filters.month} {...(filters.plan ? { plan: filters.plan } : {})} {...(filters.region ? { region: filters.region } : {})} onMonth={(month) => props.onFilters({ ...filters, month })} />
      </section>
      <section className="card" {...figureFocus("customer_bridge", { month: filters.month, region: filters.region })}>
        <h2>Customer bridge, {filters.month}</h2>
        <p className="hint">From last month's active customers to this month's. Every step is pointable, and so is the whole bridge.</p>
        <CustomerBridge data={data} month={filters.month} {...(filters.region ? { region: filters.region } : {})} />
      </section>
    </>
  );
}

export function Customers(props: { sid: string; state: SandboxState; data: Dataset; filters: Filters; onFilters: (f: Filters) => void; onOpen: (id: string) => void }) {
  const { data, filters } = props;
  const rows = useMemo(() => {
    const at = new Map(data.activity.filter((a) => a.month === filters.month).map((a) => [a.customer_id, a]));
    return data.customers
      .filter((c) => (!filters.plan || c.plan === filters.plan) && (!filters.region || c.region === filters.region))
      .map((c) => ({ ...c, activity: at.get(c.id) }))
      .filter((c) => c.activity);
  }, [data, filters]);
  return (
    <>
      <ConnectPanel sid={props.sid} state={props.state} />
      <FilterBar filters={filters} onChange={props.onFilters} />
      <section className="card">
        <h2>
          Customers in {filters.month} <span className="muted">{rows.length}</span>
        </h2>
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Customer</th>
                <th>Plan</th>
                <th>Region</th>
                <th className="num">Seats</th>
                <th>Status</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((c) => (
                <tr key={c.id} {...customerFocus(c.id)} onClick={() => props.onOpen(c.id)}>
                  <td>
                    <span className="mono">{c.id}</span> {c.name}
                  </td>
                  <td {...customerFocus(c.id, "plan")}>{c.plan}</td>
                  <td>{c.region}</td>
                  <td className="num" {...customerFocus(c.id, "seats")}>
                    {c.activity!.seats}
                  </td>
                  <td {...customerFocus(c.id, "status")}>{c.activity!.active ? "active" : "inactive"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>
    </>
  );
}

export function CustomerDetail(props: { sid: string; state: SandboxState; data: Dataset; id: string; onBack: () => void }) {
  const customer = props.data.customers.find((c) => c.id === props.id);
  if (!customer) return <p>No such customer.</p>;
  const activity = props.data.activity.filter((a) => a.customer_id === customer.id);
  const max = Math.max(1, ...activity.map((a) => a.seats));
  return (
    <>
      <ConnectPanel sid={props.sid} state={props.state} />
      <section className="card" {...customerFocus(customer.id)}>
        <button className="link" onClick={props.onBack}>
          ← Customers
        </button>
        <h2>
          {customer.name} <span className="mono muted">{customer.id}</span>
        </h2>
        <dl className="facts">
          <div {...customerFocus(customer.id, "plan")}>
            <dt>Plan</dt>
            <dd>{customer.plan}</dd>
          </div>
          <div>
            <dt>Region</dt>
            <dd>{customer.region}</dd>
          </div>
          <div>
            <dt>Signed up</dt>
            <dd>{customer.signup_month}</dd>
          </div>
          {props.state.v2 && (
            <div>
              <dt>Signup code</dt>
              <dd className="mono">{buildMarket(props.data).signupCodes.get(customer.id) ?? "none"}</dd>
            </div>
          )}
        </dl>
        <h3 {...customerFocus(customer.id, "seats")}>Seats per month</h3>
        <div className="spark">
          {activity.map((a) => (
            <div key={a.month} className="spark-col" title={`${a.month}: ${a.active ? `${a.seats} seats, ${a.events} events` : "inactive"}`}>
              <div className={a.active ? "spark-bar" : "spark-bar inactive"} style={{ height: `${Math.max(2, (a.seats / max) * 100)}%` }} />
            </div>
          ))}
        </div>
      </section>
    </>
  );
}

/** Download the person's own file. The browser makes it from the seed; Pulse's server has no MRR code. */
export function DownloadCsv(props: { seed: number }) {
  const download = () => {
    const blob = new Blob([mrrCsv(props.seed)], { type: "text/csv" });
    const link = document.createElement("a");
    link.href = URL.createObjectURL(blob);
    link.download = "mrr-by-customer.csv";
    link.click();
    URL.revokeObjectURL(link.href);
  };
  return (
    <button type="button" onClick={download} className="inline-flex min-h-9 cursor-pointer items-center rounded-lg border border-line bg-background px-3 text-sm font-medium text-foreground hover:border-filament">
      Download mrr-by-customer.csv
    </button>
  );
}

const ms = (v: number | null) => (v === null ? "–" : v < 10_000 ? `${(v / 1000).toFixed(1)} s` : `${Math.round(v / 1000)} s`);
const yes = (ok: boolean) => (ok ? "yes" : "–");

/**
 * The client compatibility matrix, from this sandbox's event log. No polling: it reloads when the
 * sandbox announces activity on the page's WebSocket (refreshKey), at most once a second, and
 * when the tab comes back into view.
 */
export function CompatTable(props: { api: Api; initials: Map<string, string>; grants: SandboxState["grants"]; refreshKey: unknown }) {
  const [rows, setRows] = useState<CompatRow[] | null>(null);
  useEffect(() => {
    let live = true;
    const load = () => {
      // The first load always runs; later reloads wait until the tab is in view.
      if (!rows || document.visibilityState === "visible") void props.api.compat().then((r) => live && setRows(r), () => undefined);
    };
    const timer = setTimeout(load, rows ? 1000 : 0);
    document.addEventListener("visibilitychange", load);
    return () => {
      live = false;
      clearTimeout(timer);
      document.removeEventListener("visibilitychange", load);
    };
    // rows only decides the first load's delay
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [props.api, props.refreshKey]);
  if (!rows) return <p className="hint">Loading…</p>;
  return (
    <div className="table-wrap">
      <table className="compat">
        <thead>
          <tr>
            <th>Agent</th>
            <th>Client</th>
            <th>Connected</th>
            <th title="The person loaded the guide prompt in their client">Read the guide</th>
            <th className="num">Calls</th>
            <th className="num">Pins</th>
            <th className="num">Envelopes</th>
            <th>Read the pin with</th>
            <th>After an envelope</th>
            <th>Followed next</th>
            <th title="wait_for_focus calls that started within 30 s after another tool call">Waited after answering</th>
            <th className="num">Pin → read</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.grant_id}>
              <td>
                <span className="mark-inline">{props.initials.get(r.grant_id)}</span> {displayNames(props.grants).get(r.grant_id) ?? r.label}
              </td>
              <td title={r.user_agent ?? ""}>
                {r.client_name ? (
                  <span className="inline-flex items-center gap-1.5">
                    <AgentIcon clientName={r.client_name} clientUa={r.user_agent} clientIcon={props.grants.find((g) => g.id === r.grant_id)?.client_icon} size={16} />
                    {`${r.client_name}${r.client_version ? ` ${r.client_version}` : ""}`}
                  </span>
                ) : (
                  "–"
                )}
              </td>
              <td>{yes(r.connected)}</td>
              <td>{yes(r.read_guide)}</td>
              <td className="num">{r.tool_calls}</td>
              <td className="num">{r.pins}</td>
              <td className="num">{r.envelopes}</td>
              <td>
                {r.pins_read === 0
                  ? "–"
                  : [r.read_via.get_current_view && `get_current_view ×${r.read_via.get_current_view}`, r.read_via.wait_for_focus && `wait_for_focus ×${r.read_via.wait_for_focus}`].filter(Boolean).join(", ")}
              </td>
              <td>{r.pins_read ? `${r.read_after_envelope} of ${r.pins_read}` : "–"}</td>
              <td>{r.pins ? `${r.next_reads} of ${r.pins}` : "–"}</td>
              <td>{r.wait_calls ? `${r.waits_after_answer} of ${r.wait_calls} waits` : "–"}</td>
              <td className="num">{ms(r.median_pin_to_seen_ms)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function Agents(props: { api: Api; sid: string; state: SandboxState; initials: Map<string, string>; activity: number; onChanged: () => void }) {
  const { api, sid, state } = props;
  const names = displayNames(state.grants);
  return (
    <>
      <section className="card">
        <h2>Your agents</h2>
        <p>
          Each agent gets its own URL and its own mark. Paste a URL as a remote MCP server (Streamable HTTP) in your agent, or scan its QR and paste that same URL into an agent on a phone. The secret in the URL is that agent's read access to this sandbox; it expires with the sandbox. Using several
          agents? Give each one its own URL, so you can see which one answered.
        </p>
        {state.grants.map((g) => (
          <AgentCard
            key={g.id}
            sid={sid}
            grant={g}
            name={names.get(g.id) ?? g.label}
            initials={props.initials.get(g.id)}
            manual
            onRename={async (name) => {
              await api.rename(g.id, name);
              props.onChanged();
            }}
            onConflict={async (action) => {
              const result = await api.resolveConflict(g.id, action);
              props.onChanged();
              return result.grant;
            }}
          />
        ))}
        <AddAgentButtons api={api} state={state} onChanged={props.onChanged} />
        <p className="hint">A restricted agent shows that pointing grants no access: point it at a figure over all regions and it answers for LATAM only, and says so.</p>
      </section>
      <section className="card">
        <h2>What your agents did</h2>
        <p className="hint">From this sandbox's log: whether each agent connected, whether pins reached it, how it read them, and whether it made the call the pin named.</p>
        <CompatTable api={api} initials={props.initials} grants={props.state.grants} refreshKey={props.activity} />
      </section>
      <section className="card">
        <h2>Switches and log</h2>
        <label className="switch">
          <input
            type="checkbox"
            checked={state.settings.share_view}
            onChange={async (e) => {
              await api.setting("share_view", e.target.checked);
              props.onChanged();
            }}
          />
          Share my current view with my agents
        </label>
        <label className="switch">
          <input
            type="checkbox"
            checked={state.settings.show_activity}
            onChange={async (e) => {
              await api.setting("show_activity", e.target.checked);
              props.onChanged();
            }}
          />
          Show agent activity on screen
        </label>
        <p>
          Every tool call, pin and envelope is logged in this sandbox: <a href={api.eventsUrl}>events.jsonl</a>. The sandbox and its log are deleted {new Date(state.expires_at).toLocaleString()} unless you keep using it.
        </p>
      </section>
    </>
  );
}
