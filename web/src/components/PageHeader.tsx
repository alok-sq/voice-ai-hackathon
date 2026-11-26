import { AGENT } from "../domain/agent";

export function PageHeader() {
  return (
    <section className="hero" aria-labelledby="hero-h">
      <p className="hero__eyebrow">Lead qualification · Voice agent</p>
      <h1 id="hero-h" className="hero__title">
        Meet <em>{AGENT.name}</em>
      </h1>
      <p className="hero__lede">{AGENT.intro}</p>
    </section>
  );
}
