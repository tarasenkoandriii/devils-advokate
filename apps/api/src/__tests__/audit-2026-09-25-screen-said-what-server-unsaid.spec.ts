// Пункт [screen-said-what-server-unsaid] 2026-09-25, серверная половина.
//
// Экранная половина проверяется в `apps/tma/src/__tests__` — там текст
// РИСУЕТСЯ. Здесь проверяется то, что можно проверить только на сервере:
// что список «что остаётся» ОДИН и что оба пути — чтение до удаления и
// ответ на удаление — отдают именно его, а не свою копию.

import { PrivacyCenterController } from '../privacy-center/privacy-center.controller';
import { ACCOUNT_NOT_REMOVED_HERE, ACCOUNT_REMOVED_KEYS } from '../privacy-center/deletion-report';

describe('Пункт [screen-said-what-server-unsaid] 2026-09-25: один текст на два чтения', () => {
  // Пункт [cascade-took-a-stranger] 2026-09-26: чтение «до удаления»
  // теперь ещё и СЧИТАЕТ, что удаление заберёт у других, — значит ему
  // нужен сервис. Заглушка отвечает пустым списком: числа проверяются
  // своей спекой, здесь речь про текст «что остаётся».
  const controller = new PrivacyCenterController({ thirdPartyLosses: async () => [] } as never);

  it('КЛЮЧЕВОЙ ТЕСТ: чтение «до удаления» отдаёт тот же список, что и ответ на удаление', async () => {
    const preview = await controller.accountDeletionPreview('u-1');
    expect(preview.notRemovedHere).toEqual([...ACCOUNT_NOT_REMOVED_HERE]);
    expect(preview.notRemovedHere.length).toBe(6);
  });

  it('список отдаётся копией — вызывающий не может изменить общую константу', async () => {
    const first = await controller.accountDeletionPreview('u-1');
    first.notRemovedHere.push('дописано вызывающим');
    expect((await controller.accountDeletionPreview('u-1')).notRemovedHere).toEqual([...ACCOUNT_NOT_REMOVED_HERE]);
  });

  it('исправленное утверждение о журнале осталось исправленным', () => {
    const joined = ACCOUNT_NOT_REMOVED_HERE.join('\n');
    // Пункт [audit-trail] 2026-09-04 снял отсюда фразу «Журнал аудита —
    // хранится без персональных данных»: она была неправдой. Вернуться
    // она может только незаметно, поэтому проверяется отдельно.
    expect(joined).not.toMatch(/журнал[а-я]* аудита[^.]*без персональных данных/i);
    expect(joined).toMatch(/Журнал решений, принятых о вашем аккаунте/);
    expect(joined).toMatch(/Свободные заметки модератора/);
  });

  it('каждая строка списка называет ПРИЧИНУ, а не только факт', () => {
    for (const line of ACCOUNT_NOT_REMOVED_HERE) {
      expect(line.length).toBeGreaterThan(60);
      // «остаётся» без объяснения — это и есть пробел, выданный за
      // полноту: человек читает, что след остаётся, и не знает зачем.
      expect(line).toMatch(/[:;—]|потому|по политике|для /i);
    }
  });

  it('реестр ключей отчёта перечисляет ровно то, что складывает сервис', () => {
    // Числа счётчиков собираются в двух местах: countUserData (шесть) и
    // scrub-шаги (четыре). Реестр существует, чтобы новый ключ был
    // замечен здесь, а не вылез на экран машинным именем — и он
    // сработал: `aiJobsAnonymised` завёл Пункт
    // [anonymised-was-not-anonymous] 2026-09-29.
    expect(ACCOUNT_REMOVED_KEYS).toEqual([
      'projects',
      'conversations',
      'people',
      'consents',
      'intakeSessions',
      'mediaQueues',
      'aiInferences',
      'aiJobsCancelled',
      'aiJobsAnonymised',
      'auditEntriesScrubbed',
    ]);
  });
});
