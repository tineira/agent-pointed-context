import { APC_STANDARD_VERSION } from "@tineira/apc-protocol";
import { DOCS, PAPER, RECORDS, REPO } from "../site-pages.ts";

/**
 * Free, open and versioned: the licences, the spec, the code and the two Zenodo records. It states only what the repo
 * proves: no stars, no adopters, and the version is the protocol package's own constant, read at build time.
 */
const CARDS = [
  { title: "The spec", text: "The core, connecting agents, the focus format, apc.json.", note: "Spec and docs: CC BY 4.0", href: `${DOCS}/spec`, external: false },
  { title: "The code", text: "The packages, the demo apps and the conformance suite, on GitHub.", note: "Code: MIT", href: REPO, external: true },
  { title: "The paper", text: "Letting a person point an AI agent at what they see.", note: "doi:10.5281/zenodo.23382909", href: PAPER, external: true },
  { title: "Payload specification", text: "With the design records, on Zenodo.", note: "doi:10.5281/zenodo.23383101", href: RECORDS, external: true },
];

/** What this section links, so the footer leaves them out. */
export const STANDARD_LINKS = CARDS.map((c) => c.href);

export function StandardSection() {
  return (
    <section className="wrap landing-block">
      <div className="landing-head rv">
        <p className="landing-idx">The standard</p>
        <h2>
          Free, open and versioned<span className="landing-dotc">.</span>
        </h2>
        <p>APC was introduced in a research paper. Its code is MIT, its docs and spec are CC BY 4.0, and the 1.0 contract is frozen: it changes only by its versioning policy.</p>
        <p className="landing-version">Standard version {APC_STANDARD_VERSION}</p>
      </div>
      <ul className="landing-std rv">
        {CARDS.map((c) => (
          <li key={c.title}>
            <h3>
              <a href={c.href} {...(c.external ? { target: "_blank", rel: "noopener" } : {})}>
                {c.title}
                <span aria-hidden="true">{c.external ? " ↗" : " →"}</span>
              </a>
            </h3>
            <p>{c.text}</p>
            <small>{c.note}</small>
          </li>
        ))}
      </ul>
    </section>
  );
}
