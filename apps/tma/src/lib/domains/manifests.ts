// ТЗ §0 — шесть манифестов. Пути — полные, как в декораторах контроллеров
// (interview-pool/investment — @Controller() без префикса; самоаудит ТЗ §4).
import { DomainId, DomainManifest, ExtraPanelSpec, FieldSpec, SessionSpec } from './types';

const opt = (values: string[], labels?: Record<string, string>) =>
  values.map((v) => ({ value: v, label: labels?.[v] ?? v }));

const CURRENCY: FieldSpec = { name: 'currency', label: 'Валюта', type: 'text', hint: 'UAH, USD, EUR…' };
const CRITERIA_BASE: FieldSpec[] = [
  { name: 'goalDescription', label: 'Цель', type: 'textarea', required: true },
  { name: 'targetBudget', label: 'Целевой бюджет', type: 'money', currencyField: 'currency' },
  CURRENCY,
];

function consultationSessions(prefix: string, opts: { withCost?: boolean } = {}): SessionSpec {
  return {
    label: 'Консультации', singular: 'Консультация',
    listRoute: (id) => `${prefix}/${id}/consultations`,
    createRoute: (id) => `${prefix}/${id}/consultations`,
    fields: [
      { name: 'occurredAt', label: 'Когда состоялась', type: 'datetime', required: true },
      ...(opts.withCost ? [{ name: 'estimatedCost', label: 'Ориентировочная стоимость', type: 'money' } as FieldSpec] : []),
      { name: 'conversationId', label: 'ID записи разговора (если есть)', type: 'text', hint: 'Из раздела «Разговоры» проекта' },
    ],
    generateRoute: () => '', // заполняется ниже per-domain
    generateLabel: 'Разобрать консультацию',
    reviewRoute: () => '',
    reviewFields: [{ name: 'reviewNotes', label: 'Заметки по разбору', type: 'textarea' }],
  };
}

function budgetPanel(domainPrefix: string, categories: string[]): ExtraPanelSpec {
  return {
    key: 'budget', label: 'Бюджет', kind: 'budget',
    route: (id) => `/${domainPrefix}/configs/${id}/budget`,
    budgetCreateRoute: (id) => `/${domainPrefix}/configs/${id}/budget-line-items`,
    budgetFields: [
      { name: 'category', label: 'Категория', type: 'select', required: true, options: opt(categories) },
      { name: 'direction', label: 'Направление', type: 'select', required: true, options: opt(['EXPENSE', 'COVERAGE'], { EXPENSE: 'Расход', COVERAGE: 'Покрытие' }) },
      { name: 'amount', label: 'Сумма', type: 'money', required: true },
      CURRENCY,
      { name: 'description', label: 'Описание', type: 'text' },
    ],
  };
}

function standardRoutes(prefix: string): DomainManifest['routes'] {
  return {
    listProjects: `/${prefix}/projects`,
    createProject: `/${prefix}/projects`,
    createOnboarding: (p) => `/${prefix}/projects/${p}/onboarding-conversations`,
    getOnboarding: (c) => `/${prefix}/onboarding-conversations/${c}`,
    appendAnswer: (c) => `/${prefix}/onboarding-conversations/${c}/answers`,
    extract: (c) => `/${prefix}/onboarding-conversations/${c}/extract`,
    createConfig: (p) => `/${prefix}/projects/${p}/config`,
    getConfig: (p) => `/${prefix}/projects/${p}/config`,
  };
}

const comparison = (prefix: string): ExtraPanelSpec => ({ key: 'comparison', label: 'Сравнение', kind: 'comparison-table', route: (id) => `/${prefix}/configs/${id}/comparison-table` });
const crossCheck = (prefix: string): ExtraPanelSpec => ({ key: 'cross-check', label: 'Сверка консультаций', kind: 'json', route: (id) => `/${prefix}/configs/${id}/cross-consultation-check` });
const protocolDraft = (prefix: string): ExtraPanelSpec => ({ key: 'protocol', label: 'Проект соглашения', kind: 'json', route: (id) => `/${prefix}/configs/${id}/settlement-protocol-draft` });

