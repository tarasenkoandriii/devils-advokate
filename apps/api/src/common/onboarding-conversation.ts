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
export async function ensureOnboardingConversation(
  prisma: PrismaService,
  projectId: string,
): Promise<OnboardingConversationBundle> {
  const existing = await prisma.conversation.findFirst({
    where: {
      projectId,
      sourceType: ConversationSourceType.TEXT_IMPORT,
      // Ревью 2026-09-02: одного TEXT_IMPORT мало. Импорт переписки
      // (chat-import) создаёт разговоры с тем же sourceType, статусом и
      // транскриптом — и импортированный ДО первого открытия онбординга
      // чат оказался бы «онбординг-разговором»: ответы дописались бы в
      // чужой транскрипт, а extract прочитал бы всю переписку как ответы
      // пользователя. Различает их участник: онбординг заводит ровно
      // одного с diarizationLabel 'SELF', импорт — 'IMPORTED_<i>'.
      participants: { some: { diarizationLabel: 'SELF', isSelf: true } },
      // Разговор без транскрипта не подходит под ветку переиспользования
      // ниже — если его не отсечь здесь, findFirst возвращал бы его
      // снова и снова, а функция каждый раз создавала бы новый: ровно
      // тот баг, который она чинит.
      transcript: { isNot: null },
    },
    orderBy: { createdAt: 'asc' },
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
