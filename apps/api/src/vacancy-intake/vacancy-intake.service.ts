// Пункт [job-domain-v2] связка П (К-11, К-12, К-15, К-16, К-20, К-29) — приток
// вакансий соискателя БЕЗ джоб-борда (§3.6): продукт не хранит и не
// индексирует вакансии вне проекта пользователя, не обходит сайты по своей
// инициативе, не выдаёт «ленту» — обрабатывает то, что человек принёс сам:
// ссылку или HTML страницы результатов, ссылки из письма-рассылки (письмо
// разбирает клиент), вставленный текст, пересланное боту сообщение,
// экспорт истории откликов. Загрузка — тем же fetchUrlText с потолками;
// ToS площадок и robots.txt — на стороне пользователя как инициатора.
//
// «Кандидат в базу» (VacancyCandidate) — заголовок и ссылка БЕЗ содержимого:
// потолок 200 с автоочисткой старше 30 дней; в потолок 50 загруженных
// вакансий (MAX_VACANCIES_PER_CONFIG) считаются только загруженные.
//
// К-15 — дедупликация детерминированно (contentHash нормализованного текста
// + заголовок/компания), группа дублей с главной вакансией; лист один — на
// главную. К-16 — слежение включает пользователь per-вакансия, повторная
// загрузка ≤ 1/сутки (429), 404 источника — изменение, не ошибка; тик
// pg_cron — POST /internal/job-search/refetch порцией 20. К-20 — пересылка
// боту: forward_origin/forward_from отбрасываются на входе (персональные
// данные автора канала), проект выбирается в диалоге бота.

import { takeSource, type SourceIntake } from '../common/source-intake';
import { BadRequestException, HttpException, HttpStatus, Injectable, NotFoundException } from '@nestjs/common';
import { JobVacancyResponseStatus, ProjectMode, VacancyIntakeSource } from '@prisma/client';
import { createHash } from 'crypto';
import { PrismaService } from '../prisma/prisma.service';
import { fetchUrlText, UnsafeUrlError, UrlFetchError, isUrlSafeToFetch } from '../common/safe-url-fetch';
import { assertOwnedJobSearchProject } from '../job-search/job-search-access';
import { availabilityNote } from './source-availability';

export const MAX_VACANCIES_PER_CONFIG = 50;
export const MAX_CANDIDATES_PER_CONFIG = 200;
export const CANDIDATE_TTL_DAYS = 30;
export const MAX_VACANCY_TEXT_CHARS = 12_000;
/** Окно, в котором повторная доставка того же пересланного текста считается
 * ретраем Telegram, а не новой вакансией (К-20). */
export const FORWARD_RETRY_WINDOW_MS = 10 * 60 * 1000;
export const REFETCH_MIN_INTERVAL_MS = 24 * 60 * 60 * 1000;
export const REFETCH_BATCH = 20;

class TooManyRequestsException extends HttpException {
  constructor(message: string) {
    super({ message, statusCode: HttpStatus.TOO_MANY_REQUESTS }, HttpStatus.TOO_MANY_REQUESTS);
  }
}

// ── Чистые функции (тестируются отдельно) ──

/** Ссылки и заголовки со страницы результатов (HTML) — без содержимого. */
export function extractSearchResults(html: string, baseUrl?: string): Array<{ title: string; url: string; company: string | null }> {
  const out: Array<{ title: string; url: string; company: string | null }> = [];
  const seen = new Set<string>();
  const re = /<a\b[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html)) && out.length < MAX_CANDIDATES_PER_CONFIG) {
    const href = m[1].trim();
    const title = m[2].replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
    if (title.length < 6 || title.length > 160) continue;
    if (!/(vacanc|vacancy|jobs?\/|job-|\/job\/|\/vacancies\/|\/company\/|rabota|robota|work\.ua|djinni|dou\.ua|hh\.|linkedin\.com\/jobs)/i.test(href) && !/[а-яіїє]/i.test(title)) continue;
    let url: string;
    try {
      url = new URL(href, baseUrl).toString();
    } catch {
      continue;
    }
    if (!isUrlSafeToFetch(url) || seen.has(url)) continue;
    seen.add(url);
    out.push({ title, url, company: null });
  }
  return out;
}

