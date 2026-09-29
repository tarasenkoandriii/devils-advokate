// Сверка молчаливого необратимого 2026-09-04.
//
// Заход начался с вопроса, на который в проекте есть прямой ответ:
// сервер возвращает «рамки» — честные оговорки продукта («расхождения
// цитатами, кто прав не решается», «признаки, не вердикт»). Доходят ли
// они до экрана? Девять из десяти доходят. Десятая привела к находке
// куда серьёзнее самой рамки.
//
// НАХОДКА 1: СЛИЯНИЕ КАНДИДАТОВ УНИЧТОЖАЛО РАБОТУ ЧЕЛОВЕКА МОЛЧА.
// Когда один человек пришёл и от агентства, и напрямую, работодатель
// сливает две карточки. Позиции переносятся по пунктам, у которых есть
// пара в оставляемом листе; у остальных стоял `continue` без счётчика.
// Дальше удаляется вторая карточка — а по каскаду базы
// (`TermsSheet.pipelineStatusId … onDelete: Cascade`) вместе с ней и
// весь её лист. То есть непарные пункты и ВСЕ ИХ ПОЗИЦИИ исчезали
// НАВСЕГДА. Это не находка модели — это записи, которые рекрутер сделал
// сам о кандидате из второго источника.
//
// И вторая половина того же: экран ВЫБРАСЫВАЛ результат вызова целиком
// (`await …; setMode('none'); haptic('success')`). Человек получал
// вибрацию телефона — ни числа перенесённого, ни рамки, ни слова о том,
// что что-то потеряно.
//
// НАХОДКА 2: ЭКРАН ОБЕЩАЛ ОДНО ПРАВИЛО, КОД ПРИМЕНЯЛ ДРУГОЕ. Под списком
// кандидатов в базу было написано «остальные удалятся при переполнении
// (потолок 200)». Код удаляет ПО ВОЗРАСТУ: незагруженный кандидат
// старше 30 дней исчезает независимо от заполненности, и происходит это
// в момент добавления новых. Человек сохранял вакансию, не загружал её и
// терял через месяц, хотя надпись обещала обратное.
//
// ЧЕМ ЭТО ОТЛИЧАЕТСЯ ОТ ПРЕЖНИХ ЗАХОДОВ. Там терялся ОТВЕТ МОДЕЛИ, и
// показывать потерянное было нельзя. Здесь теряется работа человека и
// притом НЕОБРАТИМО — поэтому показываются не числа, а тексты пунктов:
// по своим формулировкам он поймёт, чего лишился.
//
// ЧЕГО ЗАХОД НЕ ДЕЛАЕТ, и это названо, а не забыто: не вводит
// предпросмотр перед слиянием («вот что потеряется — продолжить?»).
// Предупреждение до действия и точный отчёт после закрывают честность;
// подтверждение с предпросмотром — это уже решение о продукте, и
// принимать его за владельца в аудите неправильно.

import { HiringExtrasService, MERGE_DROPPED_SAMPLE } from '../hiring-extras/hiring-extras.service';
import { TermsSheetService } from '../terms-sheet/terms-sheet.service';
import { TermsMatchingService } from '../terms-sheet/terms-matching.service';
import { VacancyIntakeService, CANDIDATE_TTL_DAYS } from '../vacancy-intake/vacancy-intake.service';
import { createHiringFakePrisma, createFakeRouter, fakeAudit } from './fake-prisma';

function setup() {
  const prisma = createHiringFakePrisma();
  const router = createFakeRouter(() => '{}');
  const audit = { records: [] as any[], record: async (r: any) => { audit.records.push(r); return r; } };
  const matching = new TermsMatchingService(prisma as any, router as any);
  const sheets = new TermsSheetService(prisma as any, matching, fakeAudit as any);
  const extras = new HiringExtrasService(prisma as any, router as any, audit as any, sheets, matching);
  return { prisma, audit, sheets, extras };
}

/** Две карточки одного кандидата с листами: у оставляемой — пункт «Опыт»,
 * у присоединяемой — «Опыт» (пара найдётся) и «Английский» (пары нет). */
