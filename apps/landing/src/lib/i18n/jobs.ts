// Пункт [job-landing] 2026-09-01 — словарь страницы /{lang}/jobs
// (devils-advocate-job-landing-tz.md). ОТДЕЛЬНЫЙ файл, не расширение
// основного Dictionary: страница самодостаточна, и правка её текстов
// не должна трогать тип, на который завязаны все секции главного
// лендинга (решение зафиксировано в ТЗ после аудита 2026-09-01).
//
// Тексты следуют границам продукта дословно: никакой «детекции лжи»,
// никаких обещаний трудоустройства, «решение принимает человек».

import type { Locale } from './config';

export interface JobsDictionary {
  meta: { title: string; description: string };
  hero: {
    badge: string;
    headline: string;
    subheadline: string;
    tabCandidates: string;
    tabAgencies: string;
    /** Название группы ссылок-аудиторий для скринридера. */
    tabsLabel: string;
  };
  candidates: {
    title: string;
    cta: string;
    steps: Array<{ title: string; description: string }>;
  };
  agencies: {
    title: string;
    cta: string;
    /** ТЗ §4: «Написать нам» для B2B, пока нет формы лидов. */
    contactCta: string;
    points: Array<{ title: string; description: string }>;
  };
  /** Ссылка на эту страницу из футера основного лендинга: страница была
   *  сиротой — ни одной внутренней ссылки (аудит 2026-09-02). */
  navLabel: string;
  boundaries: {
    title: string;
    intro: string;
    items: Array<{ title: string; description: string }>;
  };
  privacy: {
    title: string;
    items: string[];
  };
  faq: {
    title: string;
    items: Array<{ q: string; a: string }>;
  };
  finalCta: { title: string; candidates: string; agencies: string };
}