/** Нормализованный хэш текста вакансии — основа дедупликации (К-15). */
export function contentHashOf(rawText: string): string {
  const norm = rawText
    .toLowerCase()
    .replace(/https?:\/\/\S+/g, ' ') // ссылки — шум для сравнения текста
    .replace(/\d{1,2}[./-]\d{1,2}[./-]\d{2,4}/g, ' ') // даты публикации
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return createHash('sha1').update(norm).digest('hex');
}

/** Похожесть заголовков: Жаккар по словам ≥ 4 символов. */
export function titleSimilarity(a: string | null, b: string | null): number {
  const ws = (s: string | null) => new Set((s ?? '').toLowerCase().match(/[\p{L}\p{N}]{4,}/gu) ?? []);
  const A = ws(a);
  const B = ws(b);
  if (A.size === 0 || B.size === 0) return 0;
  let inter = 0;
  for (const w of A) if (B.has(w)) inter++;
  return inter / (A.size + B.size - inter);
}

/** Диф двух редакций текста вакансии (К-16) — что исчезло, что появилось;
 * отдельно — исчезновение диапазона оплаты. */
export function vacancyTextDiff(before: string, after: string) {
  const sentences = (s: string) => new Set(s.split(/(?<=[.!?])\s+|\n+/).map((x) => x.trim()).filter((x) => x.length > 8));
  const A = sentences(before);
  const B = sentences(after);
  const salaryRe = /\d[\d\s]{2,}\s*(грн|uah|₴|\$|usd|€|eur)/i;
  return {
    added: [...B].filter((s) => !A.has(s)).slice(0, 50),
    removed: [...A].filter((s) => !B.has(s)).slice(0, 50),
    salaryRemoved: salaryRe.test(before) && !salaryRe.test(after),
    salaryAdded: !salaryRe.test(before) && salaryRe.test(after),
  };
}

/** Разбор принесённой истории откликов (К-29): строки «заголовок … статус … дата». */
const STATUS_WORDS: Array<[RegExp, JobVacancyResponseStatus]> = [
  [/отказ|відмов|rejected|declined|не подходит|не підход/i, JobVacancyResponseStatus.REJECTED],
  [/оффер|offer|пропозиц/i, JobVacancyResponseStatus.OFFER],
  [/собесед|интервью|співбес|interview|звонок|дзвінок/i, JobVacancyResponseStatus.INTERVIEW],
  [/просмотр|переглян|viewed|seen|прочитан/i, JobVacancyResponseStatus.VIEWED],
  [/отклик|відгук|applied|отправлен|надіслан|sent/i, JobVacancyResponseStatus.APPLIED],
  [/отозв|withdrawn|відклик/i, JobVacancyResponseStatus.WITHDRAWN],
];

export function parseResponsesExport(text: string): Array<{ title: string; status: JobVacancyResponseStatus; at: Date | null; raw: string }> {
  const out = [];
  for (const line of text.split('\n').map((l) => l.trim()).filter(Boolean)) {
    const cells = line.split(/[;\t|]|,(?=\S)/).map((c) => c.trim()).filter(Boolean);
    const joined = cells.join(' ');
    const status = STATUS_WORDS.find(([re]) => re.test(joined))?.[1];
    if (!status) continue;
    const dateMatch = joined.match(/(\d{4}-\d{2}-\d{2})|(\d{1,2}[./]\d{1,2}[./]\d{2,4})/);
    let at: Date | null = null;
    if (dateMatch) {
      const d = new Date(dateMatch[1] ?? dateMatch[2].split(/[./]/).reverse().join('-'));
      at = Number.isNaN(d.getTime()) ? null : d;
    }
    const title = cells.find((c) => c.length >= 6 && !STATUS_WORDS.some(([re]) => re.test(c)) && !/^\d/.test(c)) ?? cells[0];
    out.push({ title, status, at, raw: line });
  }
  return out;
}

/** Пересылка боту — только текст и ссылки; forward_origin/forward_from
 * не доходят даже до этой функции (контроллер принимает только text). */
export function sanitizeForwardedText(text: string): { rawText: string; sourceUrl: string | null; totalChars: number } {
  const urls = text.match(/https?:\/\/[^\s)]+/g) ?? [];
  const sourceUrl = urls.find((u) => isUrlSafeToFetch(u)) ?? null;
  // Пункт [stored-text-cut] 2026-09-06: длина ДО обрезки уходит дальше,
  // а не теряется здесь.
  const { text: rawText, intake } = takeSource(text.trim(), MAX_VACANCY_TEXT_CHARS);
  return { rawText, sourceUrl, totalChars: intake.total };
}