async function seedTwoCandidates(s: ReturnType<typeof setup>) {
  const project = s.prisma.seed('project', { ownerId: 'u1', mode: 'EMPLOYER_HIRING' });
  const p1 = s.prisma.seed('candidateProfile', { displayName: 'Иван' });
  const p2 = s.prisma.seed('candidateProfile', { displayName: 'Иван (от агентства)' });
  const keep = s.prisma.seed('candidatePipelineStatus', { projectId: project.id, candidateProfileId: p1.id, stage: 'SCHEDULED' });
  const merge = s.prisma.seed('candidatePipelineStatus', { projectId: project.id, candidateProfileId: p2.id, stage: 'SCHEDULED' });

  const keepSheet = await s.sheets.openForCandidate('u1', keep.id, { silent: true });
  s.prisma.seed('termsClause', { sheetId: keepSheet.id, side: 'EMPLOYER', kind: 'REQUIREMENT', text: 'Опыт B2B-продаж', orderIndex: 0, confirmedAt: new Date() });

  const mergeSheet = s.prisma.seed('termsSheet', { projectId: project.id, kind: 'INTERVIEW', title: 'Иван (от агентства)', pipelineStatusId: merge.id });
  const paired = s.prisma.seed('termsClause', { sheetId: mergeSheet.id, side: 'EMPLOYER', kind: 'REQUIREMENT', text: 'Опыт B2B-продаж', orderIndex: 0, confirmedAt: new Date() });
  const orphan = s.prisma.seed('termsClause', { sheetId: mergeSheet.id, side: 'EMPLOYER', kind: 'REQUIREMENT', text: 'Английский C1', orderIndex: 1, confirmedAt: new Date() });
  s.prisma.seed('clausePosition', { clauseId: paired.id, bySide: 'CANDIDATE', coverage: 'covered', note: 'из собеседования', evidenceKind: 'TRANSCRIPT_SEGMENT', evidenceQuote: 'два года в B2B' });
  s.prisma.seed('clausePosition', { clauseId: orphan.id, bySide: 'CANDIDATE', coverage: 'covered', note: 'со слов агентства', evidenceKind: 'USER_STATED', evidenceQuote: 'английский свободный' });
  s.prisma.seed('clausePosition', { clauseId: orphan.id, bySide: 'CANDIDATE', coverage: 'partial', note: 'уточнить', evidenceKind: 'USER_STATED', evidenceQuote: 'читает документацию' });
  return { project, keep, merge };
}