const ru: JobsDictionary = {
  navLabel: 'Поиск работы и найм',
  meta: {
    title: "Devil's Advocate — подготовка к поиску работы и найму",
    description:
      'CV из ваших собственных слов, разбор вакансий по вашим критериям и честные интервью-пулы для рекрутинга. Без «AI-баллов» и детекции лжи — решения принимает человек.',
  },
  hero: {
    badge: 'Работа',
    headline: 'Подготовьтесь к поиску работы. Или к найму.',
    subheadline:
      'Кандидату — CV из его собственных слов и разбор вакансий по его критериям. Агентству — одинаковые вопросы всем кандидатам и прозрачное покрытие вместо «AI-балла».',
    tabCandidates: 'Ищу работу',
    tabAgencies: 'Нанимаю',
    tabsLabel: 'Выберите аудиторию',
  },
  candidates: {
    title: 'Кандидату: три шага',
    cta: 'Начать в Telegram',
    steps: [
      {
        title: 'Расскажите о себе — можно голосом',
        description:
          'Короткий квиз в Telegram: роль, опыт, город, ожидания. AI собирает черновик CV строго из того, что вы сказали, — ничего не выдумывает. Пустая секция честнее выдуманного достижения. Финальный текст утверждаете вы.',
      },
      {
        title: 'Принесите вакансии со своих джоб-сайтов',
        description:
          'Ссылка на вакансию с work.ua, robota.ua, dou.ua — любого сайта вашего региона. Разбор по вашим критериям: что закрыто, что частично, о чём в вакансии ни слова и что уточнить до отклика. Без вердикта «подходит/не подходит» — это ваше решение.',
      },
      {
        title: 'Смотрите статистику своего поиска',
        description:
          'Сколько собранных вакансий из вашего города и региона, на каких сайтах, где называют зарплату и сколько полностью закрывают обязательные критерии. Считается по вашим вакансиям, без магии.',
      },
    ],
  },
  agencies: {
    title: 'Агентству и HR-команде',
    cta: 'Начать в Telegram',
    contactCta: 'Написать нам',
    points: [
      {
        title: 'Одна анкета — все кандидаты',
        description:
          'AI предлагает вопросы под вакансию, человек утверждает. Все кандидаты пула отвечают на один и тот же набор — сравнение становится честным.',
      },
      {
        title: 'Покрытие вместо «AI-балла»',
        description:
          'Прозрачная метрика: сколько обязательных вопросов реально прозвучало и закрыто в завершённых интервью. Никакого скрытого рейтинга людей.',
      },
      {
        title: 'Compliance-флаги в требованиях',
        description:
          'Формулировки вроде «до 35 лет» подсвечиваются категорией и дословной цитатой при настройке пула — а не вычищаются молча.',
      },
      {
        title: 'Команда и отчёты',
        description:
          'Общая база кандидатов по инвайтам, дозапросы материалов, сводный отчёт клиенту с воронкой по стадиям.',
      },
    ],
  },
  boundaries: {
    title: 'Честные границы',
    intro: 'Это не оговорка мелким шрифтом — это то, чем продукт отличается.',
    items: [
      {
        title: 'Не детектор лжи',
        description: 'Продукт никогда не утверждает, что человек лжёт, и не оценивает «шансы» кандидата.',
      },
      {
        title: 'Не джоб-борд',
        description: 'Мы не публикуем и не агрегируем вакансии. Вы приносите ссылку — мы разбираем именно её.',
      },
      {
        title: 'Решения принимает человек',
        description: 'AI готовит материал: черновики, покрытие критериев, вопросы. Утверждаете, откликаетесь и нанимаете — вы.',
      },
      {
        title: 'CV только из ваших слов',
        description: 'Ни выдуманного опыта, ни «улучшенных» цифр. Что вы не говорили — того в CV нет.',
      },
    ],
  },
  privacy: {
    title: 'Приватность',
    items: [
      'Ваши данные живут в вашем проекте и не публикуются без вашего явного действия — любая публичная ссылка создаётся вами и отзывается вами. Мы не откликаемся на вакансии за вас.',
      'Каждое использование AI и записи закрыто явным согласием — его можно отозвать.',
      'Голосовой ввод идёт из браузера напрямую в сервис распознавания речи по короткоживущему токену — через наш сервер аудио не проходит, и мы его не храним. Распознаёт внешний провайдер (Soniox для русского и украинского, AssemblyAI для английского) — кому именно уходит звук, названо в тексте согласия.',
    ],
  },
  faq: {
    title: 'Вопросы',
    items: [
      {
        q: 'Вы публикуете моё CV или данные?',
        a: 'Нет. CV и разборы живут только в вашем проекте. Наружу уходит только то, что вы сами отправите работодателю.',
      },
      {
        q: 'Вы откликаетесь на вакансии за меня?',
        a: 'Нет. Продукт готовит материал — CV, разбор вакансии, вопросы для уточнения. Откликаетесь вы сами.',
      },
      {
        q: 'Какие джоб-сайты поддерживаются?',
        a: 'Любые: вы приносите ссылку на страницу вакансии, продукт разбирает именно её. Ни один сайт не «интегрирован» и не имеет преимущества.',
      },
      {
        q: 'AI решает, подхожу ли я на вакансию?',
        a: 'Нет. Разбор показывает покрытие ваших критериев и что стоит уточнить. Слов «подходит» или «не подходит» в нём нет намеренно.',
      },
      {
        q: 'Как агентство сравнивает кандидатов?',
        a: 'По покрытию одинаковой утверждённой анкеты в завершённых интервью — прозрачная счётная метрика, не скрытый балл.',
      },
      {
        q: 'Сколько это стоит?',
        a: 'Продукт в стадии запуска — актуальные условия в боте. Никаких платных «поднятий» CV или приоритетов в выдаче не существует.',
      },
    ],
  },
  finalCta: {
    title: 'Готовы попробовать?',
    candidates: 'Я ищу работу',
    agencies: 'Я нанимаю',
  },
};

