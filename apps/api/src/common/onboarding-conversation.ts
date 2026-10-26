// Пункт [onboarding-continuity] 2026-09-02 — ИСПРАВЛЕНИЕ АУДИТА.
//
// НАЙДЕНО. `createOnboardingConversation` во всех семи доменах создавал
// НОВЫЙ разговор при каждом вызове. Экран онбординга в TMA зовёт его,
// когда не знает conversationId, — а не знал он его всегда: intake
// возвращал id, но переход на экран домена его выбрасывал. Итог,
// воспроизводимый на любом домене:
//
//   голосовой квиз → «Да, перейти» → экран домена пуст
//   («Расскажите о ситуации своими словами») → «Извлечь конфиг»
//   отвечает 400 «в этом онбординг-разговоре пока нет ответов»
//
// То есть обещание «данные не придётся вводить повторно» не работало
// ни разу, а ответы квиза оставались в первом, недостижимом разговоре.
//
// Чинится с двух сторон, потому что причин две. Здесь — серверная:
// онбординг-разговор у проекта ОДИН, повторный вызов возвращает его, а
// не плодит новые. Это же снимает двойное создание в dev-StrictMode и
// «возврат к проекту через неделю» (клиент тогда тоже не знает id).
import { NotFoundException } from '@nestjs/common';
import {
  Conversation,
  ConversationParticipant,
  ConversationProcessingStatus,
  ConversationSourceType,
  Transcript,
} from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';

export interface OnboardingConversationBundle {
  conversation: Conversation;
  participant: ConversationParticipant;
  transcript: Transcript;
  /** true — вернули существующий разговор, а не создали новый. */
  reused: boolean;
}

/**
 * Онбординг-разговор проекта: существующий или новый.
 *
 * Опознание — САМЫЙ РАННИЙ TEXT_IMPORT-разговор проекта. Онбординг
 * создаётся первым действием после создания проекта (и в intake, и на
 * экране домена), поэтому более поздние импорты переписки под это
 * условие не попадают.
 */
/** ПРИЗНАКИ онбординг-разговора — ОДНО место на весь продукт.
 *
 * Пункт [the-kind-was-never-checked] 2026-10-26: до него признаки жили
 * только внутри `ensureOnboardingConversation`, то есть у ПОИСКА. А
 * методы, принимающие `conversationId` снаружи (`appendAnswer`,
 * `extract`, `getChecklist`, `getOnboardingAnswers`), брали разговор по
 * голому id и проверяли только владение — то есть принимали ЛЮБОЙ
 * разговор человека. Признаки, которые проверяет только одна половина
 * пары, инвариантом не являются; теперь их проверяют обе, и из одного
 * объявления.
 *
 * Ревью 2026-09-02 (сохранено как есть, это и есть причина признаков):
 * одного TEXT_IMPORT мало. Импорт переписки (chat-import) создаёт
 * разговоры с тем же sourceType, статусом и транскриптом — и
 * импортированный ДО первого открытия онбординга чат оказался бы
 * «онбординг-разговором»: ответы дописались бы в чужой транскрипт, а
 * extract прочитал бы всю переписку как ответы пользователя. Различает
 * их участник: онбординг заводит ровно одного с diarizationLabel
 * 'SELF', импорт — 'IMPORTED_<i>'. */
export const ONBOARDING_CONVERSATION_WHERE = {
  // ИЗБЫТОЧЕН СЕГОДНЯ, и это измерено, а не предположено: мутация
  // «убрать `sourceType`» ПЕРЕЖИЛА все проверки Пункта
  // [the-kind-was-never-checked]. Отбор держит метка участника —
  // `diarizationLabel: 'SELF'` ставит ровно одно место продукта
  // (`ensureOnboardingConversation` ниже), а диаризация провайдера и
  // импорт переписки ставят `SPEAKER_xx` и `IMPORTED_<i>`.
  //
  // Признак оставлен НАМЕРЕННО, и подгонять под него тест я не стал:
  // чтобы мутация умирала, пришлось бы завести разговор, которого в
  // продукте быть не может (метка 'SELF' при не-TEXT_IMPORT), то есть
  // выдумать случай ради зелёной мутации. Метка — КОНВЕНЦИЯ, а не
  // ограничение базы: провайдер, выдавший лейбл 'SELF', вернёт этому
  // признаку вес в тот же день.
  sourceType: ConversationSourceType.TEXT_IMPORT,
  participants: { some: { diarizationLabel: 'SELF', isSelf: true } },
  // Разговор без транскрипта не подходит под ветку переиспользования
  // ниже — если его не отсечь здесь, findFirst возвращал бы его снова и
  // снова, а функция каждый раз создавала бы новый: ровно тот баг,
  // который она чинит.
  transcript: { isNot: null },
} as const;

