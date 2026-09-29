// Сверка удаления проекта 2026-09-04 — что переживает «удалить проект».
//
// Прошлая сверка удаления ([deletion-sweep]) смотрела удаление АККАУНТА и
// нашла там кэши, которые никому не принадлежат. Удаление проекта — другой
// путь того же класса, и его никто не проверял.
//
// Найдено две вещи.
//
// ПЕРВАЯ, и она серьёзная. `PersonFact.projectId` стоял с `onDelete:
// SetNull`. Инвариант, который сам сервис проверяет при создании
// (`person-facts.service.ts`): «projectId обязателен при scope=PROJECT,
// и не должен указываться для остальных». Удаление проекта нарушало его
// молча: факт со scope=PROJECT оставался с projectId=null — состояние,
// создать которое код запрещает.
//
// Последствие хуже формального нарушения. Читают такие факты как
// `{ scope: 'PROJECT', projectId }` — осиротевший факт не находится
// НИКОГДА, но остаётся в базе. Человек нажал «удалить проект», а
// собранные там сведения о ДРУГОМ человеке продолжали существовать, и ни
// посмотреть, ни удалить их через интерфейс уже нельзя. Для продукта,
// который обещает «первоисточники остаются у вас» и даёт удаление как
// настоящее удаление, это прямое расхождение обещания с поведением.
//
// ВТОРАЯ. Удаление аккаунта честно перечисляет, что переживает удаление
// (`notRemovedHere`), а удаление проекта отвечало молчаливым «готово» —
// при том что переживает оно немало. Один продукт, два пути, честен один.

import { ProjectsService } from '../projects/projects.service';

function assertEqual(actual: unknown, expected: unknown, message: string) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a !== e) throw new Error(`FAIL: ${message}\n  expected: ${e}\n  actual:   ${a}`);
}

/** Фейк, повторяющий каскад Postgres по объявленным в схеме правилам:
 * удаление проекта уносит строки с `onDelete: Cascade` и обнуляет
 * `SetNull`. Ровно то поведение, которое и оказалось предметом сверки. */
function projectsFake(cascadeForPersonFacts: boolean) {
  const facts: any[] = [
    { id: 'f-1', personId: 'p-1', projectId: 'proj-1', scope: 'PROJECT', content: 'Обещал закрыть долг в марте' },
    { id: 'f-2', personId: 'p-1', projectId: null, scope: 'PERSON_GLOBAL', content: 'Живёт в другом городе' },
  ];
  const consents: any[] = [{ id: 'c-1', userId: 'u-1', projectId: 'proj-1', consentType: 'EXTERNAL_AI' }];
  const prisma: any = {
    project: {
      findFirst: async ({ where }: any) =>
        where.id === 'proj-1' && where.ownerId === 'u-1' ? { id: 'proj-1', ownerId: 'u-1' } : null,
      delete: async () => {
        for (let i = facts.length - 1; i >= 0; i--) {
          if (facts[i].projectId !== 'proj-1') continue;
          if (cascadeForPersonFacts) facts.splice(i, 1);
          else facts[i].projectId = null; // прежнее поведение SetNull
        }
        for (const c of consents) if (c.projectId === 'proj-1') c.projectId = null;
        return { id: 'proj-1' };
      },
    },
  };
  const externalArtifacts = { discardForProject: async () => ({}) };
  return { svc: new ProjectsService(prisma, externalArtifacts as any), facts, consents };
}

