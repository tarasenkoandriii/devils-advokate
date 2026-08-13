import { Dictionary } from '../lib/i18n/dictionary';

export function CycleSteps({ dict }: { dict: Dictionary }) {
  return (
    <section className="section cycle">
      <div className="container">
        <p className="eyebrow">{dict.cycle.eyebrow}</p>
        <h2 className="cycle__title">{dict.cycle.title}</h2>

        <ol className="cycle__list">
          {dict.cycle.steps.map((step, i) => (
            <li key={step.title} className="cycle__step">
              <span className="cycle__index">{String(i + 1).padStart(2, '0')}</span>
              <h3 className="cycle__step-title">{step.title}</h3>
              <p className="cycle__step-desc">{step.description}</p>
            </li>
          ))}
        </ol>
      </div>
    </section>
  );
}
