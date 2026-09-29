// Пункт [job-domain-v2] связка Т — детерминированные проверки текста вакансии
// (А-12 текст против конфига, А-13 требования ↔ анкета, А-15 читаемость,
// А-17 варианты-срезы, А-19 прозрачность оплаты). Чистые функции без AI и
// без БД: то, что можно проверить без модели, проверяется без модели.
// Никакого числа-«качества текста»: только списки с цитатами.

import type { TermsClauseKind, TermsSide } from '@prisma/client';

export interface ClauseLite {
  id: string;
  side: TermsSide;
  kind: TermsClauseKind;
  text: string;
  isRequired: boolean;
  sourceQuestionnaireItemId: string | null;
  sourceEvidence: string | null;
  sourceQuote: string | null;
}

export interface ConfigLite {
  jobTitle: string;
  salaryRange: string | null;
  workArrangement: string | null;
  officeLocation: string | null;
  employmentLoad: string | null;
  questions: Array<{ id: string; text: string }>;
}

export interface PostingChecks {
  salaryDisclosed: boolean;
  salarySuggestion: string | null;
  pastSalaryQuestion: string[]; // вопросы анкеты про прошлую зарплату (А-19)
  configDiscrepancies: Array<{ field: string; inConfig: string; inText: string | null; note: string }>;
  readability: Array<{ kind: 'long_sentence' | 'abbreviation' | 'unverifiable'; quote: string; suggestion: string }>;
  clauseLinks: {
    requirementsWithoutQuestion: Array<{ clauseId: string; text: string }>;
    questionsWithoutRequirementInText: Array<{ questionId: string; text: string }>;
    requirementsNotInText: Array<{ clauseId: string; text: string }>;
  };
}

const STOP = new Set(['и', 'в', 'на', 'с', 'по', 'для', 'от', 'до', 'не', 'или', 'the', 'and', 'of', 'to', 'a', 'та', 'з', 'у', 'для', 'від', 'опыт', 'досвід', 'знание', 'знання', 'работы', 'роботи', 'умение', 'вміння']);

