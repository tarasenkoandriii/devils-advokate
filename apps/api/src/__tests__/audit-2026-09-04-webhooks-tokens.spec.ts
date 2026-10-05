// Сверка вебхуков и токенов 2026-09-04.
//
// ЧАСТЬ 1 — идемпотентность вебхуков. Проверка «разговор ещё в
// TRANSCRIBING» в `handleTranscriptionWebhook` стояла давно и была
// написана по следам реального инцидента: повтор доставки ставил вторую
// паралингвистическую джобу и второй раз декрементировал счётчик
// потребителей аудио, то есть удалял файл, пока первая джоба его читала.
// Но проверка была read-then-act, а ретрай провайдер шлёт ИМЕННО тогда,
// когда наш ответ медленный — то есть когда первый вызов ещё выполняется.
// Два одновременных вебхука оба читали TRANSCRIBING и оба шли дальше.
// Тот же класс, что уже закрывался в напоминаниях планировщика
// (claim-then-send) и в джобах голосовых реплик.
//
// ЧАСТЬ 2 — время жизни токенов. Сверены все шесть токенных моделей.
// У пяти всё на месте (срок, одноразовость или осознанная многоразовость,
// отзыв). У двух — приглашение в команду рекрутеров и в инвест-группу —
// не было НИЧЕГО, кроме срока в 72 часа: отозвать утёкшую ссылку было
// нечем, а вход по ней даёт полный доступ к общей базе кандидатов (§4.5)
// или к намерениям участников инвест-группы. Причём владелец не мог даже
// посмотреть, сколько живых ссылок в его команду существует.

import { ConversationProcessingStatus } from '@prisma/client';
import { BadRequestException } from '@nestjs/common';

import { ConversationsService } from '../conversations/conversations.service';
import { InterviewPoolTeamService } from '../interview-pool/interview-pool-team.service';
import { createHiringFakePrisma } from './fake-prisma';

// Ссылка-приглашение строится через deep-link бота; без имени бота
// хелпер честно отказывается её собирать (чтобы ссылка не вела в никуда).
// Тесту нужен сам токен, а не адрес, поэтому имя задаём здесь.
process.env.TELEGRAM_BOT_USERNAME = process.env.TELEGRAM_BOT_USERNAME ?? 'devils_advocate_test_bot';

function assertEqual(actual: unknown, expected: unknown, message: string) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a !== e) throw new Error(`FAIL: ${message}\n  expected: ${e}\n  actual:   ${a}`);
}

async function assertThrowsAsync(fn: () => Promise<unknown>, type: any, message: string) {
  try {
    await fn();
  } catch (err: any) {
    if (err instanceof type) return;
    throw new Error(`FAIL: ${message} — ожидался ${type.name}, получен ${err?.constructor?.name}: ${err?.message}`);
  }
  throw new Error(`FAIL: ${message} — исключения не было`);
}

/** Фейк разговора в состоянии «ждём результат расшифровки». Считает, что
 * обработчик реально сделал дальше по тексту: сколько раз освобождался
 * счётчик потребителей аудио и сколько раз ставилась паралингвистика. */
function webhookFake() {
  const conversation: any = {
    id: 'conv-1',
    projectId: 'p-1',
    status: ConversationProcessingStatus.TRANSCRIBING,
    externalTranscriptionJobId: 'assemblyai:job-1',
    paralinguisticsEnabled: true,
    transcriptionClaimedAt: null,
    pendingMediaConsumers: 2,
  };
  const released: number[] = [];
  const prisma: any = {
    conversation: {
      // Пункт [the-first-row-was-whichever] 2026-10-05: вебхук ищет
      // разговор `findMany({ take: 2 })` и при ДВУХ совпадениях не
      // привязывает ничего. Заглушка обязана знать эту форму — иначе
      // проверялся бы не код, а она.
      findMany: async () => [{ ...conversation }],
      findFirst: async () => ({ ...conversation }),
      updateMany: async ({ where, data }: any) => {
        // Точное подражание условному UPDATE: строка забирается, только
        // если отметки ещё нет (или она протухла).
        if (where.id !== conversation.id) return { count: 0 };
        if (where.status?.in && !where.status.in.includes(conversation.status)) return { count: 0 };
        if (where.OR) {
          const free =
            conversation.transcriptionClaimedAt === null ||
            conversation.transcriptionClaimedAt < where.OR[1].transcriptionClaimedAt.lt;
          if (!free) return { count: 0 };
        }
        Object.assign(conversation, data);
        return { count: 1 };
      },
      update: async ({ data }: any) => {
        Object.assign(conversation, data);
        return { ...conversation };
      },
    },
  };
  const stt: any = {
    fetchResult: async () => {
      throw new Error('provider unavailable');
    },
    discardOrphan: async () => undefined,
  };
  const svc = new ConversationsService(
    prisma,
    {} as any,
    {} as any,
    stt,
    {} as any,
    {} as any,
    {} as any,
  );
  (svc as any).releaseMediaConsumer = async (_id: string, count = 1) => {
    released.push(count);
  };
  return { svc, conversation, released };
}

