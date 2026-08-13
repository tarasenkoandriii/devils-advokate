// Минимум по ТЗ (devils-advocate-landing-tz.md, §4): en/uk/ru на старте.
// Архитектура — тот же паттерн, что уже использован в BTW/Volia
// ([lang]-сегмент + middleware геодетекции + generateStaticParams) —
// добавить дополнительный язык позже означает дописать один файл
// словаря и одну строку в locales[], не менять архитектуру.

export const locales = ['en', 'uk', 'ru'] as const;
export type Locale = (typeof locales)[number];

export const defaultLocale: Locale = 'en';

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
