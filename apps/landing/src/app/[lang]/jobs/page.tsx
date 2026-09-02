// Пункт [job-landing] 2026-09-01 — страница /{lang}/jobs
// (devils-advocate-job-landing-tz.md): две аудитории (кандидат ~70% /
// агентство ~30%), секция «Честные границы» как дифференциатор,
// приватность, FAQ с JSON-LD FAQPage. Отличие от ТЗ, зафиксированное
// аудитом: v1 БЕЗ скриншотов продукта — реальных экранов TMA в момент
// реализации нет, а мокапы с выдуманными данными запрещены самим ТЗ
// (§5 п.5); шаги отданы текстовыми карточками. Никакой разметки
// JobPosting — на странице нет вакансий (граница «не джоб-борд»).

import type { Metadata } from 'next';
import { locales, ogLocales, type Locale } from '../../../lib/i18n/config';
import { getJobsDictionary } from '../../../lib/i18n/jobs';
import { StartInTelegram } from '../../../components/jobs/StartInTelegram';
import { AudienceTabs } from '../../../components/jobs/AudienceTabs';
import { Footer } from '../../../components/Footer';
import { getDictionary } from '../../../lib/i18n/get-dictionary';

export function generateStaticParams() {
  return locales.map((lang) => ({ lang }));
}


const SITE_URL = process.env.NEXT_PUBLIC_SITE_URL ?? 'https://example.com';

/** B2B-контакт (ТЗ §4). Пусто → кнопки «Написать нам» просто нет. */
const CONTACT_EMAIL = process.env.NEXT_PUBLIC_CONTACT_EMAIL ?? '';

export async function generateMetadata({ params }: { params: { lang: Locale } }): Promise<Metadata> {
  const dict = getJobsDictionary(params.lang);
  return {
    title: dict.meta.title,
    description: dict.meta.description,
    // Переопределяет alternates лейаута: hreflang должен указывать на
    // /jobs каждого языка, не на главную (аудит ТЗ §3). Аудит
    // 2026-09-02 добавил self-canonical и x-default: три языковые копии
    // близки по структуре, и без них выбор основной версии остаётся на
    // усмотрение поисковика.
    alternates: {
      canonical: `/${params.lang}/jobs`,
      languages: {
        ...Object.fromEntries(locales.map((l) => [l, `/${l}/jobs`])),
        'x-default': '/en/jobs',
      },
    },
    openGraph: {
      title: dict.meta.title,
      description: dict.meta.description,
      // og:locale ждёт language_TERRITORY, не голый код языка.
      locale: ogLocales[params.lang],
      url: `/${params.lang}/jobs`,
      type: 'website',
      images: ['/images/og.jpg'],
    },
    twitter: {
      card: 'summary_large_image',
      title: dict.meta.title,
      description: dict.meta.description,
      images: ['/images/og.jpg'],
    },
  };
}