async function run() {
  const results: { name: string; error?: string }[] = [];
  const scenarios: [string, () => Promise<void>][] = [];
  const test = (name: string, fn: () => Promise<void>) => scenarios.push([name, fn]);

  test('КЛЮЧЕВОЙ ТЕСТ: два одновременных вебхука расшифровки обрабатываются один раз', async () => {
    // Ретрай приходит именно тогда, когда первый вызов ещё идёт: оба
    // читают TRANSCRIBING. Без атомарного забора оба шли дальше и
    // дважды освобождали счётчик потребителей — то есть удаляли аудио
    // из-под первой, ещё работающей джобы.
    const f = webhookFake();
    const payload = { transcript_id: 'job-1', status: 'completed' };
    const [a, b] = await Promise.all([
      f.svc.handleTranscriptionWebhook(payload),
      f.svc.handleTranscriptionWebhook(payload),
    ]);
    const duplicates = [a, b].filter((r: any) => r.duplicate).length;
    assertEqual(duplicates, 1, 'ровно один из двух вебхуков распознан как дубль');
    assertEqual(f.released.length, 1, 'счётчик потребителей аудио освобождён ровно один раз');
  });

  test('КЛЮЧЕВОЙ ТЕСТ: после сбоя провайдера отметка снимается — повтор обработается, а не потеряется', async () => {
    // Повтор после FAILED разрешён намеренно: прошлая попытка могла
    // упасть на временной ошибке GET, а результат у провайдера готов.
    // С невыснятой отметкой такой повтор молча считался бы дублем.
    const f = webhookFake();
    await f.svc.handleTranscriptionWebhook({ transcript_id: 'job-1', status: 'completed' });
    assertEqual(f.conversation.status, ConversationProcessingStatus.FAILED, 'сбой провайдера записан');
    assertEqual(f.conversation.transcriptionClaimedAt, null, 'отметка снята — разговор не заперт');
  });

  test('протухшая отметка не запирает разговор навсегда', async () => {
    const f = webhookFake();
    f.conversation.transcriptionClaimedAt = new Date(Date.now() - 60 * 60 * 1000); // час назад
    const res: any = await f.svc.handleTranscriptionWebhook({ transcript_id: 'job-1', status: 'completed' });
    assertEqual(res.duplicate, undefined, 'обработка забрана заново, а не отброшена как дубль');
  });

  // ── Часть 2: приглашения ──

  function teamSetup() {
    const prisma = createHiringFakePrisma();
    const team = prisma.seed('recruitingTeam', { name: 'Агентство', teamType: 'AGENCY' });
    prisma.seed('recruitingTeamMember', { teamId: team.id, userId: 'владелец', role: 'OWNER' });
    return { prisma, team, svc: new InterviewPoolTeamService(prisma as any) };
  }

  test('КЛЮЧЕВОЙ ТЕСТ: отозванное приглашение перестаёт пускать в команду', async () => {
    // Ссылка многоразовая по замыслу — одну владелец шлёт нескольким
    // людям. Но до этой правки утёкшую ссылку нельзя было отозвать
    // ничем, а вход по ней даёт полный доступ к общей базе кандидатов.
    const s = teamSetup();
    const { token } = await s.svc.createInviteLink('владелец', s.team.id);

    const joined = await s.svc.joinTeam('первый', token);
    assertEqual(Boolean(joined), true, 'до отзыва ссылка работает');

    const invites = await s.svc.listInvites('владелец', s.team.id);
    assertEqual(invites.length, 1, 'владелец видит свои живые ссылки — отозвать можно только видимое');
    await s.svc.revokeInvite('владелец', s.team.id, invites[0].id);

    await assertThrowsAsync(() => s.svc.joinTeam('второй', token), BadRequestException, 'вход по отозванной ссылке');
    assertEqual(
      s.prisma.rows('recruitingTeamMember').filter((m: any) => m.userId === 'второй').length,
      0,
      'второй в команду не попал',
    );
  });

  test('отзыв не выкидывает уже вошедших — это отдельное действие, и обещать иное нельзя', async () => {
    const s = teamSetup();
    const { token } = await s.svc.createInviteLink('владелец', s.team.id);
    await s.svc.joinTeam('первый', token);
    const invites = await s.svc.listInvites('владелец', s.team.id);
    await s.svc.revokeInvite('владелец', s.team.id, invites[0].id);

    assertEqual(
      s.prisma.rows('recruitingTeamMember').filter((m: any) => m.userId === 'первый').length,
      1,
      'вошедший остаётся участником',
    );
  });

  test('отзывать чужие приглашения нельзя, и текст отказа не выдаёт существование ссылки', async () => {
    const s = teamSetup();
    const { token } = await s.svc.createInviteLink('владелец', s.team.id);
    void token;
    const invites = await s.svc.listInvites('владелец', s.team.id);
    await assertThrowsAsync(
      () => s.svc.revokeInvite('посторонний', s.team.id, invites[0].id),
      Error,
      'отзыв посторонним',
    );
  });

  test('повторный отзыв не сдвигает дату — первая отметка и есть момент отзыва', async () => {
    const s = teamSetup();
    await s.svc.createInviteLink('владелец', s.team.id);
    const invites = await s.svc.listInvites('владелец', s.team.id);
    const first = await s.svc.revokeInvite('владелец', s.team.id, invites[0].id);
    const second = await s.svc.revokeInvite('владелец', s.team.id, invites[0].id);
    assertEqual(second.revokedAt, first.revokedAt, 'дата отзыва не переписывается');
  });

  for (const [name, fn] of scenarios) {
    try {
      await fn();
      results.push({ name });
    } catch (err: any) {
      results.push({ name, error: err.message });
    }
  }

  const failed = results.filter((r) => r.error);
  console.log(`\nВебхуки и токены: ${results.length - failed.length}/${results.length} passed\n`);
  for (const r of results) {
    console.log(`${r.error ? '✗' : '✓'} ${r.name}`);
    if (r.error) console.log(`  ${r.error}`);
  }
  if (failed.length > 0) process.exit(1);
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
