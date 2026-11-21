/** The three channels of the core, as a person meets them (the spec's "The idea in three channels"). */
const HOW = [
  { title: "The app says what you see", text: "As identifiers only: the screen, the period, the row you selected. Never the numbers or the text on it." },
  { title: "You point", text: "Drag your agent's mark from the app's page onto a bar, a row or a paragraph. On a phone, tap it there." },
  { title: "Your agent reads it", text: "It gets the exact tool call that reads what you pointed at, and calls it with the access you gave it." },
];

export function HowItWorksSection() {
  return (
    <section className="rv">
      <h2 className="landing-title">How it works</h2>
      <ol className="landing-how">
        {HOW.map((h, i) => (
          <li key={h.title}>
            <span className="landing-n">{i + 1}</span>
            <b>{h.title}</b>
            <p>{h.text}</p>
          </li>
        ))}
      </ol>
    </section>
  );
}