const uk: JobsDictionary = {
  navLabel: 'Пошук роботи та найм',
  meta: {
    title: "Devil's Advocate — підготовка до пошуку роботи та найму",
    description:
      'CV з ваших власних слів, розбір вакансій за вашими критеріями та чесні інтервʼю-пули для рекрутингу. Без «AI-балів» і детекції брехні — рішення ухвалює людина.',
  },
  hero: {
    badge: 'Робота',
    headline: 'Підготуйтеся до пошуку роботи. Або до найму.',
    subheadline:
      'Кандидату — CV з його власних слів і розбір вакансій за його критеріями. Агенції — однакові питання всім кандидатам і прозоре покриття замість «AI-балу».',
    tabCandidates: 'Шукаю роботу',
    tabAgencies: 'Наймаю',
    tabsLabel: 'Оберіть аудиторію',
  },
  candidates: {
    title: 'Кандидату: три кроки',
    cta: 'Почати в Telegram',
    steps: [
      {
        title: 'Розкажіть про себе — можна голосом',
        description:
          'Короткий квіз у Telegram: роль, досвід, місто, очікування. AI збирає чернетку CV строго з того, що ви сказали, — нічого не вигадує. Порожня секція чесніша за вигадане досягнення. Фінальний текст затверджуєте ви.',
      },
      {
        title: 'Принесіть вакансії зі своїх джоб-сайтів',
        description:
          'Посилання на вакансію з work.ua, robota.ua, dou.ua — будь-якого сайту вашого регіону. Розбір за вашими критеріями: що закрито, що частково, про що у вакансії ані слова і що уточнити до відгуку. Без вердикту «підходить/не підходить» — це ваше рішення.',
      },
      {
        title: 'Дивіться статистику свого пошуку',
        description:
          'Скільки зібраних вакансій з вашого міста й регіону, на яких сайтах, де називають зарплату і скільки повністю закривають обовʼязкові критерії. Рахується за вашими вакансіями, без магії.',
      },
    ],
  },
  agencies: {
    title: 'Агенції та HR-команді',
    cta: 'Почати в Telegram',
    contactCta: 'Написати нам',
    points: [
      {
        title: 'Одна анкета — всі кандидати',
        description:
          'AI пропонує питання під вакансію, людина затверджує. Всі кандидати пулу відповідають на той самий набір — порівняння стає чесним.',
      },
      {
        title: 'Покриття замість «AI-балу»',
        description:
          'Прозора метрика: скільки обовʼязкових питань реально прозвучало й закрито в завершених інтервʼю. Жодного прихованого рейтингу людей.',
      },
      {
        title: 'Compliance-прапорці у вимогах',
        description:
          'Формулювання на кшталт «до 35 років» підсвічуються категорією та дослівною цитатою під час налаштування пулу — а не вичищаються мовчки.',
      },
      {
        title: 'Команда і звіти',
        description:
          'Спільна база кандидатів за інвайтами, дозапити матеріалів, зведений звіт клієнту з воронкою за стадіями.',
      },
    ],
  },
  boundaries: {
    title: 'Чесні межі',
    intro: 'Це не примітка дрібним шрифтом — це те, чим продукт відрізняється.',
    items: [
      { title: 'Не детектор брехні', description: 'Продукт ніколи не стверджує, що людина бреше, і не оцінює «шанси» кандидата.' },
      { title: 'Не джоб-борд', description: 'Ми не публікуємо і не агрегуємо вакансії. Ви приносите посилання — ми розбираємо саме його.' },
      { title: 'Рішення ухвалює людина', description: 'AI готує матеріал: чернетки, покриття критеріїв, питання. Затверджуєте, відгукуєтесь і наймаєте — ви.' },
      { title: 'CV лише з ваших слів', description: 'Ані вигаданого досвіду, ані «покращених» цифр. Чого ви не казали — того в CV немає.' },
    ],
  },
  privacy: {
    title: 'Приватність',
    items: [
      'Ваші дані живуть у вашому проєкті й не публікуються без вашої явної дії — будь-яке публічне посилання створюєте й відкликаєте ви. Ми не відгукуємось на вакансії за вас.',
      'Кожне використання AI і записів закрите явною згодою — її можна відкликати.',
      'Голосовий ввід іде з браузера напряму в сервіс розпізнавання мовлення за короткоживучим токеном — через наш сервер аудіо не проходить, і ми його не зберігаємо. Розпізнає зовнішній провайдер (Soniox для української та російської, AssemblyAI для англійської) — кому саме йде звук, названо в тексті згоди.',
    ],
  },
  faq: {
    title: 'Питання',
    items: [
      { q: 'Ви публікуєте моє CV чи дані?', a: 'Ні. CV і розбори живуть лише у вашому проєкті. Назовні йде тільки те, що ви самі надішлете роботодавцю.' },
      { q: 'Ви відгукуєтесь на вакансії за мене?', a: 'Ні. Продукт готує матеріал — CV, розбір вакансії, питання для уточнення. Відгукуєтесь ви самі.' },
      { q: 'Які джоб-сайти підтримуються?', a: 'Будь-які: ви приносите посилання на сторінку вакансії, продукт розбирає саме її. Жоден сайт не «інтегрований» і не має переваги.' },
      { q: 'AI вирішує, чи підходжу я на вакансію?', a: 'Ні. Розбір показує покриття ваших критеріїв і що варто уточнити. Слів «підходить» чи «не підходить» у ньому немає навмисно.' },
      { q: 'Як агенція порівнює кандидатів?', a: 'За покриттям однакової затвердженої анкети в завершених інтервʼю — прозора лічильна метрика, не прихований бал.' },
      { q: 'Скільки це коштує?', a: 'Продукт на стадії запуску — актуальні умови в боті. Жодних платних «підняттів» CV чи пріоритетів у видачі не існує.' },
    ],
  },
  finalCta: { title: 'Готові спробувати?', candidates: 'Я шукаю роботу', agencies: 'Я наймаю' },
};

