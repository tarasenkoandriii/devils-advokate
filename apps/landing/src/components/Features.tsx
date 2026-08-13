import { Dictionary } from '../lib/i18n/dictionary';

export function Features({ dict }: { dict: Dictionary }) {
  return (
    <section className="section features">
      <div className="container">
        <h2>{dict.features.title}</h2>
        <div className="features__list">
          {dict.features.items.map((item, i) => (
            <div key={item.title} className="features__item card">
              <span className="features__marker" data-signal={i % 3} aria-hidden="true" />
              <h3 className="features__item-title">{item.title}</h3>
              <p className="features__item-desc">{item.description}</p>
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}