@Injectable()
export class VacancyIntakeService {
  constructor(private readonly prisma: PrismaService) {}

  private async config(userId: string, projectId: string) {
    await assertOwnedJobSearchProject(this.prisma, userId, projectId);
    const config = await this.prisma.jobSearchConfig.findUnique({ where: { projectId } });
    if (!config) throw new NotFoundException(`JobSearchConfig for project ${projectId} not found`);
    return config;
  }

  // ── Кандидаты в базу (К-11 / К-12) ──

  private async addCandidates(configId: string, items: Array<{ title: string; url: string | null; company: string | null }>, intakeSource: VacancyIntakeSource) {
    // Чистка по возрасту происходит ПРЯМО СЕЙЧАС, при добавлении новых —
    // то есть человек мог потерять старую вакансию ровно в тот момент,
    // когда добавлял новую, и не узнать об этом.
    const prunedByAge = await this.pruneCandidates(configId);
    const existing = await this.prisma.vacancyCandidate.findMany({ where: { configId }, select: { url: true } });
    const known = new Set(existing.map((e) => e.url));
    const room = MAX_CANDIDATES_PER_CONFIG - existing.length;
    if (room <= 0) throw new BadRequestException(`Потолок ${MAX_CANDIDATES_PER_CONFIG} кандидатов в базу — загрузите или удалите часть`);
    const batchId = `batch-${Date.now().toString(36)}`;
    const created = [];
    // Пункт [own-input] 2026-09-04: `skippedKnown` считалось вычитанием и
    // складывало ДВА разных события — «уже есть в базе» и «упёрлись в
    // потолок». Для человека это противоположные вещи: первое означает
    // «ничего не потеряно», второе — «остальное не добавлено, освободите
    // место». Отчёт, называющий одним словом оба, хуже отчёта, который
    // молчит: он выглядит полным. Считаются порознь.
    let skippedKnown = 0;
    let skippedOverCap = 0;
    for (const it of items) {
      if (created.length >= room) {
        skippedOverCap++;
        continue;
      }
      if (it.url && known.has(it.url)) {
        skippedKnown++;
        continue;
      }
      known.add(it.url ?? `t:${it.title}`);
      created.push(await this.prisma.vacancyCandidate.create({ data: { configId, title: it.title.slice(0, 200), url: it.url, company: it.company?.slice(0, 200) ?? null, intakeSource, batchId } }));
    }
    return { batchId, created, skippedKnown, skippedOverCap, prunedByAge, ttlDays: CANDIDATE_TTL_DAYS, cap: MAX_CANDIDATES_PER_CONFIG };
  }

  /** Пункт [silent-destruction] 2026-09-04: чистка по ВОЗРАСТУ, а не по
   * переполнению — и экран говорил ровно обратное («остальные удалятся
   * при переполнении»). Человек сохранял вакансию, не загружал её, и
   * через месяц она исчезала, хотя по надписи на экране должна была
   * лежать, пока база не заполнится. Правило одно, и теперь оно названо
   * на экране верно; сколько удалено — возвращается наружу. */
  private async pruneCandidates(configId: string): Promise<number> {
    const cutoff = new Date(Date.now() - CANDIDATE_TTL_DAYS * 86_400_000);
    const { count } = await this.prisma.vacancyCandidate.deleteMany({ where: { configId, createdAt: { lt: cutoff }, fetchedVacancyId: null } });
    return count;
  }

  /** К-11: страница результатов — ссылкой или HTML; одна страница за запрос, без пагинации. */
  async fromSearchPage(userId: string, projectId: string, dto: { url?: string | null; html?: string | null }) {
    const config = await this.config(userId, projectId);
    let html = dto.html ?? null;
    if (!html && dto.url) {
      if (!isUrlSafeToFetch(dto.url)) throw new BadRequestException('Некорректная или небезопасная ссылка');
      // fetchUrlText отдаёт текст без разметки — для ссылок нужен HTML; загружаем сырьё тем же потолком времени
      html = await this.fetchRawHtml(dto.url);
    }
    if (!html?.trim()) throw new BadRequestException('Нужна ссылка на страницу результатов или её HTML');
    const items = extractSearchResults(html, dto.url ?? undefined);
    if (items.length === 0) return { batchId: null, created: [], skippedKnown: 0, note: 'На странице не найдено ссылок на вакансии — вставьте HTML страницы результатов или отдельные ссылки' };
    return this.addCandidates(config.id, items, VacancyIntakeSource.SEARCH_PAGE);
  }

