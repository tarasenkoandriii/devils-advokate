import Image from 'next/image';
import { Dictionary } from '../lib/i18n/dictionary';
import { Locale } from '../lib/i18n/config';
import { LanguageSwitcher } from './LanguageSwitcher';
import { TELEGRAM_URL } from '../lib/telegram-url';

// Hell/Lawyer — position: fixed (не sticky в буквальном CSS-смысле, см.
// обоснование ниже), закреплены за углами вьюпорта на весь скролл
// лендинга, не только в пределах hero — НА ДЕСКТОПЕ. CSS
// `position: sticky` требует, чтобы элемент оставался частью
// нормального потока родителя и "отлипает", когда родитель прокручен
// до конца — для "весь лендинг" это означало бы городить общий
// обёрточный контейнер вокруг всех секций специально под декоративные
// картинки. `position: fixed` даёт тот же зрительный результат
// ("прилипло к углу экрана") надёжнее и без этой возни.
//
// Слоган — по прямому запросу отдельно от лого/переключателя, в
// углу экрана (не в общей строке с ними — при попытке объединить в
// одну полосу картинка при скролле мешала читать текст ниже). Лого +
// переключатель языка — тоже отдельно ДРУГ ОТ ДРУГА, два узких
// компактных элемента (.site-logo слева над иллюстрацией слогана,
// .site-lang справа), не одна широкая полоса — широкая полоса тоже
// перекрывала прокручивающийся контент. Оба position: fixed, не
// возвращаются в обычный поток документа на десктопе.
//
// На мобильных (<768px) .site-logo/.site-lang и bottom-left/bottom-right
// fixed-иллюстрации скрыты целиком (см. media query в globals.css —
// постоянно перекрывающие контент на весь скролл на маленьком экране,
// реальная проблема читаемости). Вместо этого — по прямому запросу —
// слоган+лого+переключатель показаны ОДИН РАЗ в потоке документа в
// начале вёрстки, адвокат — ОДИН РАЗ в самом конце страницы (после
// футера, см. page.tsx). Ад на мобильных не показывается вовсе — этого
// явно не просили вернуть.
//
// Courtroom-иллюстрация — вернулась по прямому запросу, справа от
// текста в главной hero-строке, с 6 callout-карточками ниже (переведены
// из devils-advocate-hero-courtroom-front-phone-en.json). Пункт
// [project-audit] 2026-09-01: биндинг «детекция лжи» (hero-007/008)
// переформулирован в словарях в «расхождения с показаниями/
// документами» — прежний текст прямо противоречил §7.4 продукта
// (правка по запросу «исправления по аудиту», не втихую).
//
// Первая версия сажала callout-карточки колонками ПО БОКАМ той же
// строки, что текст+картинка — при контейнере 1120px тексту оставалось
// ~150px и заголовок разваливался на слово-в-строку. Найдено визуальным
// рендером (Playwright), не статическим анализом. Сейчас callout'ы —
// отдельная строка НИЖЕ, не конкурируют за горизонтальное место.
export function Hero({ dict, lang }: { dict: Dictionary; lang: Locale }) {
  return (
    <>
      <span className="site-logo" aria-hidden="false">
        Devil&apos;s Advocate
      </span>

      <div className="site-lang" aria-hidden="false">
        <LanguageSwitcher current={lang} />
      </div>

      <div className="sticky-illustration sticky-illustration--top-left" aria-hidden="true">
        <Image
          src="/images/hero-slogan.webp"
          alt=""
          width={1536}
          height={1024}
          priority
          className="sticky-illustration__image"
          sizes="(max-width: 767px) 0px, 190px"
        />
      </div>

      <div className="sticky-illustration sticky-illustration--bottom-left" aria-hidden="true">
        <Image
          src="/images/hero-hell.webp"
          alt=""
          width={1536}
          height={1024}
          className="sticky-illustration__image"
          sizes="(max-width: 767px) 0px, 190px"
        />
      </div>

      <div className="sticky-illustration sticky-illustration--bottom-right" aria-hidden="true">
        <Image
          src="/images/hero-lawyer.webp"
          alt=""
          width={1672}
          height={941}
          className="sticky-illustration__image"
          sizes="(max-width: 767px) 0px, 200px"
        />
      </div>

      <header className="hero">
        {/* Мобильный вариант слогана — в потоке документа, не fixed,
         * показывается ТОЛЬКО <768px (на десктопе эту роль играет
         * sticky-illustration--top-left выше). */}
        <div className="mobile-only-illustration mobile-only-illustration--top" aria-hidden="true">
          <Image
            src="/images/hero-slogan.webp"
            alt=""
            width={1536}
            height={1024}
            className="mobile-only-illustration__image"
            sizes="(min-width: 768px) 0px, 100vw"
          />
        </div>

        <div className="container hero__top-bar">
          <span className="hero__logo">Devil&apos;s Advocate</span>
          <LanguageSwitcher current={lang} />
        </div>

        <div className="container">
          <div className="hero__main">
            <div className="hero__text">
              <h1>{dict.hero.headline}</h1>
              <p className="lede hero__subheadline">{dict.hero.subheadline}</p>
              <a
                href={TELEGRAM_URL}
                className="button button--primary"
                target="_blank"
                rel="noopener noreferrer"
              >
                {dict.hero.cta}
              </a>
            </div>

            <div className="hero__courtroom" aria-hidden="true">
              <Image
                src="/images/hero-courtroom.webp"
                alt=""
                width={1536}
                height={1024}
                className="hero__courtroom-image"
                sizes="(max-width: 640px) 100vw, 400px"
              />
            </div>
          </div>

          <div className="hero__callouts-row">
            {dict.courtroomCallouts.map((callout) => (
              <div key={callout.title} className="hero__callout">
                <h3 className="hero__callout-title">{callout.title}</h3>
                <p className="hero__callout-desc">{callout.description}</p>
              </div>
            ))}
          </div>
        </div>
      </header>
    </>
  );
}
