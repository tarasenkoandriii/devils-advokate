import { Dictionary } from '../lib/i18n/dictionary';
import { Locale } from '../lib/i18n/config';
import { LanguageSwitcher } from './LanguageSwitcher';
import { getJobsDictionary } from '../lib/i18n/jobs';

// §3.9 ТЗ: юридические реквизиты (ФОП/ЄДРПОУ — паттерн из других
// проектов), ссылки на Privacy Policy/ToS, переключатель языка,
// контакты. Реквизиты — плейсхолдеры через переменные окружения, не
// захардкожены (см. .env.example) — у каждого продукта своё ФОП/ЄДРПОУ,
// нельзя механически скопировать из другого проекта.
export function Footer({ dict, lang }: { dict: Dictionary; lang: Locale }) {
  const legalEntity = process.env.NEXT_PUBLIC_LEGAL_ENTITY;
  const contactHandle = process.env.NEXT_PUBLIC_CONTACT_TELEGRAM ?? '';

  return (
    <footer className="footer">
      <div className="container footer__inner">
        <div className="footer__brand">
          <span className="footer__logo">Devil&apos;s Advocate</span>
          <p className="footer__tagline">{dict.footer.tagline}</p>
        </div>

        <div className="footer__links">
          {/* ПОВТОРНЫЙ АУДИТ 2026-08-30: обе ссылки вели в 404 —
              маршрутов /privacy-policy и /terms-of-service в приложении
              нет. Политика приватности есть как секция этой же страницы
              (id="privacy-policy"), поэтому ссылка стала якорной.
              Пользовательского соглашения нет вообще — ни страницы, ни
              текста; ссылка на него убрана, потому что битая ссылка на
              юридический документ хуже её отсутствия. Когда текст
              появится, вернуть строку вместе со страницей, а не раньше
              (см. отчёт аудита, раздел «Лендинг»).

              АУДИТ 2026-09-02: голый якорь работал только на главной —
              секция политики рендерится там. С /{'{lang}'}/jobs, где футер
              тот же, клик был no-op: ссылка на юридический документ,
              ведущая в никуда. Теперь якорь абсолютный по локали. */}
          <a href={`/${lang}#privacy-policy`}>{dict.footer.privacyPolicy}</a>
          {/* АУДИТ 2026-09-02: /{'{lang}'}/jobs была страницей-сиротой —
              ни одной внутренней ссылки во всём лендинге, только запись
              в sitemap. Футер общий у обеих страниц, поэтому ссылка
              здесь связывает их в обе стороны. Текст берётся из
              словаря /jobs — он самодостаточен по решению ТЗ §3. */}
          <a href={`/${lang}/jobs`}>{getJobsDictionary(lang).navLabel}</a>
          {contactHandle && (
            <a href={`https://t.me/${contactHandle}`} target="_blank" rel="noopener noreferrer">
              {dict.footer.contact}
            </a>
          )}
        </div>

        <LanguageSwitcher current={lang} />
      </div>

      <div className="container footer__bottom">
        <p className="footer__note">{dict.footer.antiSurveillanceNote}</p>
        {legalEntity && <p className="footer__legal">{legalEntity}</p>}
      </div>
    </footer>
  );
}