  private async fetchRawHtml(url: string): Promise<string> {
    const controller = new AbortController();
    const t = setTimeout(() => controller.abort(), 10_000);
    try {
      const res = await fetch(url, { signal: controller.signal, redirect: 'follow', headers: { 'User-Agent': "Devil's Advocate source-check bot (user-provided URL, manual verification feature)" } });
      if (!res.ok) throw new BadRequestException(`Страница ответила ${res.status}`);
      const text = await res.text();
      return text.slice(0, 2_000_000);
    } catch (err) {
      if (err instanceof HttpException) throw err;
      throw new BadRequestException(`Не удалось загрузить страницу: ${err instanceof Error ? err.message : 'ошибка сети'}`);
    } finally {
      clearTimeout(t);
    }
  }

  /** К-12: ссылки из письма-рассылки — извлекает клиент, сюда приходит список. */
  async fromEmailAlert(userId: string, projectId: string, links: Array<{ url: string; title?: string | null; company?: string | null }>) {
    const config = await this.config(userId, projectId);
    // Пункт [own-input] 2026-09-04: строки, не прошедшие проверку, здесь
    // молча исчезали. Это СЛОВА САМОГО ЧЕЛОВЕКА: он вставил десять строк
    // из письма, увидел семь кандидатов и прочитал это как «в письме
    // было семь». Частый случай — строка записана наоборот
    // («Название — https://…»), и ссылкой считается название.
    // Отбрасывать по-прежнему обязаны: небезопасный адрес не грузим.
    const items = links
      .filter((l) => l?.url && isUrlSafeToFetch(l.url))
      .map((l) => ({ url: l.url, title: (l.title?.trim() || new URL(l.url).hostname).slice(0, 200), company: l.company ?? null }));
    const skippedNotUsable = links.length - items.length;
    if (items.length === 0) throw new BadRequestException('В письме не найдено ссылок на вакансии');
    return { ...(await this.addCandidates(config.id, items, VacancyIntakeSource.EMAIL_ALERT)), skippedNotUsable };
  }

  async listCandidates(userId: string, projectId: string) {
    const config = await this.config(userId, projectId);
    await this.pruneCandidates(config.id);
    return this.prisma.vacancyCandidate.findMany({ where: { configId: config.id }, orderBy: { createdAt: 'desc' } });
  }

  /** Загрузка содержимого кандидата → JobVacancy (в потолок 50). */
  async fetchCandidate(userId: string, candidateId: string) {
    const candidate = await this.prisma.vacancyCandidate.findUnique({ where: { id: candidateId }, include: { config: { include: { project: { select: { ownerId: true, mode: true } } } } } });
    if (!candidate || candidate.config.project.ownerId !== userId || candidate.config.project.mode !== ProjectMode.JOB_SEARCH) throw new NotFoundException(`VacancyCandidate ${candidateId} not found`);
    if (candidate.fetchedVacancyId) return this.prisma.jobVacancy.findUnique({ where: { id: candidate.fetchedVacancyId } });
    if (!candidate.url) throw new BadRequestException('У кандидата нет ссылки — вставьте текст вакансии вручную');
    await this.assertUnderVacancyCap(candidate.configId);
    let rawText: string;
    let fetchIntake: SourceIntake;
    try {
      ({ text: rawText, intake: fetchIntake } = await fetchUrlText(candidate.url, MAX_VACANCY_TEXT_CHARS));
    } catch (err) {
      if (err instanceof UnsafeUrlError || err instanceof UrlFetchError) throw new BadRequestException(err.message);
      throw err;
    }
    const vacancy = await this.createVacancy(candidate.configId, { sourceUrl: candidate.url, rawText, title: candidate.title, intakeSource: candidate.intakeSource, intakeBatchId: candidate.batchId, totalChars: fetchIntake.total });
    await this.prisma.vacancyCandidate.update({ where: { id: candidate.id }, data: { fetchedVacancyId: vacancy.id } });
    return vacancy;
  }