/** Пункт [the-first-row-was-whichever] 2026-10-05: «самый ранний» по
 *  `createdAt` одному порядка не задаёт — `now()` в Postgres это время
 *  НАЧАЛА транзакции. Второй ключ `id` в ту же сторону: cuid монотонен
 *  по времени, значит «ранний» остаётся ранним. */
export const ONBOARDING_CONVERSATION_ORDER = [{ createdAt: 'asc' as const }, { id: 'asc' as const }];

/** Идентификатор онбординг-разговора проекта — или `null`, если его нет.
 *  Тот же отбор, что у `ensureOnboardingConversation`: не копия
 *  признаков, а тот же объект. */
export async function onboardingConversationId(prisma: PrismaService, projectId: string): Promise<string | null> {
  const row = await prisma.conversation.findFirst({
    where: { projectId, ...ONBOARDING_CONVERSATION_WHERE },
    orderBy: ONBOARDING_CONVERSATION_ORDER,
    select: { id: true },
  });
  return row?.id ?? null;
}

/** Проверка, что переданный разговор И ЕСТЬ онбординг-разговор своего
 *  проекта — то есть ровно тот, который вернул бы
 *  `ensureOnboardingConversation`.
 *
 *  Почему сравнение с найденным, а не повторение признаков: «онбординг
 *  у проекта ОДИН» — определение этой функции-близнеца, и у проекта с
 *  двумя подходящими разговорами онбординг только самый ранний.
 *  Повторять признаки здесь значило бы завести вторую их копию, которой
 *  и так уже хватило на этот Пункт.
 *
 *  Отказ — 404 с тем же текстом, что у отсутствующего разговора:
 *  существование чужого по виду разговора человеку сообщать незачем, а
 *  свой он всё равно видит на экране. */
export async function assertOnboardingConversation(
  prisma: PrismaService,
  conversation: { id: string; projectId: string },
): Promise<void> {
  if ((await onboardingConversationId(prisma, conversation.projectId)) === conversation.id) return;
  throw new NotFoundException(`Onboarding conversation ${conversation.id} not found`);
}

export async function ensureOnboardingConversation(
  prisma: PrismaService,
  projectId: string,
): Promise<OnboardingConversationBundle> {
  const existing = await prisma.conversation.findFirst({
    where: { projectId, ...ONBOARDING_CONVERSATION_WHERE },
    orderBy: ONBOARDING_CONVERSATION_ORDER,
    include: {
      transcript: true,
      participants: { where: { isSelf: true }, take: 1 },
    },
  });

  if (existing?.transcript && existing.participants[0]) {
    const { transcript, participants, ...conversation } = existing;
    return { conversation, participant: participants[0], transcript, reused: true };
  }

  return prisma.$transaction(async (tx) => {
    const conversation = await tx.conversation.create({
      data: {
        projectId,
        sourceType: ConversationSourceType.TEXT_IMPORT,
        status: ConversationProcessingStatus.TRANSCRIBED,
        occurredAt: new Date(),
      },
    });
    const participant = await tx.conversationParticipant.create({
      data: { conversationId: conversation.id, diarizationLabel: 'SELF', isSelf: true },
    });
    const transcript = await tx.transcript.create({ data: { conversationId: conversation.id } });
    return { conversation, participant, transcript, reused: false };
  });
}
