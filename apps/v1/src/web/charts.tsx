import { activeCustomers, BRIDGE_STEPS, customerBridge, FULL_SCOPE } from "../model/figures.ts";
import type { Dataset, Plan, Region } from "../model/seed.ts";
import { figureFocus } from "./focus.ts";

const short = (month: string) => {
  const [y, m] = month.split("-");
  return `${["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"][Number(m) - 1]} ${y!.slice(2)}`;
};

/** Active customers per month: one pointable bar per month. Same function as get_figure. */
export function ActiveCustomersChart(props: { data: Dataset; month: string; plan?: Plan; region?: Region; onMonth: (month: string) => void }) {
  const { data, month, plan, region } = props;
  const series = activeCustomers(data, { month, ...(plan ? { plan } : {}), ...(region ? { region } : {}) }, FULL_SCOPE).series!;
  const max = Math.max(1, ...series.map((s) => s.value));
  const w = 720;
  const h = 220;
  const pad = { top: 16, bottom: 28, left: 8, right: 8 };
  const slot = (w - pad.left - pad.right) / series.length;
  const bar = slot * 0.68;
  return (
    <svg viewBox={`0 0 ${w} ${h}`} className="chart" role="img" aria-label="Active customers per month">
      {series.map((s, i) => {
        const bh = ((h - pad.top - pad.bottom) * s.value) / max;
        const x = pad.left + i * slot + (slot - bar) / 2;
        const y = h - pad.bottom - bh;
        return (
          <g key={s.month} {...figureFocus("active_customers", { month: s.month, plan, region })} className="focusable" onClick={() => props.onMonth(s.month)}>
            <title>{`${short(s.month)}: ${s.value} active customers`}</title>
            <rect x={pad.left + i * slot} y={pad.top} width={slot} height={h - pad.top - pad.bottom} className="hit" />
            <rect x={x} y={y} width={bar} height={bh} rx={2} className={s.month === month ? "bar bar-selected" : "bar"} />
            {s.month === month && (
              <text x={x + bar / 2} y={y - 4} textAnchor="middle" className="value">
                {s.value}
              </text>
            )}
            {i % 3 === 0 && (
              <text x={x + bar / 2} y={h - 10} textAnchor="middle" className="axis">
                {short(s.month)}
              </text>
            )}
          </g>
        );
      })}
    </svg>
  );
}

/** From last month's active customers to this month's: five pointable steps. The whole bridge is its card (pages.tsx). */
export function CustomerBridge(props: { data: Dataset; month: string; region?: Region }) {
  const { data, month, region } = props;
  const { values } = customerBridge(data, { month, ...(region ? { region } : {}) }, FULL_SCOPE);
  const w = 720;
  const h = 200;
  const pad = { top: 18, bottom: 28 };
  const top = Math.max(1, values.start! + values.new! + values.reactivated!, values.end!);
  const scale = (n: number) => ((h - pad.top - pad.bottom) * n) / top;
  const slot = w / BRIDGE_STEPS.length;
  const bar = slot * 0.56;
  let level = 0;
  const labels: Record<string, string> = { start: "Start", new: "New", reactivated: "Reactivated", churned: "Churned", end: "End" };
  return (
    <svg viewBox={`0 0 ${w} ${h}`} className="chart" role="img" aria-label="Customer bridge">
      <g>
        {BRIDGE_STEPS.map((step, i) => {
          const n = values[step]!;
          let from = 0;
          let to = n;
          if (step === "new" || step === "reactivated") {
            from = level;
            to = level + n;
          } else if (step === "churned") {
            from = level - n;
            to = level;
          }
          level = step === "start" || step === "end" ? n : step === "churned" ? level - n : level + n;
          const x = i * slot + (slot - bar) / 2;
          const y = h - pad.bottom - scale(to);
          const bh = Math.max(1, scale(to) - scale(from));
          return (
            <g key={step} {...figureFocus("customer_bridge", { month, region }, `step:${step}`)} className="focusable">
              <title>{`${labels[step]}: ${n}`}</title>
              <rect x={i * slot} y={pad.top} width={slot} height={h - pad.top - pad.bottom} className="hit" />
              <rect x={x} y={y} width={bar} height={bh} rx={2} className={`bar bar-${step}`} />
              <text x={x + bar / 2} y={y - 5} textAnchor="middle" className="value">
                {step === "churned" ? `−${n}` : step === "new" || step === "reactivated" ? `+${n}` : n}
              </text>
              <text x={x + bar / 2} y={h - 10} textAnchor="middle" className="axis">
                {labels[step]}
              </text>
            </g>
          );
        })}
      </g>
    </svg>
  );
}
