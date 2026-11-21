/**
 * The hero's chart (TIN-1070): active customers per month, the months the landing's simulated hero shows, computed
 * from Pulse's demo world with the function get_figure answers with (activeCustomers, the Overview's chart). Each bar is
 * a pointable figure, `active_customers` for its month, the same target the full app's chart pins.
 */
import { figureFocus } from "../focus.ts";
import { CHART_TOP, monthName, monthShort } from "./months.ts";

export { heroSeries, monthName, monthShort } from "./months.ts";

export function HeroChart(props: { series: Array<{ month: string; value: number }>; pinned: string | null; lit: string | null }) {
  const top = Math.max(CHART_TOP, ...props.series.map((s) => s.value));
  return (
    <>
      <div className="chart">
        <span className="grid-line" data-at="100" aria-hidden="true" style={{ bottom: `calc((100% - 40px) * ${100 / top})` }}>
          <b>100</b>
        </span>
        <span className="grid-line" data-at="50" aria-hidden="true" style={{ bottom: `calc((100% - 40px) * ${50 / top})` }}>
          <b>50</b>
        </span>
        {props.series.map((s) => (
          <div
            key={s.month}
            className={`bar${props.pinned === s.month ? " is-pinned" : ""}`}
            style={{ height: `${((s.value / top) * 100).toFixed(2)}%` }}
            role="img"
            aria-label={`${monthName(s.month)}: ${s.value} active customers`}
            title={`${monthName(s.month)}: ${s.value} active customers`}
            data-apc-presence={props.lit === s.month ? "read" : undefined}
            {...figureFocus("active_customers", { month: s.month })}
          />
        ))}
      </div>
      <div className="months" aria-hidden="true">
        {props.series.map((s) => (
          <span key={s.month} className={props.pinned === s.month ? "is-on" : undefined}>
            {monthShort(s.month)}
          </span>
        ))}
      </div>
    </>
  );
}