// ── ДТП ──
const dtpSessions = { ...consultationSessions('/dtp/advisors', { withCost: true }), generateRoute: (s: string) => `/dtp/consultations/${s}/generate-breakdown`, reviewRoute: (s: string) => `/dtp/consultations/${s}/review`, detailRoute: (s: string) => `/dtp/consultations/${s}` };
const dtp: DomainManifest = {
  id: 'dtp', title: 'ДТП', icon: '🚗', tagline: 'Вина, ущерб, страховка — разбор консультаций и доказательная фиксация',
  routes: standardRoutes('dtp'),
  configFields: [...CRITERIA_BASE, { name: 'occurredAt', label: 'Когда произошло', type: 'datetime' }],
  hasCriteria: true, criteriaCategories: ['FAULT_DETERMINATION', 'DAMAGE_AND_REPAIR', 'INSURANCE_COVERAGE', 'OTHER'],
  entities: [
    { key: 'advisors', label: 'Консультанты', singular: 'Консультант', titleField: 'label',
      listRoute: (c) => `/dtp/configs/${c}/advisors`, createRoute: (c) => `/dtp/configs/${c}/advisors`,
      fields: [{ name: 'label', label: 'Метка', type: 'text', required: true }, { name: 'advisorName', label: 'Имя', type: 'text' }, { name: 'role', label: 'Роль (юрист/оценщик/страховой)', type: 'text' }],
      sessions: dtpSessions },
    { key: 'participants', label: 'Участники', singular: 'Участник', titleField: 'role',
      listRoute: (c) => `/dtp/configs/${c}/participants`, createRoute: (c) => `/dtp/configs/${c}/participants`,
      fields: [{ name: 'role', label: 'Роль', type: 'select', required: true, options: opt(['SELF', 'OTHER_PARTY', 'THIRD_PARTY'], { SELF: 'Я', OTHER_PARTY: 'Другая сторона', THIRD_PARTY: 'Третье лицо' }) }, { name: 'displayName', label: 'Имя', type: 'text' }, { name: 'hasFledScene', label: 'Скрылся с места', type: 'bool' }],
      detailPanels: [{ key: 'insurance', label: 'Страховка', route: (id) => `/dtp/participants/${id}/insurance` }],
      actions: [{ key: 'insurance', label: 'Указать страховку', route: (id) => `/dtp/participants/${id}/insurance`, fields: [{ name: 'hasInsurance', label: 'Есть страховка', type: 'bool', required: true }, { name: 'insurerName', label: 'Страховщик', type: 'text' }, { name: 'policyType', label: 'Тип полиса', type: 'text' }, { name: 'coverageAmount', label: 'Покрытие', type: 'money' }, CURRENCY] }] },
    { key: 'fault', label: 'Определение вины', singular: 'Запись', titleField: 'statusText',
      listRoute: (c) => `/dtp/configs/${c}/fault-determinations`, createRoute: (c) => `/dtp/configs/${c}/fault-determinations`,
      // source — enum DtpFaultSource на backend (400 «Unknown source» на свободный текст — аудит моделей 2026-08-30)
      fields: [{ name: 'source', label: 'Источник', type: 'select', required: true, options: opt(['POLICE', 'INSURANCE_COMPANY', 'COURT', 'MUTUAL_AGREEMENT', 'UNDETERMINED'], { POLICE: 'Полиция', INSURANCE_COMPANY: 'Страховая', COURT: 'Суд', MUTUAL_AGREEMENT: 'Взаимное соглашение', UNDETERMINED: 'Не определено' }) }, { name: 'statusText', label: 'Статус', type: 'text', required: true }, { name: 'determinedAt', label: 'Дата', type: 'datetime', required: true }, { name: 'isOfficial', label: 'Официальное', type: 'bool' }, { name: 'referenceDocumentNumber', label: 'Номер документа', type: 'text' }] },
    { key: 'evidence', label: 'Доказательства', singular: 'Файл', titleField: 'mediaType',
      listRoute: (c) => `/dtp/configs/${c}/evidence`, createRoute: (c) => `/dtp/configs/${c}/evidence`,
      fields: [{ name: 'base64Content', label: 'Фото/видео', type: 'file-base64', required: true }, { name: 'capturedAt', label: 'Снято', type: 'datetime', required: true }, { name: 'hasAudio', label: 'Со звуком', type: 'bool' }, { name: 'latitude', label: 'Широта', type: 'number' }, { name: 'longitude', label: 'Долгота', type: 'number' }],
      detailPanels: [{ key: 'access-log', label: 'Журнал доступа', route: (id) => `/dtp/evidence/${id}/access-log` }] },
  ],
  extras: [comparison('dtp'), budgetPanel('dtp', ['REPAIR', 'LEGAL_FEES', 'INSURANCE_DEDUCTIBLE', 'MEDICAL', 'OTHER']), crossCheck('dtp'), protocolDraft('dtp')],
};

