// Сверка журнала аудита 2026-09-04 — копия, которую не трогало ни одно
// удаление.
//
// ПОЧЕМУ ИМЕННО СЮДА. Предыдущие заходы проверяли основные таблицы:
// удаление аккаунта, удаление проекта, выгрузку данных. Журнал аудита —
// теневая копия рядом с ними: он пишется теми же сервисами, живёт в той
// же базе и при этом не попадает ни под один каскад (`actorId`
// намеренно не FK) и не упоминается ни в одном списке исключений.
//
// НАЙДЕНО — и это самая неприятная находка из всех до сих пор, потому
// что речь не о молчании, а о неверном утверждении.
//
// Продукт говорил человеку ТРИ раза, в трёх местах, одно и то же:
//   • отчёт об удалении аккаунта: «Журнал аудита — хранится без
//     персональных данных»;
//   • выгрузка данных: «Журнал аудита — служебный, без персональных
//     данных»;
//   • комментарий в самом коде удаления: «ПД в них нет — before/after
//     фильтруются при записи».
//
// Ни одно из трёх не было правдой. Никакой фильтрации при записи не
// существует — `AuditLogService.record()` кладёт `before`/`after` как
// есть. В журнале лежали:
//   • `actorId` — идентификатор самого человека, на каждой его записи;
//   • `resourceId` записей `user.restricted` / `user.blocked` /
//     `user.deleted` — тоже он, как СУБЪЕКТ решения;
//   • свободный текст о нём: `restrictedNote` и `blockedNote` (заметка
//     модератора, в before И в after), `frozenNote` (заморозка проекта),
//     `note` до 500 символов при отзыве согласия кандидата — то есть
//     текст о ТРЕТЬЕМ человеке, у которого аккаунта нет вовсе.
//
// Все предыдущие сверки ловили форму «пробел выглядит как полнота». Эта
// — форму строже: УТВЕРЖДЕНИЕ ЗВУЧИТ КАК ГАРАНТИЯ. Молчание человек ещё
// может проверить сам; на «персональных данных там нет» он полагается.
//
// ЧТО СДЕЛАНО И ГДЕ ПРОВЕДЕНА ГРАНИЦА. Журнал решений оператора обязан
// пережить удаление аккаунта: это единственное свидетельство, что
// решение принималось, то есть то, чем человек может его оспорить.
// Удалить журнал целиком значило бы защитить оператора, а не человека.
// Поэтому: структура решения остаётся, свободный текст вычищается при
// удалении аккаунта, а сами решения О ЧЕЛОВЕКЕ теперь попадают в
// выгрузку — раньше он не мог узнать даже того, что они существуют.
//
// НЕ СДЕЛАНО НАМЕРЕННО:
//  • `actorId`/`resourceId` не обезличиваются: по ним и находят все
//    решения об одном человеке, без них журнал перестаёт быть тем, ради
//    чего сохраняется;
//  • у журнала нет срока хранения. Срок — это политика, а не код:
//    решение владельца, и выдумывать за него число здесь не нужно (тот
//    же принцип, по которому в [page-limits] отложено ограничение
//    частоты публичной записи);
//  • заметка о кандидате, у которого нет аккаунта, чистится только
//    вместе с аккаунтом РЕКРУТЕРА (он актор этой записи). Сам кандидат
//    попросить об удалении не может — у него нет входа в продукт; это
//    названо здесь, а не спрятано.

import { readdirSync, readFileSync, statSync } from 'fs';
import { join, relative } from 'path';
import {
  ACTIONS_WITH_FREE_TEXT,
  AuditLogService,
  FREE_TEXT_AUDIT_KEYS,
  SCRUBBED_MARKER,
} from '../audit-log/audit-log.service';

const SRC = join(__dirname, '..');

function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
}

/** Весь исходник API, кроме тестов: утверждение, обещанное человеку,
 * может жить в любом сервисе, и проверять его в одном файле — значит
 * проверять не то. */
function allApiSources(dir: string = SRC): string[] {
  return readdirSync(dir).flatMap((name) => {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) return name === '__tests__' ? [] : allApiSources(full);
    return name.endsWith('.ts') ? [full] : [];
  });
}

function makePrisma(entries: any[]) {
  return {
    entries,
    auditLogEntry: {
      findMany: async ({ where, select }: any) => {
        const rows = entries.filter((e) => {
          const matchesWho = where.OR.some((cond: any) =>
            cond.actorId !== undefined
              ? e.actorId === cond.actorId
              : e.resource === cond.resource && e.resourceId === cond.resourceId,
          );
          const matchesAction = where.action.in.includes(e.action);
          return matchesWho && matchesAction;
        });
        if (!select) return rows;
        return rows.map((r) => {
          const projected: any = {};
          for (const key of Object.keys(select)) projected[key] = r[key];
          return projected;
        });
      },
      update: async ({ where, data }: any) => {
        const row = entries.find((e) => e.id === where.id);
        for (const [key, value] of Object.entries(data)) {
          if (value !== undefined) row[key] = value;
        }
        return row;
      },
    },
  };
}

