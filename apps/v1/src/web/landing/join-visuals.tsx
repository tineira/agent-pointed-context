/**
 * The join that happens in the person's agent: what Pulse returns for a figure (customer ids and
 * seats) next to what the person already knows (MRR per customer, in their own file), and the
 * answer neither side has alone. Illustrative numbers.
 */
import { CARD_HEADER } from "../ui.tsx";

const ROWS = [
  { id: "cus_0042", seats: 12, mrr: "1,204.37", per: "100.36" },
  { id: "cus_0107", seats: 4, mrr: "318.92", per: "79.73" },
  { id: "cus_0158", seats: 30, mrr: "2,087.10", per: "69.57" },
];

export function FileIcon({ className = "h-4 w-4" }: { className?: string }) {
  return (
    <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth={1.3} strokeLinejoin="round" aria-hidden="true" className={className}>
      <path d="M3.5 1.5h6l3 3v10h-9z" />
      <path d="M9.5 1.5v3h3" />
    </svg>
  );
}

/** The person's file, as a thing of its own: it stays on their side. */
export function FileCard({ compact = false }: { compact?: boolean }) {
  return (
    <div className="w-full overflow-hidden rounded-[10px] border border-foreground bg-cream text-left font-mono text-[11px]">
      <div className="flex items-center gap-1.5 border-b border-line px-3 py-2">
        <FileIcon className="h-3.5 w-3.5 shrink-0" />
        <span className="truncate">mrr-by-customer.csv</span>
      </div>
      {(compact ? ROWS.slice(0, 2) : ROWS).map((r) => (
        <div key={r.id} className="flex justify-between gap-3 px-3 py-1">
          <span>{r.id}</span>
          <span>{r.mrr}</span>
        </div>
      ))}
      <div className="border-t border-line px-3 py-1.5 text-[10px] uppercase tracking-[0.06em] text-filament">Yours · never sent to Pulse</div>
    </div>
  );
}

function Table(props: { label: string; sub: string; head: [string, string]; rows: Array<[string, string]>; accent?: boolean }) {
  return (
    <div className={`flex min-w-0 flex-col overflow-hidden rounded-[10px] border bg-background ${props.accent ? "border-filament" : "border-line"}`}>
      <div className="flex flex-col gap-0.5 border-b border-line px-3 py-2">
        <span className={`font-mono text-[10px] uppercase tracking-[0.08em] ${props.accent ? "text-filament" : "text-muted"}`}>{props.label}</span>
        <span className="text-[11px] text-muted">{props.sub}</span>
      </div>
      <div className="grid grid-cols-[1fr_auto] gap-x-3 px-3 py-1.5 font-mono text-[11px] text-muted">
        <span>{props.head[0]}</span>
        <span className="text-right">{props.head[1]}</span>
      </div>
      {props.rows.map(([a, b]) => (
        <div key={a} className="grid grid-cols-[1fr_auto] gap-x-3 border-t border-line px-3 py-1.5 font-mono text-[12px]">
          <span>{a}</span>
          <span className="text-right">{b}</span>
        </div>
      ))}
    </div>
  );
}

/** Pulse's side + the person's side = the answer, in the agent. */
export function JoinCard() {
  return (
    <article className="overflow-hidden rounded-[20px] border border-line bg-cream">
      <div className={CARD_HEADER}>
        <span>Joined in your agent · on customer_id</span>
        <span>Example</span>
      </div>
      <div className="bp-grid flex flex-col gap-3 p-[18px]">
        <div className="grid grid-cols-[minmax(0,1fr)_auto_minmax(0,1fr)] items-center gap-2">
          <Table label="From Pulse" sub="get_figure, under your agent's access" head={["customer_id", "seats"]} rows={ROWS.map((r) => [r.id, String(r.seats)])} />
          <span className="font-mono text-lg text-muted" aria-hidden="true">
            +
          </span>
          <Table label="From you" sub="mrr-by-customer.csv, never sent to Pulse" head={["customer_id", "mrr"]} rows={ROWS.map((r) => [r.id, r.mrr])} accent />
        </div>
        <div className="flex flex-col gap-1 rounded-[10px] border border-filament/50 bg-filament-soft px-3.5 py-3">
          <span className="font-mono text-[10px] uppercase tracking-[0.08em] text-filament">= Your agent answers</span>
          <span className="text-[15px]">
            <span className="font-semibold">$48,210.37 MRR</span> across the 121 customers in that bar. Best MRR per seat: <span className="font-mono">cus_0042</span>, {ROWS[0]!.per} per seat.
          </span>
        </div>
      </div>
    </article>
  );
}

/** A small version for the how-to's side panels. */
export function JoinMini() {
  return (
    <div className="flex w-full flex-col gap-1.5 font-mono text-[10.5px]">
      <div className="flex items-center justify-between rounded-md border border-line bg-cream px-2 py-1">
        <span className="text-muted">Pulse</span>
        <span>cus_0042 · 12 seats</span>
      </div>
      <div className="flex items-center justify-between rounded-md border border-filament bg-cream px-2 py-1">
        <span className="text-filament">you</span>
        <span>cus_0042 · 1,204.37</span>
      </div>
      <div className="rounded-md bg-filament-soft px-2 py-1 text-left">= 100.36 per seat</div>
    </div>
  );
}