// ── Семейное право ──
const flSessions: SessionSpec = { ...consultationSessions('/family-law/advisors', { withCost: true }), generateRoute: (s: string) => `/family-law/consultations/${s}/generate-breakdown`, reviewRoute: (s: string) => `/family-law/consultations/${s}/review`, detailRoute: (s: string) => `/family-law/consultations/${s}`,
  detailPanels: [{ key: 'mediation', label: 'Уведомление о медиации', route: (s) => `/family-law/consultations/${s}/mediation-notice` }] };
const familyLaw: DomainManifest = {
  id: 'family-law', title: 'Семейное право', icon: '⚖️', tagline: 'Брачный договор или раздел при разводе — сверка консультаций юристов',
  createProjectFields: [{ name: 'contractType', label: 'Тип', type: 'select', required: true, options: opt(['PRENUP', 'DIVORCE_SETTLEMENT'], { PRENUP: 'Брачный договор', DIVORCE_SETTLEMENT: 'Соглашение при разводе' }) }],
  routes: standardRoutes('family-law'),
  configFields: CRITERIA_BASE, hasCriteria: true, criteriaCategories: ['ASSET_DIVISION', 'FINANCIAL_SUPPORT', 'PROCESS_AND_COST', 'OTHER'],
  entities: [
    { key: 'advisors', label: 'Юристы', singular: 'Юрист', titleField: 'label', listRoute: (c) => `/family-law/configs/${c}/advisors`, createRoute: (c) => `/family-law/configs/${c}/advisors`,
      fields: [{ name: 'label', label: 'Метка', type: 'text', required: true }, { name: 'advisorName', label: 'Имя', type: 'text' }, { name: 'role', label: 'Роль', type: 'text' }],
      sessions: flSessions },
    { key: 'parties', label: 'Стороны', singular: 'Сторона', titleField: 'displayName', listRoute: (c) => `/family-law/configs/${c}/parties`, createRoute: (c) => `/family-law/configs/${c}/parties`,
      fields: [{ name: 'role', label: 'Роль', type: 'select', required: true, options: opt(['SELF', 'SPOUSE'], { SELF: 'Я', SPOUSE: 'Супруг(а)' }) }, { name: 'displayName', label: 'Имя', type: 'text' }] },
    { key: 'assets', label: 'Имущество', singular: 'Актив', titleField: 'assetType', listRoute: (c) => `/family-law/configs/${c}/assets`, createRoute: (c) => `/family-law/configs/${c}/assets`,
      fields: [{ name: 'assetType', label: 'Тип актива', type: 'text', required: true }, { name: 'description', label: 'Описание', type: 'text' }, { name: 'isMaritalProperty', label: 'Совместно нажитое', type: 'bool' }, { name: 'estimatedValue', label: 'Оценка', type: 'money' }, CURRENCY] },
    { key: 'status', label: 'Статусы', singular: 'Статус', titleField: 'statusText', listRoute: (c) => `/family-law/configs/${c}/status-determinations`, createRoute: (c) => `/family-law/configs/${c}/status-determinations`,
      // source — enum FamilyLawStatusSource на backend
      fields: [{ name: 'source', label: 'Источник', type: 'select', required: true, options: opt(['COURT_FILING', 'MEDIATION_AGREEMENT', 'INFORMAL_AGREEMENT', 'UNDETERMINED'], { COURT_FILING: 'Судебное дело', MEDIATION_AGREEMENT: 'Соглашение через медиацию', INFORMAL_AGREEMENT: 'Неформальная договорённость', UNDETERMINED: 'Не определено' }) }, { name: 'statusText', label: 'Статус', type: 'text', required: true }, { name: 'determinedAt', label: 'Дата', type: 'datetime', required: true }, { name: 'isOfficial', label: 'Официальное', type: 'bool' }, { name: 'referenceDocumentNumber', label: 'Номер документа', type: 'text' }] },
  ],
  extras: [comparison('family-law'), budgetPanel('family-law', ['ASSET_TRANSFER', 'LEGAL_FEES', 'SUPPORT_PAYMENT', 'OTHER']), crossCheck('family-law'), protocolDraft('family-law'),
    { key: 'goal-history', label: 'История цели', kind: 'json', route: (id) => `/family-law/configs/${id}/goal-history` }],
};