  private async assertUnderVacancyCap(configId: string) {
    const count = await this.prisma.jobVacancy.count({ where: { configId } });
    if (count >= MAX_VACANCIES_PER_CONFIG) {
      throw new BadRequestException(`Потолок ${MAX_VACANCIES_PER_CONFIG} вакансий на поиск — удалите неактуальные или создайте новый проект`);
    }
  }

  /** Пункт [stored-text-cut] 2026-09-06 — единственное место, где текст
   * вакансии попадает в базу, и единственное, где он режется.
   *
   * ЧТО БЫЛО. Валидатор запроса пропускает 20 000 знаков, а запись
   * резала до 12 000 — молча. Человек вставлял объявление на 15 000
   * знаков, получал созданную вакансию и НИГДЕ не узнавал, что три
   * тысячи знаков в продукт не попали. Дальше по этому обрезку
   * считался `contentHash` (то есть и склейка дублей), шла сверка с
   * CV, искались признаки мошенничества и собирались основания для
   * листа условий.
   *
   * И хуже: механизм честного отчёта в проекте есть с пункта
   * [input-truncated] — он говорит человеку «в разбор вошли первые N
   * знаков из M». Но M он берёт из того, что лежит в базе. То есть
   * после молчаливой обрезки на входе ЧЕСТНАЯ ЗАПИСКА СООБЩАЛА «вошли
   * 12 000 из 12 000» — и была неправдой, не зная об этом.
   *
   * `totalChars` — длина ДО любой обрезки: для вставки и пересылки это
   * длина присланного текста, для загрузки по ссылке — длина
   * извлечённого со страницы. */
  private async createVacancy(configId: string, data: { sourceUrl: string | null; rawText: string; title?: string | null; intakeSource: VacancyIntakeSource; intakeBatchId?: string | null; totalChars?: number }) {
    let siteHost: string | null = null;
    if (data.sourceUrl) {
      try {
        siteHost = new URL(data.sourceUrl).hostname.replace(/^www\./, '');
      } catch {
        siteHost = null;
      }
    }
    const { text: rawText, intake } = takeSource(data.rawText, MAX_VACANCY_TEXT_CHARS);
    const totalChars = Math.max(intake.total, data.totalChars ?? 0);
    const vacancy = await this.prisma.jobVacancy.create({
      data: { configId, sourceUrl: data.sourceUrl, siteHost, rawText, title: data.title ?? null, intakeSource: data.intakeSource, intakeBatchId: data.intakeBatchId ?? null, contentHash: contentHashOf(rawText), rawTextTotalChars: totalChars },
    });
    await this.dedupeOne(vacancy.id);
    return this.prisma.jobVacancy.findUniqueOrThrow({ where: { id: vacancy.id } });
  }

  /** PASTED_TEXT: вставленный текст — JobVacancy без ссылки. */
  async fromPastedText(userId: string, projectId: string, dto: { text: string; title?: string | null; sourceUrl?: string | null }) {
    const config = await this.config(userId, projectId);
    if (!dto.text?.trim()) throw new BadRequestException('Текст пуст');
    await this.assertUnderVacancyCap(config.id);
    const sourceUrl = dto.sourceUrl && isUrlSafeToFetch(dto.sourceUrl) ? dto.sourceUrl : null;
    return this.createVacancy(config.id, { sourceUrl, rawText: dto.text, title: dto.title ?? null, intakeSource: VacancyIntakeSource.PASTED_TEXT, totalChars: dto.text.length });
  }

