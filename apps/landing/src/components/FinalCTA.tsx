import { Dictionary } from '../lib/i18n/dictionary';
import { TELEGRAM_URL } from '../lib/telegram-url';

export function FinalCTA({ dict }: { dict: Dictionary }) {
  return (
    <section className="section final-cta">
      <div className="container final-cta__inner">
        <h2>{dict.finalCta.title}</h2>
        <p className="lede">{dict.finalCta.subtitle}</p>
        <a href={TELEGRAM_URL} className="button button--primary" target="_blank" rel="noopener noreferrer">
          {dict.finalCta.cta}
        </a>
      </div>
    </section>
  );
}
