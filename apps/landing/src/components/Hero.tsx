import Image from 'next/image';
import { Dictionary } from '../lib/i18n/dictionary';
import { Locale } from '../lib/i18n/config';
import { LanguageSwitcher } from './LanguageSwitcher';
import { TELEGRAM_URL } from '../lib/telegram-url';

// Slogan/Hell/Lawyer — position: fixed (не sticky в буквальном CSS-
// смысле, см. обоснование ниже), закреплены за углами вьюпорта на весь
// скролл лендинга, не только в пределах hero — НА ДЕСКТОПЕ. CSS
// `position: sticky` требует, чтобы элемент оставался частью
// нормального потока родителя и "отлипает", когда родитель прокручен
// до конца — для "весь лендинг" это означало бы городить общий
// обёрточный контейнер вокруг всех секций специально под 3 декоративные
// картинки. `position: fixed` даёт тот же зрительный результат
// ("прилипло к углу экрана") надёжнее и без этой возни.
//
// На мобильных (<768px) три fixed-иллюстрации скрыты целиком (см.
// media query в globals.css — три картинки, постоянно перекрывающие
// контент на весь скролл на маленьком экране, реальная проблема
// читаемости). Вместо этого — по прямому запросу — слоган показан ОДИН
// РАЗ в начале вёрстки (в потоке документа, не fixed), адвокат — ОДИН
// РАЗ в самом конце страницы (после футера, см. page.tsx). Ад на
// мобильных не показывается вовсе — этого явно не просили вернуть.
//
// Courtroom-иллюстрация — вернулась по прямому запросу, справа от
// текста в главной hero-строке, с 6 callout-карточками ниже (переведены
// из devils-advocate-hero-courtroom-front-phone-en.json). ЧЕСТНО: два
// из шести биндингов (hero-001/002 "live-анализ речи", hero-007/008
// "детекция лжи") описывают функциональность, которой в MVP v1 нет —
// используются по прямому указанию как есть, не переписаны втихую.
//
// Первая версия сажала callout-карточки колонками ПО БОКАМ той же
// строки, что текст+картинка — при контейнере 1120px тексту оставалось
// ~150px и заголовок разваливался на слово-в-строку. Найдено визуальным
// рендером (Playwright), не статическим анализом. Сейчас callout'ы —
// отдельная строка НИЖЕ, не конкурируют за горизонтальное место.
export function Hero({ dict, lang }: { dict: Dictionary; lang: Locale }) {
  return (
    <>
      <div className="sticky-illustration sticky-illustration--top-left" aria-hidden="true">
        <Image
          src="/images/hero-slogan.png"
          alt=""
          width={1536}
          height={1024}
          priority
          className="sticky-illustration__image"
          sizes="(max-width: 767px) 0px, 200px"
        />
      </div>

      <div className="sticky-illustration sticky-illustration--bottom-left" aria-hidden="true">
        <Image
          src="/images/hero-hell.png"
          alt=""
          width={1536}
          height={1024}
          className="sticky-illustration__image"
          sizes="(max-width: 767px) 0px, 190px"
        />
      </div>

      <div className="sticky-illustration sticky-illustration--bottom-right" aria-hidden="true">
        <Image
          src="/images/hero-lawyer.png"
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
            src="/images/hero-slogan.png"
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
                src="/images/hero-courtroom.png"
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