  /** К-20: пересланное боту сообщение — только text. Приходит из вебхука бота
   * (telegram-bot.service.ts) и из внутреннего маршрута за секретом. */
  async fromForwardedMessage(telegramId: string, projectId: string, text: string) {
    const user = await this.prisma.user.findFirst({ where: { telegramId: telegramId as never }, select: { id: true } }).catch(() => null);
    if (!user) throw new NotFoundException('Пользователь Telegram не найден в продукте');
    const config = await this.config(user.id, projectId);
    const { rawText, sourceUrl, totalChars } = sanitizeForwardedText(text);
    if (!rawText) throw new BadRequestException('Пустое сообщение');

    // Пункт [job-domain-v2] К-20 (вебхук 2026-09-03): Telegram повторяет
    // доставку update'а, если ответ не пришёл вовремя, — а обработка к тому
    // моменту уже прошла. Без этой проверки один пересланный пост
    // превращался бы в две вакансии, и человек видел бы дубликат, которого не
    // делал. Окно короткое: осознанная повторная пересылка того же текста
    // через час — уже намерение пользователя, а не ретрай транспорта.
    //
    // Проверка нарочно узкая — ТОЛЬКО прежние пересылки. Тот же текст,
    // пришедший другим путём (вставлен руками, загружен по ссылке), — это не
    // ретрай, а второй источник: такая вакансия должна создаться и связаться
    // как дубль (К-15), чтобы человек видел, что она пришла дважды, и мог
    // сказать «это не дубликат». Схлопни мы её здесь — потерялась бы и связь,
    // и возможность её разорвать.
    const recent = await this.prisma.jobVacancy.findFirst({
      where: {
        configId: config.id,
        contentHash: contentHashOf(rawText),
        intakeSource: VacancyIntakeSource.TELEGRAM_FORWARD,
        createdAt: { gt: new Date(Date.now() - FORWARD_RETRY_WINDOW_MS) },
      },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    });
    if (recent) return recent;

    await this.assertUnderVacancyCap(config.id);
    return this.createVacancy(config.id, { sourceUrl, rawText, intakeSource: VacancyIntakeSource.TELEGRAM_FORWARD, totalChars });
  }

  // ── Дедупликация (К-15) ──

  private async dedupeOne(vacancyId: string) {
    const v = await this.prisma.jobVacancy.findUnique({ where: { id: vacancyId } });
    if (!v || v.duplicateOfId) return;
    const others = await this.prisma.jobVacancy.findMany({ where: { configId: v.configId, id: { not: v.id }, duplicateOfId: null }, orderBy: { createdAt: 'asc' } });
    const primary = others.find((o) => (o.contentHash && o.contentHash === v.contentHash) || (titleSimilarity(o.title, v.title) >= 0.8 && o.siteHost !== v.siteHost && v.title));
    if (primary) await this.prisma.jobVacancy.update({ where: { id: v.id }, data: { duplicateOfId: primary.id } });
  }

  async dedupe(userId: string, projectId: string) {
    const config = await this.config(userId, projectId);
    const all = await this.prisma.jobVacancy.findMany({ where: { configId: config.id }, orderBy: { createdAt: 'asc' } });
    const groups: Array<{ primaryId: string; duplicateIds: string[] }> = [];
    for (const v of all) {
      if (!v.contentHash) await this.prisma.jobVacancy.update({ where: { id: v.id }, data: { contentHash: contentHashOf(v.rawText) } });
    }
    const fresh = await this.prisma.jobVacancy.findMany({ where: { configId: config.id }, orderBy: { createdAt: 'asc' } });
    const assigned = new Set<string>();
    for (const v of fresh) {
      if (assigned.has(v.id)) continue;
      const dups = fresh.filter((o) => o.id !== v.id && !assigned.has(o.id) && ((o.contentHash && o.contentHash === v.contentHash) || (!!v.title && titleSimilarity(o.title, v.title) >= 0.8 && o.siteHost !== v.siteHost)));
      if (dups.length === 0) continue;
      assigned.add(v.id);
      for (const d of dups) {
        assigned.add(d.id);
        await this.prisma.jobVacancy.update({ where: { id: d.id }, data: { duplicateOfId: v.id } });
      }
      groups.push({ primaryId: v.id, duplicateIds: dups.map((d) => d.id) });
    }
    return { groups };
  }

  /** Ложный дубль разводится руками. */
  async unlinkDuplicate(userId: string, vacancyId: string) {
    const v = await this.ownedVacancy(userId, vacancyId);
    return this.prisma.jobVacancy.update({ where: { id: v.id }, data: { duplicateOfId: null } });
  }

  // ── Изменения со временем (К-16) ──

  async setWatch(userId: string, vacancyId: string, enabled: boolean) {
    const v = await this.ownedVacancy(userId, vacancyId);
    if (enabled && !v.sourceUrl) throw new BadRequestException('У вакансии нет ссылки — следить нечем');
    return this.prisma.jobVacancy.update({ where: { id: v.id }, data: { watchEnabled: enabled } });
  }

  async refetch(userId: string, vacancyId: string, now = new Date()) {
    const v = await this.ownedVacancy(userId, vacancyId);
    if (!v.sourceUrl) throw new BadRequestException('У вакансии нет ссылки');
    if (v.lastRefetchedAt && now.getTime() - v.lastRefetchedAt.getTime() < REFETCH_MIN_INTERVAL_MS) {
      throw new TooManyRequestsException('Повторная загрузка — не чаще раза в сутки на вакансию');
    }
    return this.refetchOne(v, now);
  }