describe('Необратимое, о котором не сказано', () => {
  it('КЛЮЧЕВОЙ ТЕСТ: слияние называет, сколько работы человека НЕ перенеслось', async () => {
    const s = setup();
    const { project, keep, merge } = await seedTwoCandidates(s);
    const res = await s.extras.mergeCandidates('u1', project.id, { keepStatusId: keep.id, mergeStatusId: merge.id });

    expect(res.positionsMoved).toBe(1);
    // Пункт без пары и обе его позиции — потеряны безвозвратно, и это
    // названо числом, а не «что-то не перенеслось».
    expect(res.clausesWithoutMatch).toBe(1);
    expect(res.positionsDropped).toBe(2);
  });

  it('КЛЮЧЕВОЙ ТЕСТ: потерянное названо СВОИМИ СЛОВАМИ человека, а не числом', async () => {
    // Тут решение противоположно прежним заходам: выдуманную моделью
    // цитату показывать было нельзя, а формулировку пункта, которую
    // написал сам человек, — нужно: по ней он поймёт, чего лишился.
    const s = setup();
    const { project, keep, merge } = await seedTwoCandidates(s);
    const res = await s.extras.mergeCandidates('u1', project.id, { keepStatusId: keep.id, mergeStatusId: merge.id });
    expect(res.droppedClauseTexts).toEqual(['Английский C1']);
  });

  it('КЛЮЧЕВОЙ ТЕСТ: когда пара нашлась у всех — ноль, а не «что-то потеряли»', async () => {
    // Обратная половина. Проверка, смотрящая только на «больше нуля»,
    // прошла бы и с константой в коде.
    const s = setup();
    const project = s.prisma.seed('project', { ownerId: 'u1', mode: 'EMPLOYER_HIRING' });
    const p1 = s.prisma.seed('candidateProfile', { displayName: 'Иван' });
    const p2 = s.prisma.seed('candidateProfile', { displayName: 'Иван 2' });
    const keep = s.prisma.seed('candidatePipelineStatus', { projectId: project.id, candidateProfileId: p1.id, stage: 'SCHEDULED' });
    const merge = s.prisma.seed('candidatePipelineStatus', { projectId: project.id, candidateProfileId: p2.id, stage: 'SCHEDULED' });
    const keepSheet = await s.sheets.openForCandidate('u1', keep.id, { silent: true });
    s.prisma.seed('termsClause', { sheetId: keepSheet.id, side: 'EMPLOYER', kind: 'REQUIREMENT', text: 'Опыт', orderIndex: 0, confirmedAt: new Date() });
    const mergeSheet = s.prisma.seed('termsSheet', { projectId: project.id, kind: 'INTERVIEW', title: 'x', pipelineStatusId: merge.id });
    const c = s.prisma.seed('termsClause', { sheetId: mergeSheet.id, side: 'EMPLOYER', kind: 'REQUIREMENT', text: 'Опыт', orderIndex: 0, confirmedAt: new Date() });
    s.prisma.seed('clausePosition', { clauseId: c.id, bySide: 'CANDIDATE', coverage: 'covered', note: 'n', evidenceKind: 'USER_STATED', evidenceQuote: 'q' });

    const res = await s.extras.mergeCandidates('u1', project.id, { keepStatusId: keep.id, mergeStatusId: merge.id });
    expect(res.positionsMoved).toBe(1);
    expect(res.clausesWithoutMatch).toBe(0);
    expect(res.positionsDropped).toBe(0);
    expect(res.droppedClauseTexts).toEqual([]);
  });

  it('КЛЮЧЕВОЙ ТЕСТ: потеря попадает и в журнал — не только на экран', async () => {
    // Экран человек закроет; журнал остаётся. Необратимое действие
    // обязано быть восстановимо хотя бы как факт: что именно исчезло.
    const s = setup();
    const { project, keep, merge } = await seedTwoCandidates(s);
    await s.extras.mergeCandidates('u1', project.id, { keepStatusId: keep.id, mergeStatusId: merge.id });
    const rec = s.audit.records.find((r) => r.action === 'candidate.merged');
    expect(rec).toBeTruthy();
    expect(rec.after).toMatchObject({ positionsMoved: 1, clausesWithoutMatch: 1, positionsDropped: 2 });
  });

  it('показ примеров усечён, а ЧИСЛО потерянных — точное', () => {
    // Усекать показ можно, врать о количестве нельзя. Константа названа,
    // чтобы экран мог сказать «и ещё N» вместо тихого обрыва списка.
    expect(MERGE_DROPPED_SAMPLE).toBeGreaterThan(0);
    expect(MERGE_DROPPED_SAMPLE).toBeLessThan(20);
  });

  it('КЛЮЧЕВОЙ ТЕСТ: чистка кандидатов идёт по ВОЗРАСТУ, и число удалённого возвращается', async () => {
    // Экран говорил «удалятся при переполнении», код удаляет через 30
    // дней независимо от заполненности — и делает это молча, в момент
    // добавления новых.
    const prisma = createHiringFakePrisma();
    const project = prisma.seed('project', { ownerId: 'u1', mode: 'JOB_SEARCH' });
    const config = prisma.seed('jobSearchConfig', { projectId: project.id });
    const intake = new VacancyIntakeService(prisma as any);
    const old = new Date(Date.now() - (CANDIDATE_TTL_DAYS + 1) * 86_400_000);

    prisma.seed('vacancyCandidate', { configId: config.id, title: 'старая', url: 'https://x/old', intakeSource: 'EMAIL_ALERT', createdAt: old, fetchedVacancyId: null });
    // Загруженная не удаляется по сроку — человек её сохранил осознанно.
    prisma.seed('vacancyCandidate', { configId: config.id, title: 'старая загруженная', url: 'https://x/oldloaded', intakeSource: 'EMAIL_ALERT', createdAt: old, fetchedVacancyId: 'v1' });

    const res = await intake.fromEmailAlert('u1', project.id, [{ url: 'https://x/new', title: 'новая' }]);
    expect(res.prunedByAge).toBe(1);
    expect(res.ttlDays).toBe(CANDIDATE_TTL_DAYS);
    expect(prisma.rows('vacancyCandidate').map((c: any) => c.title).sort()).toEqual(['новая', 'старая загруженная']);
  });
});
