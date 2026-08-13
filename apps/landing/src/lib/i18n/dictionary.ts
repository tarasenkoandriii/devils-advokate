// Структура повторяет разделы 3.1-3.9 devils-advocate-landing-tz.md —
// один тип на все локали гарантирует, что при добавлении секции в
// одном словаре TS сразу укажет на отсутствие перевода в остальных.

export interface Dictionary {
  meta: {
    title: string;
    description: string;
  };
  hero: {
    headline: string;
    subheadline: string;
    cta: string;
  };
  // Из devils-advocate-hero-courtroom-front-phone-en.json (46 биндингов,
  // полный перевод по запросу) — courtroomCallouts используются реально
  // (флажки вокруг вернувшейся hero-иллюстрации), phoneMockup и
  // bottomFeatures переведены полностью, но пока НЕ подключены ни к
  // одной секции — честно: переведено "на будущее", не выдумана секция
  // под них наспех. См. комментарий в Hero.tsx про два биндинга
  // (hero-001/002, hero-007/008), описывающих функциональность
  // (live-анализ речи, детекция лжи), которой в MVP v1 физически нет.
  courtroomCallouts: Array<{
    icon: string;
    title: string;
    description: string;
    side: 'left' | 'right';
  }>;
  phoneMockup: {
    brand: string;
    liveStatus: string;
    mode: string;
    speaker: string;
    alertTitle: string;
    alertDetail: string;
    riskLow: string;
    riskHigh: string;
    whyFlaggedTitle: string;
    whyFlaggedReasons: string[];
    whatToAskTitle: string;
    suggestedQuestions: string[];
    strategicSuggestionTitle: string;
    strategicSuggestionText: string;
    navNotes: string;
    navDocuments: string;
    navTimeline: string;
    navAnalysis: string;
    navMore: string;
  };
  bottomFeatures: Array<{ title: string; description: string }>;
  // Из we_are_not_en.json (23 пункта, 4 группы) — новая секция "не
  // фрагментировано, не забыто" сразу под hero. См. Technology.tsx —
  // изображение раздела содержит впечатанный английский текст (несмотря
  // на имя файла "no_text"), поэтому для uk/ru не переиспользуется
  // буквально как контент — используется как декоративный визуал, а
  // реальная локализованная информация — этот блок, отрендеренный как
  // настоящий HTML, не скриншот.
  technology: {
    eyebrow: string;
    title: string;
    subtitle: string;
    groups: Array<{
      title: string;
      items: Array<{ icon: string; text: string; description: string; tag?: string }>;
    }>;
  };
  // Реконструкция экрана телефона внутри technology-иллюстрации как
  // настоящий HTML (см. PhoneMockup.tsx) — по прямому запросу, вместо
  // экрана из базовой картинки, который выглядел иначе, чем референс.
  // Переводимых строк мало: "Devil's Advocate" — имя бренда, не
  // переводится нигде на сайте; таймстемпы/статус чек-листа — не текст,
  // визуальная структура, перевода не требует.
  technologyPhone: {
    liveLabel: string;
    currentAgendaLabel: string;
  };
  // Иллюстрированная секция Privacy Policy — последняя секция лендинга,
  // отдельная от короткой PrivacySection (§3.4 ТЗ, "Privacy is not a
  // footnote", 3 пункта в начале страницы) — эта секция полнее и стоит
  // в конце. Координаты пиктограмм — НЕ здесь (языково-независимые,
  // см. PrivacyPolicyIllustrated.tsx, ITEM_CONFIG), только текст.
  // ЧЕСТНО: JSON-источник (privacy_policy_en.json) заявляет 48 пунктов
  // в 9 группах, но 9 из них (bottom_capture_analysis,
  // bottom_guidance_review) не имеют видимой пиктограммы на самой
  // картинке — собственный аудит JSON-файла подтверждает: 39
  // "pictogram_entries", ровно 48-9. Эти 9 не переведены и не
  // рендерятся — нечего к ним привязывать.
  privacyPolicy: {
    eyebrow: string;
    title: string;
    subtitle: string;
    groups: Array<{
      title: string;
      items: Array<{ id: string; text: string; description: string }>;
    }>;
  };
  cycle: {
    eyebrow: string;
    title: string;
    steps: Array<{ title: string; description: string }>;
  };
  differentiation: {
    title: string;
    themLabel: string;
    themText: string;
    usLabel: string;
    usText: string;
  };
  privacy: {
    title: string;
    intro: string;
    points: Array<{ title: string; description: string }>;
    policyLink: string;
  };
  features: {
    title: string;
    items: Array<{ title: string; description: string }>;
  };
  howItWorks: {
    title: string;
    description: string;
  };
  faq: {
    title: string;
    items: Array<{ q: string; a: string }>;
  };
  finalCta: {
    title: string;
    subtitle: string;
    cta: string;
  };
  footer: {
    tagline: string;
    privacyPolicy: string;
    termsOfService: string;
    contact: string;
    antiSurveillanceNote: string;
  };
}
