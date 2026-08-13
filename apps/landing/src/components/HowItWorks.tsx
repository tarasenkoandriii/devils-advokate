import { Dictionary } from '../lib/i18n/dictionary';

// §3.6 ТЗ: коротко, 1-2 строки — не отдельный лендинг про технологию.
// Единственная задача — снизить воспринимаемый порог входа (не нужно
// ставить отдельное приложение).
export function HowItWorks({ dict }: { dict: Dictionary }) {
  return (
    <section className="section how-it-works">
      <div className="container how-it-works__inner">
        <h2>{dict.howItWorks.title}</h2>
        <p className="lede">{dict.howItWorks.description}</p>
      </div>
    </section>
  );
}
