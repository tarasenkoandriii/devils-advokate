import { Dictionary } from '../lib/i18n/dictionary';
import { Locale } from '../lib/i18n/config';
import { LanguageSwitcher } from './LanguageSwitcher';

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
          <a href="/privacy-policy">{dict.footer.privacyPolicy}</a>
          <a href="/terms-of-service">{dict.footer.termsOfService}</a>
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
