// Пункт [job-landing-attribution] 2026-09-02 — откуда пришёл пользователь.
//
// ТЗ job-landing §4 требует, чтобы кнопки лендинга вели в бота с
// параметром (`jobs_landing` / `recruiting_landing`), а UTM-метки
// доезжали «как есть». Аудит зафиксировал ОБЕ половины невыполненными:
// лендинг клеил параметр в форме, которую Telegram для ссылки на Mini
// App игнорирует, а приложение start_param не читало вообще — во всём
// монорепо не было ни одного упоминания.
//
// Здесь — сторона приложения: разбор параметра запуска. Формат общий с
// `telegramStartUrl` лендинга: `<источник>__<кампания>`, оба сегмента
// из [A-Za-z0-9_-]. Менять только парой.
import { getTelegramWebApp } from './telegram';

export type LandingAudience = 'candidate' | 'agency';

export interface StartAttribution {
  /** Параметр запуска КАК ПРИШЁЛ — по нему решается переход. */
  raw: string;
  /** Источник: для посадочных — jobs_landing/recruiting_landing. */
  source: string;
  /** Метка кампании (utm_source лендинга), если была. */
  campaign: string | null;
  /** Аудитория, если параметр — с одной из посадочных /jobs. */
  audience: LandingAudience | null;
}

const AUDIENCE_BY_SOURCE: Record<string, LandingAudience> = {
  jobs_landing: 'candidate',
  recruiting_landing: 'agency',
};

/** Разбор параметра запуска. Некорректный или пустой — null: гадать,
 *  что имелось в виду, хуже, чем не знать источник. */
export function parseStartPayload(raw: string | null | undefined): StartAttribution | null {
  if (!raw) return null;
  const cleaned = raw.trim();
  if (!cleaned || cleaned.length > 64 || !/^[A-Za-z0-9_-]+$/.test(cleaned)) return null;

  // `__` — разделитель ТОЛЬКО для известных посадочных. Токены
  // приглашений — base64url, в них `__` встречается как обычные
  // символы, и делить их по нему значило бы портить токен.
  for (const [source, audience] of Object.entries(AUDIENCE_BY_SOURCE)) {
    if (cleaned === source) return { raw: cleaned, source, campaign: null, audience };
    if (cleaned.startsWith(`${source}__`)) {
      const campaign = cleaned.slice(source.length + 2);
      return { raw: cleaned, source, campaign: campaign || null, audience };
    }
  }

  return { raw: cleaned, source: cleaned, campaign: null, audience: null };
}

/**
 * Параметр запуска текущего сеанса.
 *
 * Telegram кладёт его в `initDataUnsafe.start_param` (и для `start=`, и
 * для `startapp=`). Читаем ИМЕННО отсюда — а не из адресной строки:
 * подписанная часть initData остаётся единственным источником правды
 * для авторизации, но сама метка источника не является утверждением о
 * правах, поэтому unsafe-копии для неё достаточно.
 */
export function currentStartAttribution(): StartAttribution | null {
  const webApp = getTelegramWebApp() as { initDataUnsafe?: { start_param?: string } } | null;
  const fromTelegram = parseStartPayload(webApp?.initDataUnsafe?.start_param);
  if (fromTelegram) return fromTelegram;

  // Dev-режим вне Telegram: ?start=jobs_landing в адресной строке —
  // чтобы путь с лендинга можно было пройти в браузере.
  if (typeof window === 'undefined') return null;
  const params = new URLSearchParams(window.location.search);
  return parseStartPayload(params.get('startapp') ?? params.get('start'));
}

/**
 * Пункт [deep-links] 2026-09-02 — куда вести по параметру запуска.
 *
 * Токены приглашений (`share_`, `team_share_`, `team_`,
 * `investment_group_`) выдавались бэкендом ссылками, но приложение
 * start_param не читало вовсе: экран /candidate-shares/[token] был
 * физически недостижим, а «поделиться кандидатом» не доводилось до
 * конца ни разу. null — параметр не про переход (метка источника с
 * лендинга) либо параметра нет.
 */
export function startParamRoute(attribution: StartAttribution | null): string | null {
  if (!attribution) return null;
  const { raw } = attribution;

  if (raw.startsWith('team_share_')) return `/candidate-shares/${raw.slice('team_share_'.length)}`;
  if (raw.startsWith('share_')) return `/candidate-shares/${raw.slice('share_'.length)}`;
  if (raw.startsWith('team_')) return `/domains/interview-pool?invite=${raw.slice('team_'.length)}`;
  if (raw.startsWith('investment_group_')) return `/domains/investment?invite=${raw.slice('investment_group_'.length)}`;

  // Посадочные /jobs: аудитория известна, ведём сразу в квиз — он и
  // классифицирует сценарий (ТЗ job-landing §4: отдельного
  // onboarding-пути не нужно).
  if (attribution.audience) return '/intake';
  return null;
}