async function run() {
  const results: { name: string; error?: string }[] = [];
  const scenarios: [string, () => Promise<void>][] = [];
  const test = (name: string, fn: () => Promise<void>) => scenarios.push([name, fn]);

  test('ИЗМЕРЕНИЕ прежнего поведения: факт со scope=PROJECT переживал удаление и становился невидимым', async () => {
    const f = projectsFake(false); // как было: SetNull
    await f.svc.remove('u-1', 'proj-1');
    const orphan = f.facts.find((x) => x.id === 'f-1');
    assertEqual(Boolean(orphan), true, 'факт остался в базе');
    assertEqual(orphan.projectId, null, 'и в состоянии, которое сервис создавать запрещает');
    // Именно так его ищут все чтения — и не находят.
    const visible = f.facts.filter((x) => x.scope === 'PROJECT' && x.projectId === 'proj-1');
    assertEqual(visible.length, 0, 'ни одно чтение такой факт больше не найдёт');
  });

  test('КЛЮЧЕВОЙ ТЕСТ: факты, собранные в проекте, уходят вместе с проектом', async () => {
    const f = projectsFake(true); // как стало: Cascade
    await f.svc.remove('u-1', 'proj-1');
    assertEqual(
      f.facts.some((x) => x.id === 'f-1'),
      false,
      'сведения о человеке, собранные в этом проекте, удалены',
    );
  });

  test('КЛЮЧЕВОЙ ТЕСТ: перенесённые записи о человеке НЕ удаляются вместе с проектом', async () => {
    // Их человек переносил из проекта осознанно (PERSON_GLOBAL), они
    // принадлежат карточке человека. Каскад их не касается ровно потому,
    // что projectId у них null по определению — это и делает Cascade
    // точным инструментом здесь, а не грубым.
    const f = projectsFake(true);
    await f.svc.remove('u-1', 'proj-1');
    assertEqual(
      f.facts.some((x) => x.id === 'f-2'),
      true,
      'общая запись о человеке осталась',
    );
  });

  test('КЛЮЧЕВОЙ ТЕСТ: удаление проекта говорит, что именно пережило удаление', async () => {
    const f = projectsFake(true);
    const result = await f.svc.remove('u-1', 'proj-1');
    assertEqual(result.deleted, true, 'проект удалён');
    assertEqual(result.notRemovedHere.length >= 4, true, 'список того, что осталось, не пустой');
    const joined = result.notRemovedHere.join(' ');
    assertEqual(/соглас/i.test(joined), true, 'названы записи о согласиях');
    assertEqual(/PERSON_GLOBAL|общая запись/i.test(joined), true, 'названы перенесённые записи о людях');
    assertEqual(/библиотек/i.test(joined), true, 'названы записи библиотеки');
  });

  test('записи о согласиях переживают удаление проекта — и это сказано, а не умолчано', async () => {
    const f = projectsFake(true);
    const result = await f.svc.remove('u-1', 'proj-1');
    assertEqual(f.consents.length, 1, 'запись о согласии осталась');
    assertEqual(f.consents[0].projectId, null, 'но уже без привязки к удалённому проекту');
    assertEqual(
      result.notRemovedHere.some((line) => /соглас/i.test(line)),
      true,
      'и человеку об этом сказано в ответе на удаление',
    );
  });

  test('КЛЮЧЕВОЙ ТЕСТ: правило записано в СХЕМЕ, а не только в фейке этого теста', async () => {
    // Тесты выше живут на фейке, который повторяет каскад по описанию.
    // Если бы схема осталась с SetNull, они всё равно были бы зелёными —
    // ровно та подмена, которую нашла мутационная сверка. Поэтому здесь
    // проверяется сам файл схемы: удаление проекта уносит факты, потому
    // что так объявлено в базе, а не потому, что так написан фейк.
    const { readFileSync } = await import('fs');
    const { join } = await import('path');
    const schema = readFileSync(join(__dirname, '..', '..', 'prisma', 'schema.prisma'), 'utf8');
    const model = /^model PersonFact \{([\s\S]*?)^\}/m.exec(schema)?.[1] ?? '';
    const line = model.split('\n').find((l) => l.includes('project ') && l.includes('@relation')) ?? '';
    assertEqual(line.includes('onDelete: Cascade'), true, `связь PersonFact→Project: ${line.trim()}`);
  });

  test('чужой проект удалить нельзя', async () => {
    const f = projectsFake(true);
    let threw = false;
    await f.svc.remove('посторонний', 'proj-1').catch(() => {
      threw = true;
    });
    assertEqual(threw, true, 'отказ');
    assertEqual(f.facts.length, 2, 'ничего не удалено');
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
  console.log(`\nУдаление проекта: ${results.length - failed.length}/${results.length} passed\n`);
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
