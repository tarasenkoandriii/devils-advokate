import { Dictionary } from '../lib/i18n/dictionary';

export function PrivacySection({ dict }: { dict: Dictionary }) {
  return (
    <section className="section privacy">
      <div className="container">
        <h2>{dict.privacy.title}</h2>
        <p className="lede privacy__intro">{dict.privacy.intro}</p>

        <div className="privacy__points">
          {dict.privacy.points.map((point) => (
            <div key={point.title} className="privacy__point">
              <h3 className="privacy__point-title">{point.title}</h3>
              <p className="privacy__point-desc">{point.description}</p>
            </div>
          ))}
        </div>

        <a href="/privacy-policy" className="privacy__policy-link">
          {dict.privacy.policyLink} →
        </a>
      </div>
    </section>
  );
}
