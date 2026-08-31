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

        {/* ПОВТОРНЫЙ АУДИТ 2026-08-30: было href="/privacy-policy" —
            такого маршрута в apps/landing нет (в app/ только [lang]/page,
            robots, sitemap), а middleware ещё и дописывал локаль, так что
            ссылка вела в 404. Политика приватности — секция на этой же
            странице (PrivacyPolicyIllustrated, id="privacy-policy"),
            поэтому ссылка теперь якорная. */}
        <a href="#privacy-policy" className="privacy__policy-link">
          {dict.privacy.policyLink} →
        </a>
      </div>
    </section>
  );
}
