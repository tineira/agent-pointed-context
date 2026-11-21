/** Your agent, your permission: what the agent can reach, in three rows. */
const ROWS = [
  { title: "Only the item you point at", text: "The app sends identifiers, never your screen and never a screenshot. Your agent reads the item through the app's own tools, with the access you gave it." },
  { title: "One connection per app", text: "You connect your agent to each app yourself, at the app's own MCP address. Each app keeps its data, and your agent does the joining, in your conversation." },
  { title: "Revoke in the app", text: "Each app lists your agents in its own page. Revoke one there at any time and it is cut off from that app at once." },
];

export function AccessSection() {
  return (
    <section className="landing-access">
      <div className="wrap landing-access-grid">
        <div className="rv">
          <p className="landing-idx">Access and privacy</p>
          <h2>
            Your agent.
            <br />
            Your <em>permission.</em>
          </h2>
        </div>
        <div className="landing-access-rows rv">
          {ROWS.map((r) => (
            <article key={r.title}>
              <h3>{r.title}</h3>
              <p>{r.text}</p>
            </article>
          ))}
        </div>
      </div>
    </section>
  );
}