  private async refetchOne(
    v: { id: string; sourceUrl: string | null; rawText: string; removedFromSourceAt?: Date | null },
    now: Date,
  ) {
    let rawText: string | null = null;
    let gone = false;
    try {
      ({ text: rawText } = await fetchUrlText(v.sourceUrl!, MAX_VACANCY_TEXT_CHARS));
    } catch (err) {
      if (err instanceof UrlFetchError && /404|410/.test(err.message)) gone = true;
      else if (err instanceof UnsafeUrlError || err instanceof UrlFetchError) {
        await this.prisma.jobVacancy.update({ where: { id: v.id }, data: { lastRefetchedAt: now } });
        return { vacancyId: v.id, changed: false, error: err.message };
      } else throw err;
    }
    // Пункт [state-not-sent] 2026-09-06: состояние источника пишется в
    // колонку, а ТЕКСТ ИСТОЧНИКА не трогается. Раньше сюда дописывалась
    // строка «[Снята с публикации…]» — продукт дописывал свои слова в
    // поле, объявленное как «текст страницы, НЕ пересказ», и делал это
    // заново каждые сутки. Обоснование целиком — source-availability.ts.
    if (gone) {
      const alreadyKnown = !!v.removedFromSourceAt;
      await this.prisma.jobVacancy.update({
        where: { id: v.id },
        data: { lastRefetchedAt: now, removedFromSourceAt: v.removedFromSourceAt ?? now },
      });
      // Повторное 404 — не изменение: вакансия не менялась, её сняли
      // один раз. `changed: true` здесь давало бы человеку сигнал
      // «посмотри, что поменялось» каждые сутки подряд.
      return { vacancyId: v.id, changed: false, removed: true, alreadyKnown };
    }
    // Источник ответил: если вакансия числилась снятой — она вернулась.
    const republished = !!v.removedFromSourceAt;
    const changed = rawText!.trim() !== v.rawText.trim();
    await this.prisma.jobVacancy.update({
      where: { id: v.id },
      data: changed
        ? { lastRefetchedAt: now, previousRawText: v.rawText, rawText: rawText!, contentHash: contentHashOf(rawText!), removedFromSourceAt: null }
        : { lastRefetchedAt: now, removedFromSourceAt: null },
    });
    return { vacancyId: v.id, changed, republished, diff: changed ? vacancyTextDiff(v.rawText, rawText!) : null };
  }

  async changes(userId: string, vacancyId: string) {
    const v = await this.ownedVacancy(userId, vacancyId);
    // Пункт [state-not-sent] 2026-09-06: снятие с публикации — отдельный
    // факт, а не строка в diff'е. Раньше оно приходило сюда именно
    // строкой — дописанной нами же, и каждые сутки новой.
    const availability = {
      removedFromSourceAt: v.removedFromSourceAt,
      note: availabilityNote(v),
    };
    if (!v.previousRawText) return { vacancyId: v.id, lastRefetchedAt: v.lastRefetchedAt, diff: null, ...availability };
    return { vacancyId: v.id, lastRefetchedAt: v.lastRefetchedAt, diff: vacancyTextDiff(v.previousRawText, v.rawText), ...availability };
  }

  /** Тик pg_cron: вакансии со слежением и загрузкой старше суток, порция 20. */
  async refetchDue(now = new Date(), limit = REFETCH_BATCH) {
    const cutoff = new Date(now.getTime() - REFETCH_MIN_INTERVAL_MS);
    const due = await this.prisma.jobVacancy.findMany({
      // Пункт [freeze-stopped-only-the-hands] 2026-09-25: замороженный
      // проект не перечитывается. Заморозка обещает человеку, что
      // изменений не будет, — а перечитывание приносит в проект новые
      // данные. Отдельной пометки вакансии не ставим: у неё уже есть
      // честная строка «при последней проверке источник отвечал» с
      // датой, и она сама расскажет, что проверки давно не было.
      where: {
        watchEnabled: true,
        sourceUrl: { not: null },
        config: { project: { frozenAt: null } },
        OR: [{ lastRefetchedAt: null }, { lastRefetchedAt: { lt: cutoff } }],
      },
      orderBy: [{ lastRefetchedAt: 'asc' }, { id: 'asc' }],
      take: limit,
    });
    let changed = 0;
    let removed = 0;
    let republished = 0;
    for (const v of due) {
      const r = await this.refetchOne(v, now);
      if (r.changed) changed++;
      // Пункт [state-not-sent] 2026-09-06: снятие больше не считается
      // изменением, поэтому тик обязан отчитаться о нём отдельно —
      // иначе в сводке останется только «processed: 20, changed: 0», и
      // отличить «ничего не поменялось» от «двадцать вакансий сняли с
      // публикации» по ней будет нечем.
      if ('removed' in r && r.removed) removed++;
      if ('republished' in r && r.republished) republished++;
    }
    return { processed: due.length, changed, removed, republished };
  }