/** Значимые слова (≥ 4 букв, не стоп-слова), для грубого «упоминается ли в тексте». */
export function keywords(s: string): string[] {
  return (s.toLowerCase().match(/[a-zа-яёіїєґ0-9+#.]{3,}/g) ?? []).filter((w) => w.length >= 4 && !STOP.has(w)).map((w) => w.replace(/[.]+$/, ''));
}

export function mentionedIn(text: string, phrase: string): boolean {
  const t = text.toLowerCase();
  const ks = keywords(phrase);
  if (ks.length === 0) return t.includes(phrase.toLowerCase());
  // корень: первые 5 символов слова, чтобы «продаж» ловило «продажи/продажах»
  const hits = ks.filter((k) => t.includes(k.slice(0, Math.min(k.length, 6))));
  return hits.length >= Math.ceil(ks.length / 2);
}

const SALARY_RE = /(\d[\d\s]{2,}|\d+k)\s*(грн|uah|₴|\$|usd|€|eur|евро|долл|тыс|к)\b|(зарплат|оплат|salary|винагород|вилк)[^.\n]{0,40}\d/i;
const PAST_SALARY_RE = /(прошл|предыдущ|текущ|попередн|поточн|current|previous|last)[^.\n]{0,30}(зарплат|оклад|salary|оплат|винагород)|(зарплат|salary|оплат)[^.\n]{0,30}(прошл|предыдущ|текущ|попередн|поточн|на прошлом месте)/i;
const UNVERIFIABLE = ['стрессоустойчив', 'стресостійк', 'коммуникабельн', 'комунікабельн', 'проактивн', 'многозадачн', 'багатозадачн', 'амбициозн', 'амбіційн', 'энергичн', 'енергійн', 'позитивн', 'командный игрок', 'командний гравець', 'stress-resistant', 'team player', 'self-starter'];
const KNOWN_ABBR = new Set(['CRM', 'ERP', 'SQL', 'API', 'HTML', 'CSS', 'AWS', 'GCP', 'CI', 'CD', 'QA', 'HR', 'PDF', 'B2B', 'B2C', 'IT', 'SEO', 'SMM', 'PPC', 'KPI', 'UX', 'UI', 'REST', 'JSON', 'XML', 'ООО', 'ТОВ', 'ФОП', 'ФЛП', 'ПП', 'USD', 'EUR', 'UAH', 'ЗП', 'ІТ', 'ЄС', 'EU', 'US', 'UK', 'DOU', 'OK']);

export function readabilityIssues(text: string): PostingChecks['readability'] {
  const out: PostingChecks['readability'] = [];
  const sentences = text.split(/(?<=[.!?])\s+|\n+/).map((s) => s.trim()).filter(Boolean);
  for (const s of sentences) {
    const words = s.split(/\s+/).length;
    if (words > 30) out.push({ kind: 'long_sentence', quote: s.slice(0, 200), suggestion: `Предложение из ${words} слов — разбейте на два-три` });
  }
  const abbrs = new Set((text.match(/\b[A-ZА-ЯІЇЄҐ]{3,6}\b/g) ?? []).filter((a) => !KNOWN_ABBR.has(a)));
  for (const a of abbrs) {
    const expanded = new RegExp(`${a}\\s*\\(|\\(\\s*${a}\\s*\\)`).test(text);
    if (!expanded) out.push({ kind: 'abbreviation', quote: a, suggestion: 'Аббревиатура без расшифровки — раскройте при первом упоминании' });
  }
  const lower = text.toLowerCase();
  for (const u of UNVERIFIABLE) {
    const idx = lower.indexOf(u);
    if (idx >= 0) out.push({ kind: 'unverifiable', quote: text.slice(idx, idx + u.length + 20), suggestion: 'Требование, которое нельзя проверить на собеседовании — замените наблюдаемым поведением или уберите' });
  }
  return out;
}

export function runPostingChecks(text: string, config: ConfigLite, clauses: ClauseLite[]): PostingChecks {
  const salaryDisclosed = (!!config.salaryRange && text.includes(config.salaryRange)) || SALARY_RE.test(text);
  const salarySuggestion = salaryDisclosed
    ? null
    : config.salaryRange
      ? `Оплата: ${config.salaryRange}`
      : 'В тексте и в конфиге нет диапазона оплаты — начальный уровень или вилку сообщают в объявлении или до собеседования';
  const pastSalaryQuestion = config.questions.filter((q) => PAST_SALARY_RE.test(q.text)).map((q) => q.text);

  const configDiscrepancies: PostingChecks['configDiscrepancies'] = [];
  const arrangementWords: Record<string, string[]> = {
    REMOTE: ['удалён', 'віддален', 'remote', 'дистанц'],
    OFFICE: ['офис', 'офіс', 'office', 'on-site'],
    HYBRID: ['гибрид', 'гібрид', 'hybrid'],
  };
  if (config.workArrangement) {
    const lower = text.toLowerCase();
    const own = arrangementWords[config.workArrangement] ?? [];
    const others = Object.entries(arrangementWords).filter(([k]) => k !== config.workArrangement).flatMap(([, v]) => v);
    const otherHit = others.find((w) => lower.includes(w));
    const ownHit = own.some((w) => lower.includes(w));
    if (otherHit && !ownHit) {
      const idx = lower.indexOf(otherHit);
      configDiscrepancies.push({ field: 'workArrangement', inConfig: config.workArrangement, inText: text.slice(idx, idx + 40), note: 'В тексте формат работы не совпадает с конфигом' });
    }
  }
  if (config.officeLocation && !text.toLowerCase().includes(config.officeLocation.toLowerCase().split(',')[0].trim())) {
    configDiscrepancies.push({ field: 'officeLocation', inConfig: config.officeLocation, inText: null, note: 'Локация из конфига в тексте не названа' });
  }
  if (config.salaryRange && !text.includes(config.salaryRange) && SALARY_RE.test(text)) {
    configDiscrepancies.push({ field: 'salaryRange', inConfig: config.salaryRange, inText: (text.match(SALARY_RE) ?? [''])[0], note: 'В тексте названа другая оплата, чем в конфиге' });
  }

  const requirements = clauses.filter((c) => c.side === 'EMPLOYER' && c.kind === 'REQUIREMENT');
  const clauseLinks: PostingChecks['clauseLinks'] = {
    // А-13 — инфляция требований. ИСПРАВЛЕНО АУДИТОМ 2026-09-03: здесь стоял
    // дополнительный фильтр `mentionedIn(text, c.text)`, то есть требование
    // показывалось, только если оно УЖЕ попало в текст объявления. А инфляция
    // — это ровно обратный случай: требование живёт в листе, вопроса о нём в
    // анкете нет, и проверять его на собеседовании никто не будет. Фильтр
    // прятал именно то, ради чего функция существует.
    requirementsWithoutQuestion: requirements.filter((c) => !c.sourceQuestionnaireItemId).map((c) => ({ clauseId: c.id, text: c.text })),
    questionsWithoutRequirementInText: config.questions.filter((q) => !mentionedIn(text, q.text)).map((q) => ({ questionId: q.id, text: q.text })),
    requirementsNotInText: requirements.filter((c) => c.isRequired && !mentionedIn(text, c.text)).map((c) => ({ clauseId: c.id, text: c.text })),
  };

  return { salaryDisclosed, salarySuggestion, pastSalaryQuestion, configDiscrepancies, readability: readabilityIssues(text), clauseLinks };
}

// ── Варианты-срезы (А-17): детерминированно, по разделам ──

export const POSTING_CHANNELS = ['full', 'short', 'telegram', 'career_page'] as const;
export type PostingChannel = (typeof POSTING_CHANNELS)[number];

export function splitSections(text: string): Array<{ title: string; body: string }> {
  const lines = text.split('\n');
  const sections: Array<{ title: string; body: string }> = [];
  let current = { title: '', body: '' };
  for (const line of lines) {
    const heading = /^(#+\s*|\*\*)?([^\n:]{2,60}):?\s*(\*\*)?$/.exec(line.trim());
    const isHeading = !!heading && line.trim().length < 60 && !/[.!?]$/.test(line.trim()) && line.trim() === line.trim().replace(/^[-•]/, '');
    if (isHeading && (current.body.trim() || current.title)) {
      sections.push(current);
      current = { title: heading![2].trim(), body: '' };
    } else if (isHeading && !current.title && !current.body.trim()) {
      current.title = heading![2].trim();
    } else {
      current.body += (current.body ? '\n' : '') + line;
    }
  }
  sections.push(current);
  return sections.filter((s) => s.title || s.body.trim());
}

export function deriveVariantText(text: string, channel: PostingChannel): string {
  if (channel === 'full') return text;
  const sections = splitSections(text);
  const render = (list: typeof sections) => list.map((s) => (s.title ? `${s.title}\n${s.body.trim()}` : s.body.trim())).join('\n\n').trim();
  if (channel === 'career_page') {
    // без раздела «как откликнуться» — у карьерной страницы своя кнопка
    return render(sections.filter((s) => !/отклик|відгук|apply|контакт/i.test(s.title)));
  }
  if (channel === 'short') {
    const head = sections[0];
    const req = sections.find((s) => /обязательн|требован|обов'язков|вимог|must|requirements/i.test(s.title));
    return render([head, ...(req ? [req] : [])].filter(Boolean)).slice(0, 900).trim();
  }
  // telegram: заголовок + первый абзац + требования, ≤ 1000 знаков
  const head = sections[0];
  const firstPara = head.body.trim().split(/\n\s*\n/)[0] ?? '';
  const req = sections.find((s) => /обязательн|требован|обов'язков|вимог|must|requirements/i.test(s.title));
  const parts = [head.title, firstPara, req ? `${req.title}\n${req.body.trim()}` : ''].filter(Boolean);
  return parts.join('\n\n').slice(0, 1000).trim();
}

/** Грубое определение языка текста: uk / ru / en. */
export function detectLang(text: string): string {
  if (/[іїєґ]/i.test(text)) return 'uk';
  if (/[а-яё]/i.test(text)) return 'ru';
  return 'en';
}

/** Построчный диф двух редакций — журнал (А-20). */
export function lineDiff(before: string, after: string): { added: string[]; removed: string[] } {
  const a = new Set(before.split('\n').map((l) => l.trim()).filter(Boolean));
  const b = new Set(after.split('\n').map((l) => l.trim()).filter(Boolean));
  return { added: [...b].filter((l) => !a.has(l)), removed: [...a].filter((l) => !b.has(l)) };
}
