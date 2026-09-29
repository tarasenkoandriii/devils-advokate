// Пункт [job-domain-v2] — приёмка 4, 5, 39, 40 (CV-вариант и диалог по пунктам).
import { BadRequestException } from '@nestjs/common';
import { compileCvVariantText, resolveHighlightRef, CvVariantService } from '../terms-sheet/cv-variant.service';
import { CvDialogueService, CV_DIALOGUE_QUESTION_PROMPT, CV_DIALOGUE_PROHIBITION, MAX_FOLLOW_UPS_PER_CLAUSE } from '../terms-sheet/cv-dialogue.service';
import { TermsSheetService } from '../terms-sheet/terms-sheet.service';
import { TermsMatchingService } from '../terms-sheet/terms-matching.service';
import { createHiringFakePrisma, createFakeRouter, fakeAudit } from './fake-prisma';
import type { CvDraft } from '../job-search/job-search.service';

const draft: CvDraft = {
  headline: 'Backend-разработчик',
  summary: 'Пять лет в бэкенде.',
  skills: ['Python', 'Node.js', 'Docker'],
  experience: [{ period: '2020–2024', place: 'ООО Х', role: 'Разработчик', highlights: ['Поддерживал API на Django', 'Настроил CI на Node.js'] }],
  education: ['КПИ'],
};

describe('compileCvVariantText — детерминированная сборка (приёмка 4, 5)', () => {
  it('ничего сверх cvDraft; покрытые пункты первыми; непокрытые не дописываются', () => {
    const text = compileCvVariantText(
      draft,
      [
        { highlightRef: 'skills[1]', clauseId: 'c-node' },
        { highlightRef: 'experience[0].highlights[1]', clauseId: 'c-node' },
        { highlightRef: 'skills[0]', clauseId: 'c-python' },
      ],
      new Set(['c-node']),
      'Киев',
    );
    expect(text).toContain('Навыки: Node.js, Python, Docker'); // покрытый → привязанный к непокрытому → не привязанный
    const opytIdx = text.indexOf('Настроил CI на Node.js');
    expect(opytIdx).toBeLessThan(text.indexOf('Поддерживал API на Django'));
    // ни одного слова, которого нет в базовом CV
    const baseWords = new Set(JSON.stringify(draft).toLowerCase().match(/[a-zа-яё0-9.]+/g));
    const extra = (text.toLowerCase().match(/[a-zа-яё0-9.]+/g) ?? []).filter((w) => !baseWords.has(w) && !['навыки', 'опыт', 'образование', 'локация', 'поиска', 'киев'].includes(w));
    expect(extra).toEqual([]);
  });

  it('переформулировка попадает в текст только после подтверждения; без него — оригинал', () => {
    const map = [{ highlightRef: 'experience[0].highlights[0]', clauseId: 'c', rephrased: 'Разрабатывал REST API (Django)', rephraseConfirmed: false }];
    expect(compileCvVariantText(draft, map, new Set(['c']), null)).toContain('Поддерживал API на Django');
    map[0].rephraseConfirmed = true;
    const t = compileCvVariantText(draft, map, new Set(['c']), null);
    expect(t).toContain('Разрабатывал REST API (Django)');
    expect(t).not.toContain('Поддерживал API на Django');
  });

  it('несуществующий highlightRef → undefined (компиляция отвергает 400)', () => {
    expect(resolveHighlightRef(draft, 'skills[9]')).toBeUndefined();
    expect(resolveHighlightRef(draft, 'experience[3].highlights[0]')).toBeUndefined();
    expect(resolveHighlightRef(draft, 'garbage')).toBeUndefined();
    expect(resolveHighlightRef(draft, 'experience[0].highlights[1]')).toBe('Настроил CI на Node.js');
  });
});

function setup(handler: (req: any) => string) {
  const prisma = createHiringFakePrisma();
  const router = createFakeRouter(handler);
  const matching = new TermsMatchingService(prisma as any, router as any);
  const sheets = new TermsSheetService(prisma as any, matching, fakeAudit as any);
  const cv = new CvVariantService(prisma as any, router as any, sheets);
  const dialogue = new CvDialogueService(prisma as any, router as any, sheets, matching);
  const project = prisma.seed('project', { ownerId: 'u1', mode: 'JOB_SEARCH' });
  const config = prisma.seed('jobSearchConfig', { projectId: project.id, desiredRole: 'Backend', city: 'Киев', cvDraft: draft });
  prisma.seed('jobSearchCriterion', { configId: config.id, text: 'Удалёнка', category: 'LOCATION', isRequired: true, orderIndex: 0 });
  const vacancy = prisma.seed('jobVacancy', { configId: config.id, sourceUrl: 'https://x', siteHost: 'x', rawText: 'Нужен Kubernetes и Node.js.' });
  return { prisma, router, sheets, cv, dialogue, project, config, vacancy };
}