// ── Здоровье ──
const healthSessions = { ...consultationSessions('/health/providers', { withCost: true }), generateRoute: (s: string) => `/health/consultations/${s}/generate-breakdown`, reviewRoute: (s: string) => `/health/consultations/${s}/review`, detailRoute: (s: string) => `/health/consultations/${s}` };
const health: DomainManifest = {
  id: 'health', title: 'Здоровье', icon: '🩺', tagline: 'Второе мнение: сверка рекомендаций врачей, анализы, стоимость',
  requiredConsent: 'HEALTH_DATA',
  routes: standardRoutes('health'),
  configFields: CRITERIA_BASE, hasCriteria: true, criteriaCategories: ['PROCEDURE_NECESSITY', 'RISKS_AND_ALTERNATIVES', 'COST', 'OTHER'],
  entities: [
    { key: 'providers', label: 'Врачи', singular: 'Врач', titleField: 'label', listRoute: (c) => `/health/configs/${c}/providers`, createRoute: (c) => `/health/configs/${c}/providers`,
      fields: [{ name: 'label', label: 'Метка', type: 'text', required: true }, { name: 'providerName', label: 'Имя', type: 'text' }, { name: 'specialty', label: 'Специальность', type: 'text' }],
      sessions: healthSessions,
      detailPanels: [{ key: 'sources', label: 'Источники', route: (id) => `/health/providers/${id}/source-references` }],
      actions: [{ key: 'source', label: 'Добавить источник', route: (id) => `/health/providers/${id}/source-references`, fields: [{ name: 'sourceUrl', label: 'Ссылка', type: 'url', required: true }] }] },
    { key: 'labs', label: 'Анализы', singular: 'Документ', titleField: 'id', listRoute: (c) => `/health/configs/${c}/lab-documents`, createRoute: (c) => `/health/configs/${c}/lab-documents`,
      fields: [{ name: 'base64Content', label: 'Скан/фото', type: 'file-base64', required: true }],
      actions: [{ key: 'verify', label: 'Проверить (OCR)', route: (id) => `/health/lab-documents/${id}/verify`, fields: [] }] },
  ],
  extras: [comparison('health'), budgetPanel('health', ['PROCEDURE_COST', 'MEDICATION', 'INSURANCE_COVERAGE', 'OTHER'])],
};

// ── Инвестиции ──
const invSessions: SessionSpec = {
  label: 'Встречи', singular: 'Встреча',
  listRoute: (id) => `/investment/opportunities/${id}`, createRoute: (id) => `/investment/opportunities/${id}/meetings`, // GET отдаёт предложение с meetings[] (generic SessionPanel читает d.meetings)
  fields: [{ name: 'occurredAt', label: 'Когда', type: 'datetime', required: true }, { name: 'conversationId', label: 'ID записи разговора', type: 'text' }],
  generateRoute: (s) => `/investment/meetings/${s}/generate-breakdown`, generateLabel: 'Разобрать встречу',
  reviewRoute: (s) => `/investment/meetings/${s}/review`, reviewFields: [{ name: 'reviewNotes', label: 'Заметки', type: 'textarea' }],
};
const investment: DomainManifest = {
  id: 'investment', title: 'Инвестиции', icon: '📈', tagline: 'Предложения, гарантии доходности, комиссии — что вам недоговаривают',
  routes: { ...standardRoutes('investment') },
  configFields: CRITERIA_BASE, hasCriteria: true, criteriaCategories: ['RETURN_GUARANTEE', 'FEES_AND_LOSSES', 'TAXATION', 'OTHER'],
  entities: [
    { key: 'opportunities', label: 'Предложения', singular: 'Предложение', titleField: 'label', listRoute: (c) => `/investment/configs/${c}/opportunities`, createRoute: (c) => `/investment/configs/${c}/opportunities`,
      fields: [{ name: 'label', label: 'Название', type: 'text', required: true }, { name: 'advisorName', label: 'Советник', type: 'text' }, { name: 'advisorCompany', label: 'Компания', type: 'text' }],
      sessions: invSessions,
      actions: [{ key: 'source', label: 'Сверить с источником', route: (id) => `/investment/opportunities/${id}/source-comparisons`, fields: [{ name: 'sourceUrl', label: 'Ссылка', type: 'url', required: true }] }] },
  ],
  extras: [comparison('investment'), { key: 'group', label: 'Группа', kind: 'json', route: () => '' /* по projectId — см. DomainProjectPage */ }],
};

