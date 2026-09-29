// Пункт [letters-were-not-the-language] 2026-09-24 — поведенческая
// половина.
//
// ЭТА СВЕРКА — О ДВУХ МОИХ СОБСТВЕННЫХ ПРАВИЛАХ, НАПИСАННЫХ НА ПРОШЛОЙ
// И ПОЗАПРОШЛОЙ НЕДЕЛЕ. Оба выглядели работающими и оба измеряли не то,
// что называли.
//
// 1. ПРАВИЛО ЯЗЫКА СЧИТАЛО БУКВЫ. Сверка [draft-spoke-machine]
//    объявляла текст «на чужом языке», если в нём есть і, ї, є или ґ.
//    На публичной странице по ссылке стояло «Посилання прострочене» —
//    целиком украинская фраза, в которой НЕТ НИ ОДНОЙ из этих букв.
//    Правило её не увидело и объявило ось чистой. Буквы ловят
//    НАПИСАНИЕ, а не ЯЗЫК. Исправленный разбор нашёл сразу вторую:
//    «Не вдалося зберегти доказ».
//
// 2. ПРАВИЛО ПОВЕРХНОСТЕЙ ПЕРЕБИРАЛО ИМЕНА ФАЙЛОВ. Сверка
//    [badge-was-the-key] искала контроллеры по имени
//    `*.public-controller.ts` и находила ТРИ из СЕМИ: четыре
//    контроллера без гварда живут в обычных `*.controller.ts` рядом с
//    защищёнными. А реестр `public-surfaces.ts`, на который та же
//    сверка ссылалась, знал о семи — и его шапка прямо предупреждает
//    об этой ловушке. Я прочитал предупреждение и построил перебор по
//    ЗЕРКАЛЬНОМУ отражению той же ошибки: по особому имени вместо
//    обычного.
//
// Общий вывод, и он не про эти два случая: ПРОВЕРКА ИЗМЕРЯЕТ ТО, ЧТО
// ИЗМЕРЯЕТ, А НЕ ТО, КАК НАЗЫВАЕТСЯ. Оба правила были зелёными всё
// время, пока не работали.

import { UNGUARDED_SURFACES } from '../common/public-surfaces';
import { CandidateSelfShareService } from '../candidate-self-share/candidate-self-share.service';
import { TERM_OVER_MESSAGE } from '../common/term-validity';

function sharePrisma(share: Record<string, unknown> | null) {
  return {
    candidateShare: { findUnique: async () => share },
    cvVariant: { findUnique: async () => ({ id: 'v1', cvText: 'моё резюме' }) },
    termsSheet: { findUnique: async () => ({ id: 'sh1', projectId: 'private-project-77', title: 'Вакансия' }) },
    jobSearchConfig: { findUnique: async () => ({ desiredRole: 'инженер', cvDraft: null }) },
  } as any;
}

const SHARE = {
  id: 'share-1',
  shareToken: 'tok',
  consentSource: 'CANDIDATE_SELF',
  expiresAt: new Date(Date.now() + 86_400_000),
  revokedAt: null,
  acceptedAt: null,
  sourceCvVariantId: 'v1',
  sourceSheetId: 'sh1',
  visibleClauseIds: [],
  sharedByUserId: 'u1',
  consentTextVersion: 'v1',
};

describe('[letters-were-not-the-language] проверка измеряет то, что измеряет', () => {
  it('КЛЮЧЕВОЙ ТЕСТ: реестр поверхностей знает о семи открытых контроллерах, а не о трёх', () => {
    const open = UNGUARDED_SURFACES.filter((s) => s.protection === 'token-or-open');

    expect(open).toHaveLength(7);
    // Четыре из них живут в обычных `*.controller.ts` — именно их и не
    // видел перебор по имени файла.
    const ordinary = open.filter((s) => !s.file.endsWith('.public-controller.ts'));
    expect(ordinary.map((s) => s.controller).sort()).toEqual([
      'CandidateSelfSharePublicController',
      'InterviewPoolShareController',
      'PostingReviewPublicController',
      'PreQuestionnairePublicController',
    ]);
  });

  it('у каждой открытой поверхности названа причина, а не «так исторически»', () => {
    for (const surface of UNGUARDED_SURFACES.filter((s) => s.protection === 'token-or-open')) {
      expect(surface.reason.length).toBeGreaterThan(40);
    }
  });

  it('предпросмотр самошеринга не отдаёт идентификатор частного проекта соискателя', async () => {
    const service = new CandidateSelfShareService(sharePrisma(SHARE), {} as any, { loadClauses: async () => [] } as any);

    const view = await service.preview('tok');

    expect(JSON.stringify(view).includes('private-project-77')).toBe(false);
    // А то, ради чего ссылку открывают, на месте.
    expect((view as any).cvText).toBe('моё резюме');
  });

  it('просроченная ссылка объясняется на языке интерфейса', async () => {
    const expired = { ...SHARE, expiresAt: new Date(Date.now() - 1000) };
    const service = new CandidateSelfShareService(sharePrisma(expired), {} as any, { loadClauses: async () => [] } as any);

    await expect(service.preview('tok')).rejects.toThrow(TERM_OVER_MESSAGE);
    // Тот же текст, что у остальных истёкших ссылок: человеку всё
    // равно, какой именно маршрут отказал.
    expect(TERM_OVER_MESSAGE).toBe('Ссылка недействительна или просрочена');
  });
});