export default function JobsLandingPage({ params }: { params: { lang: Locale } }) {
  const dict = getJobsDictionary(params.lang);
  // Футер переиспользуется с главной страницы — ему нужен основной
  // словарь (юридические ссылки, переключатель языка).
  const mainDict = getDictionary(params.lang);

  // ТЗ §3 требует ОБА типа: WebPage описывает саму страницу, FAQPage —
  // её раздел вопросов. Аудит 2026-09-02: WebPage отсутствовал, хотя
  // комментарий ниже утверждал обратное. @graph — чтобы оба типа жили в
  // одном блоке и ссылались друг на друга.
  const jsonLd = {
    '@context': 'https://schema.org',
    '@graph': [
      {
        '@type': 'WebPage',
        '@id': `${SITE_URL}/${params.lang}/jobs#webpage`,
        url: `${SITE_URL}/${params.lang}/jobs`,
        name: dict.meta.title,
        description: dict.meta.description,
        inLanguage: params.lang,
      },
      {
        '@type': 'FAQPage',
        '@id': `${SITE_URL}/${params.lang}/jobs#faq`,
        isPartOf: { '@id': `${SITE_URL}/${params.lang}/jobs#webpage` },
        mainEntity: dict.faq.items.map((item) => ({
          '@type': 'Question',
          name: item.q,
          acceptedAnswer: { '@type': 'Answer', text: item.a },
        })),
      },
    ],
  };

  return (
    <main className="jobs">
      {/* JSON-LD: WebPage + FAQPage. JobPosting отсутствует намеренно —
          на странице нет вакансий (граница «не джоб-борд»).
          Экранирование «<» обязательно: без него правка словаря с
          символом «<» разорвала бы тег script. */}
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{
          __html: JSON.stringify(jsonLd).replace(/</g, '\\u003c'),
        }}
      />

      {/* ── Hero с переключателем аудитории ── */}
      <section className="section jobs-hero">
        <div className="container">
          {/* Аудит 2026-09-02: страница была тупиком — ни одной ссылки
              ни на неё, ни с неё. Ссылка на главную нужна и человеку, и
              краулеру. */}
          <a className="jobs-hero__home" href={`/${params.lang}`}>
            Devil&apos;s Advocate
          </a>
          <span className="jobs-hero__badge">{dict.hero.badge}</span>
          <h1 className="jobs-hero__headline">{dict.hero.headline}</h1>
          <p className="jobs-hero__subheadline">{dict.hero.subheadline}</p>
          <AudienceTabs
            candidatesLabel={dict.hero.tabCandidates}
            agenciesLabel={dict.hero.tabAgencies}
            navLabel={dict.hero.tabsLabel}
          />

          {/* Полоса границ. ТЗ §5 п.3 требует «Честные границы» не ниже
              второго экрана, а §2 ставит развёрнутую секцию четвёртой —
              требования противоречили друг другу, и аудит 2026-09-02
              зафиксировал невыполнение. Решение: заголовки границ идут
              сразу под hero (первый экран), развёрнутая секция остаётся
              на своём месте по §2. Один источник текста — расхождения
              между полосой и секцией невозможны. */}
          {/* role="list" явно: list-style: none в Safari/VoiceOver снимает
              семантику списка, и «четыре границы» читаются как четыре
              несвязанные строки (аудит 2026-09-02). */}
          <ul className="jobs-hero__boundaries" role="list" aria-label={dict.boundaries.title}>
            {dict.boundaries.items.map((item) => (
              <li key={item.title}>{item.title}</li>
            ))}
          </ul>
        </div>
      </section>

      {/* ── Кандидат ── */}
      <section className="section jobs-audience" id="candidates">
        <div className="container">
          <h2>{dict.candidates.title}</h2>
          <ol className="jobs-steps" role="list">
            {dict.candidates.steps.map((step, i) => (
              <li key={step.title} className="jobs-steps__item">
                <span className="jobs-steps__num">{i + 1}</span>
                <h3 className="jobs-steps__title">{step.title}</h3>
                <p className="jobs-steps__desc">{step.description}</p>
              </li>
            ))}
          </ol>
          <StartInTelegram start="jobs_landing" ariaLabel={`${dict.candidates.cta} — ${dict.hero.tabCandidates}`}>
            {dict.candidates.cta}
          </StartInTelegram>
        </div>
      </section>

      {/* ── Агентство ── */}
      <section className="section jobs-audience jobs-audience--agencies" id="agencies">
        <div className="container">
          <h2>{dict.agencies.title}</h2>
          <div className="jobs-points">
            {dict.agencies.points.map((point) => (
              <div key={point.title} className="jobs-points__item">
                <h3 className="jobs-points__title">{point.title}</h3>
                <p className="jobs-points__desc">{point.description}</p>
              </div>
            ))}
          </div>
          <div className="jobs-final-buttons">
            <StartInTelegram start="recruiting_landing" ariaLabel={`${dict.agencies.cta} — ${dict.hero.tabAgencies}`}>
              {dict.agencies.cta}
            </StartInTelegram>
            {/* ТЗ §4: «Плюс ссылка „Написать нам“ (mailto), пока нет
                B2B-формы» — её не было вовсе (аудит 2026-09-02). Адрес
                из окружения: захардкоженный плейсхолдер хуже отсутствия
                ссылки, поэтому без переменной кнопки просто нет. */}
            {CONTACT_EMAIL && (
              <a href={`mailto:${CONTACT_EMAIL}?subject=${encodeURIComponent(dict.agencies.title)}`} className="button button--ghost">
                {dict.agencies.contactCta}
              </a>
            )}
          </div>
        </div>
      </section>

      {/* ── Честные границы — дифференциатор, не мелкий шрифт (ТЗ §2 п.4) ── */}
      <section className="section jobs-boundaries">
        <div className="container">
          <h2>{dict.boundaries.title}</h2>
          <p className="jobs-boundaries__intro">{dict.boundaries.intro}</p>
          <div className="jobs-points">
            {dict.boundaries.items.map((item) => (
              <div key={item.title} className="jobs-points__item jobs-points__item--boundary">
                <h3 className="jobs-points__title">{item.title}</h3>
                <p className="jobs-points__desc">{item.description}</p>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* ── Приватность ── */}
      <section className="section jobs-privacy">
        <div className="container">
          <h2>{dict.privacy.title}</h2>
          <ul className="jobs-privacy__list">
            {dict.privacy.items.map((item) => (
              <li key={item}>{item}</li>
            ))}
          </ul>
        </div>
      </section>

      {/* ── FAQ — тот же нативный <details>-паттерн, что на главной ── */}
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

      {/* ── Финальный CTA — по кнопке на аудиторию ── */}
      <section className="section final-cta">
        <div className="container final-cta__inner">
          <h2>{dict.finalCta.title}</h2>
          <div className="jobs-final-buttons">
            <StartInTelegram start="jobs_landing" ariaLabel={`${dict.finalCta.candidates} — ${dict.hero.tabCandidates}`}>
              {dict.finalCta.candidates}
            </StartInTelegram>
            <StartInTelegram start="recruiting_landing" ariaLabel={`${dict.finalCta.agencies} — ${dict.hero.tabAgencies}`}>
              {dict.finalCta.agencies}
            </StartInTelegram>
          </div>
        </div>
      </section>

      <Footer dict={mainDict} lang={params.lang} />
    </main>
  );
}