// ── Крупная покупка ──
const mpSessions: SessionSpec = {
  label: 'Встречи', singular: 'Встреча',
  listRoute: (id) => `/major-purchase/variants/${id}`, createRoute: (id) => `/major-purchase/variants/${id}/meetings`,
  detailRoute: (s) => `/major-purchase/meetings/${s}`,
  fields: [{ name: 'occurredAt', label: 'Когда', type: 'datetime', required: true }, { name: 'conversationId', label: 'ID записи разговора', type: 'text' }],
  generateRoute: (s) => `/major-purchase/meetings/${s}/generate-conclusion`, generateLabel: 'Сформировать вывод',
  reviewRoute: (s) => `/major-purchase/meetings/${s}/review-conclusion`, reviewFields: [{ name: 'conclusionFinal', label: 'Итоговый вывод (после правки)', type: 'textarea', required: true }],
};
const majorPurchase: DomainManifest = {
  id: 'major-purchase', title: 'Крупная покупка', icon: '🏠', tagline: 'Жильё или автомобиль — варианты, встречи, сравнение по критериям',
  routes: { ...standardRoutes('major-purchase'), createConfig: (p) => `/major-purchase/projects/${p}/configs`, checklist: (c) => `/major-purchase/onboarding-conversations/${c}/checklist` },
  configFields: [
    { name: 'category', label: 'Категория', type: 'select', required: true, options: opt(['REAL_ESTATE', 'VEHICLE'], { REAL_ESTATE: 'Недвижимость', VEHICLE: 'Транспорт' }) },
    { name: 'goalDescription', label: 'Цель', type: 'textarea', required: true },
    { name: 'budgetMin', label: 'Бюджет от', type: 'money' }, { name: 'budgetMax', label: 'Бюджет до', type: 'money' }, CURRENCY,
    { name: 'financingMethod', label: 'Финансирование', type: 'text' }, { name: 'timeline', label: 'Сроки', type: 'text' },
  ],
  hasCriteria: true,
  entities: [
    { key: 'variants', label: 'Варианты', singular: 'Вариант', titleField: 'label', listRoute: (c) => `/major-purchase/configs/${c}/variants`, createRoute: (c) => `/major-purchase/configs/${c}/variants`,
      fields: [{ name: 'label', label: 'Название', type: 'text', required: true }, { name: 'askingPrice', label: 'Запрашиваемая цена', type: 'money' }, CURRENCY],
      sessions: mpSessions,
      actions: [{ key: 'compare', label: 'Сверить с объявлением', route: (id) => `/major-purchase/variants/${id}/comparisons`, fields: [{ name: 'sourceUrl', label: 'Ссылка на объявление', type: 'url', required: true }] },
        { key: 'place', label: 'Локация по Place ID', method: 'PATCH', route: (id) => `/major-purchase/variants/${id}/location/place-id`, fields: [{ name: 'placeId', label: 'Google Place ID', type: 'text', required: true }] }] },
  ],
  extras: [comparison('major-purchase')],
};

// ── Подбор персонала ──
const interviewPool: DomainManifest = {
  id: 'interview-pool', title: 'Подбор персонала', icon: '🧑‍💼', tagline: 'Вакансия, опросник, воронка кандидатов, отчёты заказчику',
  routes: {
    listProjects: '/interview-pool/projects', createProject: '/interview-pool/projects',
    createOnboarding: (p) => `/interview-pool/projects/${p}/onboarding-conversations`,
    getOnboarding: (c) => `/interview-pool/onboarding-conversations/${c}`,
    appendAnswer: (c) => `/interview-pool/onboarding-conversations/${c}/answers`,
    extract: (c) => `/interview-pool/onboarding-conversations/${c}/extract`,
    checklist: () => '/interview-pool/onboarding-checklist',
    createConfig: (p) => `/interview-pool/projects/${p}/config`, getConfig: (p) => `/interview-pool/projects/${p}/config`,
  },
  configFields: [
    { name: 'jobTitle', label: 'Должность', type: 'text', required: true },
    { name: 'extendedDescription', label: 'Описание', type: 'textarea', required: true },
    { name: 'salaryRange', label: 'Зарплатная вилка', type: 'text' },
    { name: 'employmentLoad', label: 'Занятость', type: 'select', options: opt(['FULL_TIME', 'PART_TIME']) },
    { name: 'workArrangement', label: 'Формат', type: 'select', options: opt(['OFFICE', 'REMOTE', 'HYBRID']) },
    { name: 'officeLocation', label: 'Офис', type: 'text' },
    { name: 'isPhysicallyDemanding', label: 'Физически тяжёлая работа', type: 'bool' },
  ],
  hasCriteria: false,
  entities: [], // кандидаты/pipeline/опросник/команды — ручные компоненты фазы C (ТЗ §0)
  extras: [
    { key: 'compliance', label: 'Флаги соответствия', kind: 'json', route: () => '', projectRoute: (p) => `/interview-pool/projects/${p}/compliance-flags` },
  ],
};

