import { DurableObject } from "cloudflare:workers";
import { standInHub } from "@tineira/apc-conformance";

// The fixture lives for one workerd run. Its state contains only that run's synthetic pairing data.
export class Hub extends DurableObject {
  hub = standInHub({
    origin: "https://apc.tineira.com",
    app: (request) => fetch(request, { redirect: "manual" }),
  });

  async fetch(request) {
    const { pathname } = new URL(request.url);
    if (!pathname.startsWith("/__test/")) return this.hub.fetch(request);

    // These controls stand in for the dock owner's UI. Expose status only, never the hub's stored codes or URLs.
    if (pathname === "/__test/state" && request.method === "GET") {
      return Response.json({
        pairings: this.hub.pairings.map(({ id, agent, status }) => ({ id, agent, status })),
        confirmations: this.hub.requests.filter((url) => new URL(url).pathname === "/apc/confirm").length,
      });
    }
    if (request.method === "POST") {
      const body = await request.json();
      if (pathname === "/__test/ticket") return Response.json({ ticket: this.hub.ticket(body.agent) });
      if (pathname === "/__test/approve-connect") {
        const { ok, url, error } = await this.hub.approveConnect(body.agent);
        return Response.json({ ok, url, error }, { status: ok ? 200 : 400 });
      }
      if (pathname === "/__test/decide") {
        const result = await this.hub.decide(body.id, body.action, body.code);
        return Response.json(result, { status: result.ok ? 200 : 400 });
      }
      if (pathname.startsWith("/__test/mcp/")) {
        const pairing = this.hub.pairings.find((p) => p.id === pathname.split("/").at(-1) && p.status === "paired");
        if (pairing) {
          return fetch(pairing.mcp_url, {
            method: "POST",
            headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
            redirect: "manual",
            body: JSON.stringify(body),
          });
        }
      }
    }
    return new Response(null, { status: 404 });
  }
}

export default {
  fetch(request, env) {
    return env.HUB.getByName("workerd-pairing").fetch(request);
  },
};