describe('Журнал аудита: что переживает удаление аккаунта', () => {
  it('КЛЮЧЕВОЙ ТЕСТ: заметка модератора о человеке исчезает вместе с аккаунтом, решение — остаётся', async () => {
    const prisma = makePrisma([
      {
        id: 'a1',
        actorId: 'operator-1',
        action: 'user.restricted',
        resource: 'User',
        resourceId: 'user-1',
        before: { isRestricted: false, restrictedNote: null },
        after: { isRestricted: true, restrictedNote: 'спамил в публичном обсуждении, третье предупреждение' },
      },
    ]);
    const svc = new AuditLogService(prisma as any);

    const result = await svc.scrubFreeTextForDeletedUser('user-1');

    expect(result.auditEntriesScrubbed).toBe(1);
    const entry = prisma.entries[0];
    // Формулировка ушла...
    expect(JSON.stringify(entry)).not.toContain('спамил');
    expect(entry.after.restrictedNote).toBe(SCRUBBED_MARKER);
    // ...а само решение осталось: без него оспорить нечего.
    expect(entry.after.isRestricted).toBe(true);
    expect(entry.action).toBe('user.restricted');
    expect(entry.resourceId).toBe('user-1');
  });

  it('КЛЮЧЕВОЙ ТЕСТ: чистится и текст, написанный САМИМ человеком о третьем лице', async () => {
    // Рекрутер отзывает согласие кандидата и пишет заметку — это текст о
    // другом человеке, попадающий в журнал. При удалении аккаунта
    // рекрутера он тоже должен уйти: он актор этой записи.
    const prisma = makePrisma([
      {
        id: 'a2',
        actorId: 'user-1',
        action: 'candidate_consent.revoked_by_recruiter',
        resource: 'CandidateProfile',
        resourceId: 'cand-9',
        after: { note: 'сам попросил убрать, сказал что нашёл работу', sharesRevoked: 3 },
      },
    ]);
    const svc = new AuditLogService(prisma as any);

    await svc.scrubFreeTextForDeletedUser('user-1');

    expect(prisma.entries[0].after.note).toBe(SCRUBBED_MARKER);
    expect(prisma.entries[0].after.sharesRevoked).toBe(3); // число решения — не текст
  });

  it('КЛЮЧЕВОЙ ТЕСТ: чужие записи не трогаются', async () => {
    const prisma = makePrisma([
      {
        id: 'a3',
        actorId: 'operator-1',
        action: 'user.blocked',
        resource: 'User',
        resourceId: 'кто-то-другой',
        after: { isBlocked: true, blockedNote: 'заметка про другого человека' },
      },
    ]);
    const svc = new AuditLogService(prisma as any);

    const result = await svc.scrubFreeTextForDeletedUser('user-1');

    expect(result.auditEntriesScrubbed).toBe(0);
    expect(prisma.entries[0].after.blockedNote).toBe('заметка про другого человека');
  });

  it('отсутствующая заметка не подменяется маркером — «пусто» и «стёрто» разные утверждения', async () => {
    const prisma = makePrisma([
      {
        id: 'a4',
        actorId: 'operator-1',
        action: 'user.unrestricted',
        resource: 'User',
        resourceId: 'user-1',
        before: { isRestricted: true, restrictedNote: null },
        after: { isRestricted: false, restrictedNote: null },
      },
    ]);
    const svc = new AuditLogService(prisma as any);

    const result = await svc.scrubFreeTextForDeletedUser('user-1');

    expect(result.auditEntriesScrubbed).toBe(0);
    expect(prisma.entries[0].after.restrictedNote).toBeNull();
  });

  it('КЛЮЧЕВОЙ ТЕСТ: список текстовых ключей не отстаёт от того, что сервисы реально кладут в журнал', () => {
    // Новый свободный ключ, добавленный в before/after мимо этого списка,
    // переживёт удаление аккаунта — и обещание пользователю снова
    // разойдётся с делом. Здесь сверяется код сервисов, а не память.
    //
    // ЧЕСТНАЯ ГРАНИЦА ЭТОЙ ПРОВЕРКИ: она узнаёт свободный текст ПО ИМЕНИ
    // ключа, по словарю ниже. Ключ, названный как-то ещё («summary»,
    // «what_happened»), она не поймает — первая версия проверки искала
    // только `*Note` и `reason`, и подсунутый `operatorRemark` прошёл
    // мимо неё незамеченным (проверено мутацией). Словарь расширен до
    // обычных слов для текста, но заменой внимательности он не является,
    // и делать вид, что является, здесь не нужно.
    const FREE_TEXT_WORDS = /(note|remark|comment|reason|text|message|description|summary|title|explanation)/i;
    const sources = [
      'admin-users/admin-users.service.ts',
      'admin-domains/admin-domains.service.ts',
      'interview-pool/interview-pool-candidate.service.ts',
      'privacy-center/privacy-center.service.ts',
    ];
    const suspicious = new Set<string>();
    for (const rel of sources) {
      const src = readFileSync(join(SRC, rel), 'utf8');
      for (const m of src.matchAll(/^\s*(?:before|after):\s*\{([^}]*)\}/gm)) {
        // Ключ — только в начале элемента объекта, иначе в «ключи»
        // попадает кусок выражения: `err.message : String(err)` внутри
        // тернарника дал ложное «message» на первом прогоне.
        for (const km of m[1].matchAll(/(?:^|[{,])\s*(\w+)\s*:/g)) {
          if (FREE_TEXT_WORDS.test(km[1])) suspicious.add(km[1]);
        }
      }
    }
    const uncovered = [...suspicious].filter((key) => !(FREE_TEXT_AUDIT_KEYS as readonly string[]).includes(key));
    expect(uncovered).toEqual([]);
    expect(suspicious.size).toBeGreaterThan(0); // сверка действительно что-то нашла, а не прошла вхолостую
  });

  it('КЛЮЧЕВОЙ ТЕСТ: продукт больше нигде не утверждает, что в журнале нет персональных данных', () => {
    // Три места говорили это одновременно, и все три были неправдой.
    // Проверяется отсутствие самого утверждения, а не его переписанная
    // форма: неверная гарантия хуже, чем её отсутствие.
    // Комментарии снимаются — тот же приём и по той же причине, что в
    // сверке [outside-input]: объяснение находки цитирует прежний текст
    // дословно, и без снятия проверка спотыкалась бы о собственное
    // объяснение. Сами утверждения жили в строках кода, не в
    // комментариях, поэтому проверка от снятия не слабеет.
    // Пункт [delete-project] 2026-09-04 РАСШИРИЛ эту проверку. Она
    // читала ОДИН файл — privacy-center.service.ts — и потому пропустила
    // четвёртую копию того же утверждения, жившую в projects.service.ts
    // (список «что переживает удаление проекта»). Сторож, суженный до
    // одного файла, отчитывается за весь дом. Теперь читается весь
    // исходник API.
    const claims = [
      'Журнал аудита — хранится без персональных данных',
      'Журнал аудита — служебный, без персональных данных',
      'Журнал аудита — хранится без персональных данных.',
      'before/after фильтруются при записи',
    ];
    const offenders: string[] = [];
    for (const file of allApiSources()) {
      const src = stripComments(readFileSync(file, 'utf8'));
      for (const claim of claims) {
        if (src.includes(claim)) offenders.push(`${relative(SRC, file)}: «${claim}»`);
      }
    }
    expect(offenders).toEqual([]);

    const privacy = stripComments(readFileSync(join(SRC, 'privacy-center/privacy-center.service.ts'), 'utf8'));
    // И вместо утверждения — то, что происходит на самом деле.
    expect(privacy).toContain('scrubFreeTextForDeletedUser');
  });

  it('КЛЮЧЕВОЙ ТЕСТ: решения о человеке попадают в выгрузку, а заметка оператора — названа как не вошедшая', () => {
    const privacy = readFileSync(join(SRC, 'privacy-center/privacy-center.service.ts'), 'utf8');
    expect(privacy).toContain('accountDecisions');
    // Выбираются поимённо: рабочая формулировка оператора не отдаётся.
    expect(privacy).toMatch(/select: \{ action: true, resource: true, resourceId: true, createdAt: true \}/);
    expect(privacy).toMatch(/заметки модератора/);
  });

  it('КЛЮЧЕВОЙ ТЕСТ: маркер «стёрто» — не пустая строка', () => {
    // Сверка конвенционных проверок 2026-09-04 ([guard-audit]): тесты
    // выше сравнивают результат С САМОЙ КОНСТАНТОЙ, поэтому мутация
    // «сделать маркер пустой строкой» проходила их все. А различие
    // «заметки не было» и «заметка удалена» — ровно то, ради чего маркер
    // и заведён: пустое поле человек прочитает как «ничего и не писали».
    expect(SCRUBBED_MARKER.trim().length).toBeGreaterThan(5);
    expect(SCRUBBED_MARKER).toMatch(/[А-Яа-я]/);
  });

  it('ИЗМЕРЕНИЕ: сколько действий журнала могут нести свободный текст', () => {
    // Число живёт здесь, чтобы следующая сверка начинала с факта.
    expect(ACTIONS_WITH_FREE_TEXT.length).toBe(8);
    expect(FREE_TEXT_AUDIT_KEYS.length).toBe(5);
  });
});
