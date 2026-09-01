// Пункт [job-landing] 2026-09-01 — страница /{lang}/jobs
// (devils-advocate-job-landing-tz.md): две аудитории (кандидат ~70% /
// агентство ~30%), секция «Честные границы» как дифференциатор,
// приватность, FAQ с JSON-LD FAQPage. Отличие от ТЗ, зафиксированное
// аудитом: v1 БЕЗ скриншотов продукта — реальных экранов TMA в момент
// реализации нет, а мокапы с выдуманными данными запрещены самим ТЗ
// (§5 п.5); шаги отданы текстовыми карточками. Никакой разметки
// JobPosting — на странице нет вакансий (граница «не джоб-борд»).

import type { Metadata } from 'next';
import { locales, type Locale } from '../../../lib/i18n/config';
import { getJobsDictionary } from '../../../lib/i18n/jobs';
import { telegramStartUrl } from '../../../lib/telegram-url';
import { AudienceTabs } from '../../../components/jobs/AudienceTabs';
import { Footer } from '../../../components/Footer';
import { getDictionary } from '../../../lib/i18n/get-dictionary';

export function generateStaticParams() {
  return locales.map((lang) => ({ lang }));
}

export async function generateMetadata({ params }: { params: { lang: Locale } }): Promise<Metadata> {
  const dict = getJobsDictionary(params.lang);
  return {
    title: dict.meta.title,
    description: dict.meta.description,
    // Переопределяет alternates лейаута: hreflang должен указывать на
    // /jobs каждого языка, не на главную (аудит ТЗ §3).
    alternates: {
      languages: Object.fromEntries(locales.map((l) => [l, `/${l}/jobs`])),
    },
    openGraph: {
      title: dict.meta.title,
      description: dict.meta.description,
      locale: params.lang,
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

  const faqJsonLd = {
    '@context': 'https://schema.org',
    '@type': 'FAQPage',
    mainEntity: dict.faq.items.map((item) => ({
      '@type': 'Question',
      name: item.q,
      acceptedAnswer: { '@type': 'Answer', text: item.a },
    })),
  };

  return (
    <main className="jobs">
      {/* JSON-LD только FAQPage + WebPage; JobPosting отсутствует намеренно. */}
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{ __html: JSON.stringify(faqJsonLd) }}
      />

      {/* ── Hero с переключателем аудитории ── */}
      <section className="section jobs-hero">
        <div className="container">
          <span className="jobs-hero__badge">{dict.hero.badge}</span>
          <h1 className="jobs-hero__headline">{dict.hero.headline}</h1>
          <p className="jobs-hero__subheadline">{dict.hero.subheadline}</p>
          <AudienceTabs candidatesLabel={dict.hero.tabCandidates} agenciesLabel={dict.hero.tabAgencies} />
        </div>
      </section>

      {/* ── Кандидат ── */}
      <section className="section jobs-audience" id="candidates">
        <div className="container">
          <h2>{dict.candidates.title}</h2>
          <ol className="jobs-steps">
            {dict.candidates.steps.map((step, i) => (
              <li key={step.title} className="jobs-steps__item">
                <span className="jobs-steps__num">{i + 1}</span>
                <h3 className="jobs-steps__title">{step.title}</h3>
                <p className="jobs-steps__desc">{step.description}</p>
              </li>
            ))}
          </ol>
          <a href={telegramStartUrl('jobs_landing')} className="button button--primary" target="_blank" rel="noopener noreferrer">
            {dict.candidates.cta}
          </a>
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
          <a href={telegramStartUrl('recruiting_landing')} className="button button--primary" target="_blank" rel="noopener noreferrer">
            {dict.agencies.cta}
          </a>
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
            <a href={telegramStartUrl('jobs_landing')} className="button button--primary" target="_blank" rel="noopener noreferrer">
              {dict.finalCta.candidates}
            </a>
            <a href={telegramStartUrl('recruiting_landing')} className="button button--primary" target="_blank" rel="noopener noreferrer">
              {dict.finalCta.agencies}
            </a>
          </div>
        </div>
      </section>

      <Footer dict={mainDict} lang={params.lang} />
    </main>
  );
}
