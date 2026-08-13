import { Dictionary } from '../lib/i18n/dictionary';

export function Differentiation({ dict }: { dict: Dictionary }) {
  return (
    <section className="section differentiation">
      <div className="container differentiation__grid">
        <h2>{dict.differentiation.title}</h2>
        <div className="differentiation__compare">
          <div className="differentiation__col differentiation__col--them">
            <span className="differentiation__label">{dict.differentiation.themLabel}</span>
            <p>{dict.differentiation.themText}</p>
          </div>
          <div className="differentiation__col differentiation__col--us">
            <span className="differentiation__label">{dict.differentiation.usLabel}</span>
            <p>{dict.differentiation.usText}</p>
          </div>
        </div>
      </div>
    </section>
  );
}