const en: JobsDictionary = {
  navLabel: 'Jobs and hiring',
  meta: {
    title: "Devil's Advocate — prepare for a job search or for hiring",
    description:
      'A CV built strictly from your own words, vacancy breakdowns against your criteria, and honest interview pools for recruiting. No hidden AI scores, no lie detection — humans make the decisions.',
  },
  hero: {
    badge: 'Jobs',
    headline: 'Prepare for your job search. Or for hiring.',
    subheadline:
      'Candidates get a CV built from their own words and vacancy breakdowns against their criteria. Agencies get identical questions for every candidate and transparent coverage instead of an “AI score”.',
    tabCandidates: 'I’m job hunting',
    tabAgencies: 'I’m hiring',
    tabsLabel: 'Choose your audience',
  },
  candidates: {
    title: 'For candidates: three steps',
    cta: 'Start in Telegram',
    steps: [
      {
        title: 'Tell your story — voice works',
        description:
          'A short quiz in Telegram: role, experience, city, expectations. AI drafts a CV strictly from what you said — it invents nothing. An empty section is more honest than a made-up achievement. You approve the final text.',
      },
      {
        title: 'Bring vacancies from your local job sites',
        description:
          'A link to a vacancy from any site in your region. You get a breakdown against your criteria: what is covered, what is partial, what the posting never mentions, and what to clarify before applying. No “fit / no fit” verdict — that decision is yours.',
      },
      {
        title: 'Watch the statistics of your search',
        description:
          'How many of your collected vacancies are in your city and region, on which sites, where a salary is stated, and how many fully cover your must-have criteria. Counted from your vacancies — no magic.',
      },
    ],
  },
  agencies: {
    title: 'For agencies and HR teams',
    cta: 'Start in Telegram',
    contactCta: 'Email us',
    points: [
      { title: 'One questionnaire — every candidate', description: 'AI proposes questions for the role, a human approves them. Every candidate in the pool answers the same set — comparison becomes fair.' },
      { title: 'Coverage instead of an “AI score”', description: 'A transparent metric: how many required questions were actually asked and covered in completed interviews. No hidden rating of people.' },
      { title: 'Compliance flags in requirements', description: 'Wording like “under 35” is flagged with a category and a verbatim quote during pool setup — not silently scrubbed.' },
      { title: 'Teams and reports', description: 'A shared candidate base via invites, follow-up requests, and a client-facing summary report with a stage funnel.' },
    ],
  },
  boundaries: {
    title: 'Honest boundaries',
    intro: 'This is not fine print — it is what sets the product apart.',
    items: [
      { title: 'Not a lie detector', description: 'The product never claims a person is lying and never rates a candidate’s “chances”.' },
      { title: 'Not a job board', description: 'We do not publish or aggregate vacancies. You bring a link — we analyse exactly that page.' },
      { title: 'Humans decide', description: 'AI prepares material: drafts, criteria coverage, questions. Approving, applying and hiring is done by you.' },
      { title: 'A CV from your words only', description: 'No invented experience, no “improved” numbers. If you did not say it, it is not in the CV.' },
    ],
  },
  privacy: {
    title: 'Privacy',
    items: [
      'Your data lives in your own project and is not published unless you explicitly choose to — any public link is created and revoked by you. We do not apply to vacancies on your behalf.',
      'Every use of AI and recording is gated by explicit consent — which you can withdraw.',
      'Voice input streams from your browser directly to the speech-recognition service via a short-lived token — it does not pass through our server and we do not store it. Recognition is done by an external provider (Soniox for Ukrainian and Russian, AssemblyAI for English) — the consent text names who receives the audio.',
    ],
  },
  faq: {
    title: 'Questions',
    items: [
      { q: 'Do you publish my CV or data?', a: 'No. Your CV and breakdowns live only in your project. The only thing that leaves is what you yourself send to an employer.' },
      { q: 'Do you apply to vacancies for me?', a: 'No. The product prepares material — a CV, a vacancy breakdown, questions to clarify. Applying is up to you.' },
      { q: 'Which job sites are supported?', a: 'Any of them: you bring a link to a vacancy page and the product analyses exactly that page. No site is “integrated” or privileged.' },
      { q: 'Does AI decide whether I fit a vacancy?', a: 'No. The breakdown shows the coverage of your criteria and what to clarify. The words “fit” or “no fit” are deliberately absent.' },
      { q: 'How do agencies compare candidates?', a: 'By coverage of the same approved questionnaire across completed interviews — a transparent countable metric, not a hidden score.' },
      { q: 'What does it cost?', a: 'The product is launching — current terms are in the bot. There are no paid CV “boosts” or ranking priorities.' },
    ],
  },
  finalCta: { title: 'Ready to try?', candidates: 'I’m job hunting', agencies: 'I’m hiring' },
};

const dictionaries: Record<Locale, JobsDictionary> = { en, uk, ru };

export function getJobsDictionary(locale: Locale): JobsDictionary {
  return dictionaries[locale];
}