  // ── История откликов (К-29) ──

  async importResponses(userId: string, projectId: string, text: string) {
    const config = await this.config(userId, projectId);
    const rows = parseResponsesExport(text);
    if (rows.length === 0) throw new BadRequestException('В тексте не найдено строк со статусами откликов');
    const vacancies = await this.prisma.jobVacancy.findMany({ where: { configId: config.id } });
    const matched: Array<{ vacancyId: string; status: JobVacancyResponseStatus; title: string }> = [];
    const unmatched: string[] = [];
    for (const r of rows) {
      const best = vacancies.map((v) => ({ v, s: titleSimilarity(v.title ?? v.siteHost, r.title) })).sort((a, b) => b.s - a.s)[0];
      if (!best || best.s < 0.5) {
        unmatched.push(r.raw);
        continue;
      }
      await this.prisma.jobVacancy.update({ where: { id: best.v.id }, data: { responseStatus: r.status, responseStatusAt: r.at ?? new Date() } });
      matched.push({ vacancyId: best.v.id, status: r.status, title: r.title });
    }
    return { matched, unmatched };
  }

  /** «Молчат N дней» после отклика — детерминированно по responseStatusAt. */
  async silence(userId: string, projectId: string, days = 7, now = new Date()) {
    const config = await this.config(userId, projectId);
    const cutoff = new Date(now.getTime() - days * 86_400_000);
    const rows = await this.prisma.jobVacancy.findMany({
      where: { configId: config.id, responseStatus: { in: [JobVacancyResponseStatus.APPLIED, JobVacancyResponseStatus.VIEWED] }, responseStatusAt: { lt: cutoff } },
      select: { id: true, title: true, siteHost: true, responseStatus: true, responseStatusAt: true },
    });
    return rows.map((r) => ({ ...r, silentDays: Math.floor((now.getTime() - (r.responseStatusAt as Date).getTime()) / 86_400_000) }));
  }

  /** К-3 (аудит 2026-09-03): отметить статус отклика руками.
   *
   * НАЙДЕНО: `responseStatus` проставлялся ЕДИНСТВЕННЫМ местом — массовым
   * импортом истории откликов с площадки (К-29). У человека, который просто
   * откликнулся по ссылке, сводка «молчат N дней» была вечно пустой: продукт
   * не знал, что отклик вообще был. Функция выглядела работающей — на деле
   * работала только для тех, кто выгружает историю с job-сайта.
   *
   * Дата ставится продуктом, не пользователем: «молчат N дней» считается от
   * момента отметки, и разрешить задать её задним числом значило бы дать
   * счётчику показывать то, чего не было. */
  async setResponseStatus(userId: string, vacancyId: string, status: JobVacancyResponseStatus | null) {
    const v = await this.ownedVacancy(userId, vacancyId);
    return this.prisma.jobVacancy.update({
      where: { id: v.id },
      data: { responseStatus: status, responseStatusAt: status ? new Date() : null },
    });
  }

  async setFavorite(userId: string, vacancyId: string, favorite: boolean) {
    const v = await this.ownedVacancy(userId, vacancyId);
    return this.prisma.jobVacancy.update({ where: { id: v.id }, data: { favorite } });
  }

  async ownedVacancy(userId: string, vacancyId: string) {
    const v = await this.prisma.jobVacancy.findUnique({ where: { id: vacancyId }, include: { config: { include: { project: { select: { ownerId: true, mode: true } } } } } });
    if (!v || v.config.project.ownerId !== userId || v.config.project.mode !== ProjectMode.JOB_SEARCH) throw new NotFoundException(`JobVacancy ${vacancyId} not found`);
    return v;
  }
}