// ── Поиск работы ──
// Повторный аудит 2026-09-01: седьмой манифест. Домен целиком был на
// бэкенде (12 эндпоинтов), а в TMA его не существовало — квиз отправлял
// в него и упирался в «Неизвестный сценарий». Сущности здесь на уровне
// ПРОЕКТА, а не конфига (`/job-search/projects/:id/vacancies`), поэтому
// generic EntityPanel (он параметризуется configId) не подходит и домен
// рисует своя вёрстка JobSearchWorkspace — тот же приём, что у
// investment/major-purchase.
const jobSearch: DomainManifest = {
  id: 'job-search', title: 'Поиск работы', icon: '💼',
  tagline: 'CV из вашего опыта и сверка вакансий с вашими критериями — без оценок «подходит/не подходит»',
  routes: standardRoutes('job-search'),
  configFields: [
    { name: 'desiredRole', label: 'Желаемая роль', type: 'text', required: true },
    { name: 'city', label: 'Город', type: 'text' },
    { name: 'region', label: 'Регион', type: 'text' },
    { name: 'salaryExpectation', label: 'Зарплатные ожидания', type: 'money', currencyField: 'currency' },
    CURRENCY,
    { name: 'employmentFormat', label: 'Формат', type: 'text', hint: 'офис / гибрид / удалёнка — своими словами' },
    { name: 'experienceSummary', label: 'Опыт кратко', type: 'textarea', hint: 'материал для CV; полный рассказ из онбординга тоже используется' },
  ],
  hasCriteria: true,
  criteriaCategories: ['ROLE_FIT', 'COMPENSATION', 'LOCATION', 'CONDITIONS', 'OTHER'],
  // Вакансии живут на проекте, не на конфиге — панель своя (см. выше).
  entities: [],
  extras: [],
};

// ── Найм в компанию ──
// Пункт [job-domain-v2] §7–§8.3: работодатель — компания, нанимающая себе.
// Конфиг создаётся пустым вместе с проектом (бриф разбирается до
// онбординга), поэтому generic-онбординг сюда не заходит: экран
// EmployerHiringWorkspace сам ведёт от «укажите компанию» к брифу, листу
// вакансии, кандидатам, офферу и агентствам.
const employerHiring: DomainManifest = {
  id: 'employer-hiring', title: 'Найм в компанию', icon: '🏢',
  tagline: 'Компания нанимает себе: бриф → лист условий → текст вакансии → собеседования → оффер. Не отбирает за вас',
  routes: {
    ...standardRoutes('employer-hiring'),
    checklist: () => '/employer-hiring/onboarding-checklist',
  },
  configFields: [
    { name: 'jobTitle', label: 'Должность', type: 'text', required: true },
    { name: 'extendedDescription', label: 'Описание', type: 'textarea' },
    { name: 'salaryRange', label: 'Оплата / вилка', type: 'text' },
    { name: 'employmentLoad', label: 'Занятость', type: 'select', options: opt(['FULL_TIME', 'PART_TIME']) },
    { name: 'workArrangement', label: 'Формат', type: 'select', options: opt(['OFFICE', 'REMOTE', 'HYBRID']) },
    { name: 'officeLocation', label: 'Локация', type: 'text' },
    { name: 'employmentFormat', label: 'Оформление', type: 'text' },
  ],
  hasCriteria: false,
  entities: [],
  extras: [],
};

const ALL_MANIFESTS: Record<DomainId, DomainManifest> = {
  dtp, 'family-law': familyLaw, health, investment, 'major-purchase': majorPurchase, 'interview-pool': interviewPool,
  'job-search': jobSearch, 'employer-hiring': employerHiring,
};

