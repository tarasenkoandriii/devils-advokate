// Минимум по ТЗ (devils-advocate-landing-tz.md, §4): en/uk/ru на старте.
// Архитектура — тот же паттерн, что уже использован в BTW/Volia
// ([lang]-сегмент + middleware геодетекции + generateStaticParams) —
// добавить дополнительный язык позже означает дописать один файл
// словаря и одну строку в locales[], не менять архитектуру.

export const locales = ['en', 'uk', 'ru'] as const;
export type Locale = (typeof locales)[number];

export const defaultLocale: Locale = 'en';

/** og:locale по спецификации Open Graph — language_TERRITORY, а не код
 *  языка. Аудит 2026-09-02 (job-landing): вынесено сюда из jobs/page.tsx,
 *  чтобы главный layout использовал ту же таблицу, а не голый код. */
export const ogLocales: Record<Locale, string> = { ru: 'ru_RU', uk: 'uk_UA', en: 'en_US' };

export const localeNames: Record<Locale, string> = {
  en: 'English',
  uk: 'Українська',
  ru: 'Русский',
};

// Флаги для выпадающего списка — тот же паттерн, что уже используется
// в других лендингах стека. Emoji-флаги, не SVG-спрайты — рендерятся
// нативно во всех современных браузерах/ОС без дополнительных
// ассетов и веса страницы. EN — флаг Великобритании (конвенция для
// "английский язык" в мультиязычных переключателях, не привязка к
// конкретному рынку США/UK).
export const localeFlags: Record<Locale, string> = {
  en: '🇬🇧',
  uk: '🇺🇦',
  ru: '🇷🇺',
};
