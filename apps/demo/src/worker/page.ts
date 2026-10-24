/**
 * Whether a page of the person's is open, from its sockets alone. The page
 * sends "ping" every HEARTBEAT_MS over its WebSocket and the sandbox answers
 * "pong" without waking (the hibernation API's auto-response), which stamps
 * the socket. A socket counts as open only while it is OPEN and was stamped,
 * or accepted, within PAGE_WINDOW_MS: a proxy that never reports a closed tab
 * (the Vite dev proxy does this) stops counting once the pings stop.
 */
export const HEARTBEAT_MS = 30_000;
/** Two heartbeats, plus slack for a background tab whose timers the browser throttles. */
export const PAGE_WINDOW_MS = 2 * HEARTBEAT_MS + 15_000;

export interface PageSocket {
  open: boolean;
  /** When the sandbox last answered this socket's ping (ms), or null before the first. */
  lastPongAt: number | null;
  /** When the sandbox accepted the socket (ms); 0 when unknown. */
  acceptedAt: number;
}

export function socketAlive(socket: PageSocket, now: number): boolean {
  if (!socket.open) return false;
  const lastSign = Math.max(socket.lastPongAt ?? 0, socket.acceptedAt);
  return now - lastSign <= PAGE_WINDOW_MS;
}

export function anyPageOpen(sockets: PageSocket[], now: number): boolean {
  return sockets.some((socket) => socketAlive(socket, now));
}

/**
 * Attendance as an agent may learn it: whether a page is open, or null while
 * the person does not share their view. With sharing off they asked not to be
 * observed, so no grant learns that a page is open or when it closed (no
 * then, no page_open); pointing still works.
 */
export function attendance(shareView: boolean, pageOpen: () => boolean): boolean | null {
  return shareView ? pageOpen() : null;
}

/** Whether a result carries the loop hint: a page is known open, and it is not a wait that returned no focus (that one ends the loop). */
export function loopHinted(tool: string, focusReturned: boolean, attending: boolean | null): boolean {
  const loopEnds = tool === "wait_for_focus" && !focusReturned;
  // Naming itself is not an answer to the person (TIN-356): nothing to wait after.
  if (tool === "set_agent_name") return false;
  return !loopEnds && attending === true;
}