const clausesPayload = JSON.stringify({
  clauses: [
    { kind: 'REQUIREMENT', text: 'Kubernetes', category: 'роль', isRequired: true, quote: 'Нужен Kubernetes' },
    { kind: 'REQUIREMENT', text: 'Node.js', category: 'роль', isRequired: true, quote: 'Node.js' },
  ],
});

describe('CvVariantService.compile через сервис', () => {
  it('compile: неизвестный ref → 400; валидная карта создаёт вариант с текстом', async () => {
    const s = setup(() => clausesPayload);
    const sheet = await s.sheets.openForVacancy('u1', s.vacancy.id);
    await expect(s.cv.compile('u1', sheet.id, [{ highlightRef: 'skills[7]', clauseId: 'x' }])).rejects.toBeInstanceOf(BadRequestException);
    const v = await s.cv.compile('u1', sheet.id, [{ highlightRef: 'skills[1]', clauseId: sheet.clauses[1].id }]);
    expect(v.cvText).toContain('Backend-разработчик');
    expect(v.reviewedAt).toBeNull();
  });
});

describe('CvDialogueService — К-21 (приёмка 39)', () => {
  it('промпт содержит запрет дословно', () => {
    expect(CV_DIALOGUE_QUESTION_PROMPT).toContain(CV_DIALOGUE_PROHIBITION);
    expect(CV_DIALOGUE_PROHIBITION).toBe('не предлагай формулировок, описывающих опыт, которого пользователь не подтвердил');
  });

  it('вопрос идёт по непокрытому пункту; ответ → TranscriptSegment → черновик позиции с evidenceRef; «нет» остаётся not_covered; не более 3 уточнений', async () => {
    const s = setup((req) => {
      if (req.taskType === 'terms-clauses-extract') return clausesPayload;
      if (req.taskType === 'cv-dialogue-question') return JSON.stringify({ question: 'Работали с Kubernetes? Где и что делали?' });
      if (req.taskType === 'terms-match') {
        // модель честно ставит not_covered на «нет, не работал», ссылаясь на реплику
        const segId = /Транскрипт:\n\[id=([^\]]+)\]/.exec(req.userPrompt)![1];
        const clauseId = /\[id=([^\]]+)\] \(EMPLOYER, REQUIREMENT/.exec(req.userPrompt)![1];
        return JSON.stringify({ positions: [{ clauseId, coverage: 'not_covered', stance: null, note: 'Соискатель говорит, что не работал', evidenceRef: segId, evidenceQuote: 'нет, не работал' }] });
      }
      throw new Error(req.taskType);
    });
    const sheet = await s.sheets.openForVacancy('u1', s.vacancy.id);
    await s.sheets.confirmClauses('u1', sheet.id, sheet.clauses.filter((c) => c.side === 'EMPLOYER').map((c) => c.id));

    const q = await s.dialogue.nextQuestion('u1', sheet.id);
    expect(q).not.toBeNull();
    expect(q!.clauseText).toBe('Kubernetes');
    expect(q!.attempt).toBe(1);

    const answer = await s.dialogue.recordAnswer('u1', sheet.id, q!.clauseId, { text: 'нет, не работал', segmentId: null });
    expect(answer.proposedPositions).toHaveLength(1);
    expect(answer.proposedPositions[0].evidenceRef).toBe(answer.segmentId);
    expect(answer.proposedPositions[0].coverage).toBe('not_covered');
    expect(answer.proposedPositions[0].confirmedAt).toBeNull();
    // ответ лёг в транскрипт онбординг-разговора проекта
    const seg = s.prisma.rows('transcriptSegment').find((x) => x.id === answer.segmentId)!;
    expect(seg.text).toBe('нет, не работал');

    await s.dialogue.recordAnswer('u1', sheet.id, q!.clauseId, { text: 'нет', segmentId: null });
    await s.dialogue.recordAnswer('u1', sheet.id, q!.clauseId, { text: 'нет', segmentId: null });
    await expect(s.dialogue.recordAnswer('u1', sheet.id, q!.clauseId, { text: 'нет', segmentId: null })).rejects.toThrow(new RegExp(`${MAX_FOLLOW_UPS_PER_CLAUSE} уточнения`));
    // следующий вопрос — уже по другому пункту
    const q2 = await s.dialogue.nextQuestion('u1', sheet.id);
    expect(q2!.clauseText).toBe('Node.js');
  });
});
