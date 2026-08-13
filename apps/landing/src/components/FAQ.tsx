import { Dictionary } from '../lib/i18n/dictionary';

// <details>/<summary> — нативный аккордеон без JS, работает без
// гидратации, доступен из коробки (клавиатура, скринридеры).
export function FAQ({ dict }: { dict: Dictionary }) {
  return (
    <section className="section faq">
      <div className="container">
        <h2>{dict.faq.title}</h2>
        <div className="faq__list">
          {dict.faq.items.map((item) => (
            <details key={item.q} className="faq__item">
              <summary className="faq__question">{item.q}</summary>
              <p className="faq__answer">{item.a}</p>
            </details>
          ))}
        </div>
      </div>
    </section>
  );
}
