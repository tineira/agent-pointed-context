import { useMemo, useState } from "react";
import { MONTHS, PLANS, REGIONS, type Dataset, type Plan, type Region } from "../model/seed.ts";
import { mrrCsv } from "../user-side/mrr.ts";
import { mcpUrl, type Api, type GrantState, type SandboxState } from "./api.ts";
import { ActiveCustomersChart, CustomerBridge } from "./charts.tsx";
import { customerFocus } from "./focus.ts";

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

export function Overview(props: { data: Dataset; filters: Filters; onFilters: (f: Filters) => void }) {
  const { data, filters } = props;
  return (
    <>
      <FilterBar filters={filters} onChange={props.onFilters} />
      <section className="card">
        <h2>Active customers per month</h2>
        <p className="hint">Drag your agent's mark onto a bar and ask about it.</p>
        <ActiveCustomersChart data={data} month={filters.month} {...(filters.plan ? { plan: filters.plan } : {})} {...(filters.region ? { region: filters.region } : {})} onMonth={(month) => props.onFilters({ ...filters, month })} />
      </section>
      <section className="card">
        <h2>Customer bridge, {filters.month}</h2>
        <p className="hint">From last month's active customers to this month's. Every step is pointable.</p>
        <CustomerBridge data={data} month={filters.month} {...(filters.region ? { region: filters.region } : {})} />
      </section>
    </>
  );
}

export function Customers(props: { data: Dataset; filters: Filters; onFilters: (f: Filters) => void; onOpen: (id: string) => void }) {
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

export function CustomerDetail(props: { data: Dataset; id: string; onBack: () => void }) {
  const customer = props.data.customers.find((c) => c.id === props.id);
  if (!customer) return <p>No such customer.</p>;
  const activity = props.data.activity.filter((a) => a.customer_id === customer.id);
  const max = Math.max(1, ...activity.map((a) => a.seats));
  return (
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
  );
}

function Copy(props: { text: string }) {
  const [done, setDone] = useState(false);
  return (
    <div className="copy">
      <code>{props.text}</code>
      <button
        onClick={() => {
          void navigator.clipboard.writeText(props.text);
          setDone(true);
          setTimeout(() => setDone(false), 1500);
        }}
      >
        {done ? "Copied" : "Copy"}
      </button>
    </div>
  );
}

export function Connect(props: { api: Api; sid: string; state: SandboxState; initials: Map<string, string>; onChanged: () => void }) {
  const { api, sid, state } = props;
  const download = () => {
    const blob = new Blob([mrrCsv(state.seed)], { type: "text/csv" });
    const link = document.createElement("a");
    link.href = URL.createObjectURL(blob);
    link.download = "mrr-by-customer.csv";
    link.click();
    URL.revokeObjectURL(link.href);
  };
  const hasRestricted = state.grants.some((g) => g.regions);
  return (
    <>
      <section className="card">
        <h2>1. Connect your own agent</h2>
        <p>Paste this URL as a remote MCP server (Streamable HTTP) in any agent that supports one. The secret in the URL is this agent's access to your sandbox; it expires with the sandbox.</p>
        {state.grants.map((g: GrantState) => (
          <div key={g.id} className="grant">
            <h3>
              <span className="mark-inline">{props.initials.get(g.id)}</span> {g.label}
              {g.client_name && <span className="muted"> · connected as {g.client_name}</span>}
            </h3>
            <Copy text={mcpUrl(sid, g)} />
            <p className="hint">Claude Code:</p>
            <Copy text={`claude mcp add --transport http pulse${g.regions ? "-restricted" : ""} ${mcpUrl(sid, g)}`} />
          </div>
        ))}
        {!hasRestricted && (
          <button
            onClick={async () => {
              await api.addRestricted("latam");
              props.onChanged();
            }}
          >
            Add a restricted agent (LATAM only)
          </button>
        )}
        <p className="hint">A restricted agent shows that pointing grants no access: point it at a figure over all regions and it answers for LATAM only, and says so.</p>
      </section>
      <section className="card">
        <h2>2. Bring what you know</h2>
        <p>
          Pulse knows customers, plans, seats and activity. It does not know revenue. In real life you would have that in your billing system or a spreadsheet and keep it to yourself. Here, this file stands in for it. Give it to your agent, not to Pulse: Pulse never sees it.
        </p>
        <button onClick={download}>Download mrr-by-customer.csv</button>
      </section>
      <section className="card">
        <h2>3. Point and ask</h2>
        <p>Drag your agent's mark (top right) onto a bar, a step of the bridge or a customer row. Then ask your agent, for example:</p>
        <ul>
          <li>"How much MRR is this, and which customer has the best MRR per seat?"</li>
          <li>"Why did this step go up?"</li>
        </ul>
      </section>
      <section className="card">
        <h2>Switches and measurements</h2>
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
          Every tool call, pin and envelope is logged in this sandbox: <a href={api.eventsUrl}>events.jsonl</a>. The sandbox and its log are deleted {new Date(state.expires_at).toLocaleString()}.
        </p>
      </section>
    </>
  );
}