// Пункт [one-build-two-products] 2026-10-01 — ОДИН ВЫКЛЮЧАТЕЛЬ, а не
// форк дерева.
//
// ПОВОД — вопрос владельца: можно ли запустить модуль найма как
// самостоятельный продукт на своём домене. Срез показал, что связность
// job-экранов с остальным TMA практически нулевая, то есть дешёвый путь
// существует: второй домен, тот же API, сборка TMA только с доменами
// найма. Единственное, чего для этого не было, — способа СОБРАТЬ часть:
// механизма признаков (`features`) в этом приложении нет вовсе, и без
// него «job-only TMA» означало бы вторую ветку дерева, которую придётся
// держать в синхроне руками. Вторая ветка — это способ развести два
// продукта молча.
//
// КАК РАБОТАЕТ. `NEXT_PUBLIC_TMA_DOMAINS` — список идентификаторов
// доменов через запятую. Пусто или переменной нет ⇒ ВСЕ домены, то есть
// поведение ровно прежнее и ничего не нужно выставлять в существующих
// проектах. `NEXT_PUBLIC_TMA_DOMAINS=job-search,interview-pool,employer-hiring`
// даёт сборку для домена найма.
//
// Читается ЛИТЕРАЛЬНЫМ `process.env.NEXT_PUBLIC_TMA_DOMAINS` — иначе
// webpack не подставит значение в бандл. Это не стиль: ровно на этом
// продукт уже попадался (Пункт [the-bundler-does-not-read-variables]:
// чтение через параметр давало `undefined` в браузере при зелёной
// сборке).
//
// ЧЕГО ЭТОТ ВЫКЛЮЧАТЕЛЬ НЕ ДЕЛАЕТ, и это важнее того, что делает:
//  • он НЕ защита. Сервер отдаёт все маршруты всем; выключенный домен
//    просто не показан в этой сборке. Кто знает адрес API, дойдёт до
//    него напрямую — права проверяет сервер, и только он;
//  • он не делит пользователей и проекты: `User` и `Project` общие, один
//    человек — один аккаунт в обоих продуктах. Это может быть и
//    особенностью, и неожиданностью для владельца — названо здесь, чтобы
//    решение было осознанным;
//  • неизвестный идентификатор в списке молча НЕ игнорируется — иначе
//    опечатка в переменной окружения дала бы продукт без половины
//    экранов и без единого слова об этом.
const ENABLED_RAW = (process.env.NEXT_PUBLIC_TMA_DOMAINS ?? '').trim();

function selectManifests(): Record<DomainId, DomainManifest> {
  if (!ENABLED_RAW) return ALL_MANIFESTS;
  const wanted = ENABLED_RAW.split(',').map((s) => s.trim()).filter(Boolean);
  const known = Object.keys(ALL_MANIFESTS);
  const unknown = wanted.filter((w) => !known.includes(w));
  if (unknown.length > 0) {
    throw new Error(
      `NEXT_PUBLIC_TMA_DOMAINS содержит неизвестные домены: ${unknown.join(', ')}. ` +
        `Известные: ${known.join(', ')}. Сборка остановлена намеренно: опечатка здесь дала бы ` +
        'продукт без части экранов и ничего бы об этом не сказала.',
    );
  }
  const picked: Partial<Record<DomainId, DomainManifest>> = {};
  for (const id of known) {
    if (wanted.includes(id)) picked[id as DomainId] = ALL_MANIFESTS[id as DomainId];
  }
  return picked as Record<DomainId, DomainManifest>;
}

export const DOMAIN_MANIFESTS: Record<DomainId, DomainManifest> = selectManifests();

/** Все домены, которые продукт знает, независимо от сборки. Нужен там,
 *  где вопрос «а такой домен вообще существует» отличается от «показан
 *  ли он здесь»: например при разборе `start_param` со ссылки. */
export const ALL_DOMAIN_IDS: string[] = Object.keys(ALL_MANIFESTS);

export const DOMAIN_LIST: DomainManifest[] = Object.values(DOMAIN_MANIFESTS);

/** Включён ли домен в ЭТОЙ сборке. */
export function domainEnabled(id: string): boolean {
  return Object.prototype.hasOwnProperty.call(DOMAIN_MANIFESTS, id);
}

export function getManifest(id: string): DomainManifest | null {
  return (DOMAIN_MANIFESTS as Record<string, DomainManifest>)[id] ?? null;
}
