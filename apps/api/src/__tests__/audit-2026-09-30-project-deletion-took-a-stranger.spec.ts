// Пункт [project-deletion-took-a-stranger] 2026-09-30 — удаление проекта
// уносит чужое.
//
// ЧТО ПРОВЕРЯЕТСЯ. Три вещи, и третья важнее первых двух.
//
//   1. Числа считаются по проекту, а не по владельцу, и только
//      ненулевые доезжают до человека.
//   2. Они уходят и в предпросмотр (ДО решения), и в отчёт (ПОСЛЕ),
//      причём подсчёт идёт ДО каскада.
//   3. ЗАМКНУТОСТЬ: разбор схемы находит каждую каскадную модель, у
//      которой есть поле с чужим идентификатором, и каждая обязана быть
//      КЛАССИФИЦИРОВАНА в реестре. Новая такая модель уронит сверку —
//      иначе следующая цепочка, уносящая чужое, приедет молча, ровно
//      как приехали эти.

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { ProjectsService } from '../projects/projects.service';
import {
  CASCADE_CLASSIFIED,
  PROJECT_LOSSES_NOTE,
  PROJECT_NOT_REMOVED_HERE,
  PROJECT_TAKES_FROM_OTHERS,
  projectTakesFromOthers,
} from '../projects/project-deletion-impact';

const SCHEMA = readFileSync(join(__dirname, '..', '..', 'prisma', 'schema.prisma'), 'utf8');

/** Модели, уходящие каскадом вместе с проектом. */
function cascadesWithProject(schema: string): string[] {
  const out: string[] = [];
  for (const m of schema.matchAll(/^model\s+(\w+)\s*\{([\s\S]*?)^\}/gm)) {
    for (const line of m[2].split('\n')) {
      const t = line.trim();
      if (!/@relation\(/.test(t) || !/\bProject\b/.test(t)) continue;
      if (/Project\?/.test(t)) continue; // необязательная связь каскадом не уносит
      if (/onDelete:\s*(\w+)/.exec(t)?.[1] !== 'Cascade') continue;
      out.push(m[1]);
    }
  }
  return [...new Set(out)];
}

/** Поля, называющие ДРУГОГО человека или ДРУГОЙ проект.
 *
 * Правило ОБЩЕЕ, а не список имён: список пришлось бы дописывать под
 * каждую новую модель, то есть он молчал бы ровно там, где нужен.
 * `projectId`/`userId` исключены — это своя цепочка и свой владелец. */
function foreignFields(schema: string, model: string): string[] {
  const m = new RegExp(`^model ${model}\\s*\\{([\\s\\S]*?)^\\}`, 'm').exec(schema);
  if (!m) return [];
  const found = [...m[1].matchAll(/^\s*(\w*[Bb]yUserId|\w+UserId|\w+ProjectId|participantId)\s+\w/gm)].map(
    (x) => x[1],
  );
  return [...new Set(found)].filter((f) => f !== 'projectId' && f !== 'userId');
}

function fake(counts: Record<string, number>) {
  const seen: Array<{ model: string; where: unknown }> = [];
  const counter = (model: string) => ({
    count: async ({ where }: { where: unknown }) => {
      seen.push({ model, where });
      return counts[model] ?? 0;
    },
  });
  return {
    prisma: {
      publicComment: counter('publicComment'),
      publicArgumentSubmission: counter('publicArgumentSubmission'),
      publicParticipant: counter('publicParticipant'),
      clientReport: counter('clientReport'),
      employerAgencyEngagement: counter('employerAgencyEngagement'),
    } as never,
    seen,
  };
}

describe('[project-deletion-took-a-stranger] удаление проекта уносит чужое', () => {
  describe('замкнутость реестра', () => {
    it('проба механизма: разбор схемы находит каскадные модели, а не молчит', () => {
      const cascading = cascadesWithProject(SCHEMA);
      expect(cascading.length).toBe(50);
      expect(cascading.includes('PublicComment')).toBe(true);
      // И не берёт то, что каскадом не уходит.
      expect(cascading.includes('ConsentRecord')).toBe(false);
      expect(cascading.includes('LibraryEntry')).toBe(false);
    });

    it('КЛЮЧЕВОЙ ТЕСТ: каждая каскадная модель с чужим полем классифицирована', () => {
      const flagged = cascadesWithProject(SCHEMA)
        .map((model) => ({ model, fields: foreignFields(SCHEMA, model) }))
        .filter((x) => x.fields.length > 0);
      const asText = (xs: ReadonlyArray<{ model: string; fields: readonly string[] }>) =>
        xs.map((x) => `${x.model}: ${[...x.fields].sort().join(' ')}`).sort();
      expect(asText(flagged)).toEqual(asText(CASCADE_CLASSIFIED));
    });

    it('у каждой записи классификации есть причина', () => {
      expect(CASCADE_CLASSIFIED.filter((c) => c.why.trim().length === 0).map((c) => c.model)).toEqual([]);
      // Оба вердикта и правда встречаются: реестр, в котором всё «своё»,
      // ничего не утверждал бы.
      expect(CASCADE_CLASSIFIED.some((c) => c.verdict === 'чужое')).toBe(true);
      expect(CASCADE_CLASSIFIED.some((c) => c.verdict === 'своё')).toBe(true);
    });

    it('КЛЮЧЕВОЙ ТЕСТ: вердикт «чужое» обязан иметь запись, которая эту потерю СЧИТАЕТ', () => {
      // Без этой связи вердикт был бы словом без последствий: мутация
      // «объявить чужое своим» проходила насквозь.
      const keys = new Set(PROJECT_TAKES_FROM_OTHERS.map((l) => l.key));
      const foreignWithoutLoss = CASCADE_CLASSIFIED.filter(
        (c) => c.verdict === 'чужое' && (c.loss === undefined || !keys.has(c.loss)),
      ).map((c) => c.model);
      expect(foreignWithoutLoss).toEqual([]);
      // И наоборот: «своё» не должно ссылаться на потерю — иначе
      // классификация противоречила бы сама себе.
      const ownWithLoss = CASCADE_CLASSIFIED.filter((c) => c.verdict === 'своё' && c.loss !== undefined).map(
        (c) => c.model,
      );
      expect(ownWithLoss).toEqual([]);
      // Проба: «чужих» и правда четыре, а не ноль.
      expect(CASCADE_CLASSIFIED.filter((c) => c.verdict === 'чужое').length).toBe(4);
    });

    it('ЧЕСТНАЯ ГРАНИЦА: участник обсуждения правилом НЕ находится, и он в реестре потерь руками', () => {
      // У приглашённого по ссылке нет аккаунта — и колонки с чужим
      // идентификатором у модели нет. Механическое правило его не видит;
      // если бы реестр выводился из правила, эта потеря пропала бы.
      expect(foreignFields(SCHEMA, 'PublicParticipant')).toEqual([]);
      expect(PROJECT_TAKES_FROM_OTHERS.map((l) => l.key).includes('discussion-participants')).toBe(true);
    });
  });

  describe('что именно заберёт удаление', () => {
    it('КЛЮЧЕВОЙ ТЕСТ: ненулевые потери названы, нулевые не показываются', async () => {
      const { prisma } = fake({ publicComment: 3, employerAgencyEngagement: 1 });
      const losses = await projectTakesFromOthers(prisma, 'p1');
      expect(losses.map((l) => l.key)).toEqual(['discussion-comments', 'agency-engagements']);
      expect(losses[0].text.includes('3')).toBe(true);
      expect(losses[1].text.includes('1')).toBe(true);
    });

    it('обратная проба: когда чужого нет — список пуст, а не заполнен нулями', async () => {
      const { prisma } = fake({});
      expect(await projectTakesFromOthers(prisma, 'p1')).toEqual([]);
    });

    it('КЛЮЧЕВОЙ ТЕСТ: считается по ЭТОМУ проекту, а не по владельцу', async () => {
      const { prisma, seen } = fake({ publicComment: 1, clientReport: 1, employerAgencyEngagement: 1 });
      await projectTakesFromOthers(prisma, 'p-42');
      expect(seen.length).toBe(PROJECT_TAKES_FROM_OTHERS.length);
      const byProject = seen.filter((s) => JSON.stringify(s.where).includes('p-42'));
      expect(byProject.length).toBe(seen.length);
      // И ни один запрос не ищет по владельцу: это был бы подсчёт
      // последствий удаления АККАУНТА, а не этого проекта.
      expect(seen.filter((s) => JSON.stringify(s.where).includes('ownerId'))).toEqual([]);

      // Условия закреплены целиком: без этого сужения «только то, что и
      // правда ушло к другому» можно было снять незаметно — и продукт
      // назвал бы чужой потерей договорённость, которой ни с кем не
      // делились. Поймано мутацией.
      expect(seen.map((s) => `${s.model}: ${JSON.stringify(s.where)}`).sort()).toEqual([
        'clientReport: {"projectId":"p-42","deliveredToProjectId":{"not":null}}',
        'employerAgencyEngagement: {"employerProjectId":"p-42","agencyProjectId":{"not":null}}',
        'publicArgumentSubmission: {"projectId":"p-42"}',
        'publicComment: {"projectId":"p-42"}',
        'publicParticipant: {"projectId":"p-42"}',
      ].sort());
    });

    it('у каждой потери есть причина и текст с числом', () => {
      expect(PROJECT_TAKES_FROM_OTHERS.filter((l) => l.why.trim().length === 0).map((l) => l.key)).toEqual([]);
      const withoutNumber = PROJECT_TAKES_FROM_OTHERS.filter((l) => !l.text(7).includes('7')).map((l) => l.key);
      expect(withoutNumber).toEqual([]);
    });
  });

  describe('доезжает до человека', () => {
    it('КЛЮЧЕВОЙ ТЕСТ: и предпросмотр, и отчёт берут ОДИН список «что переживает удаление»', () => {
      const service = readFileSync(join(__dirname, '..', 'projects', 'projects.service.ts'), 'utf8');
      const uses = service.split('PROJECT_NOT_REMOVED_HERE').length - 1;
      // Один импорт и два использования: предпросмотр и отчёт.
      expect(uses).toBe(3);
      // Литерального списка в сервисе не осталось — иначе копии снова
      // разошлись бы, как уже расходились четырежды.
      expect(service.includes('Записи о выданных и отозванных согласиях')).toBe(false);
    });

    it('КЛЮЧЕВОЙ ТЕСТ: удаление и правда возвращает чужие потери, и считает их ДО каскада', async () => {
      // Сверка по тексту исходника это НЕ держала: мутация «убрать
      // подсчёт» её проходила, потому что имя функции оставалось в
      // объявлении типа возврата. Проверяется вызовом.
      const order: string[] = [];
      const counter = (model: string, n: number) => ({
        count: async () => {
          order.push(`count:${model}`);
          return n;
        },
      });
      const prisma = {
        project: {
          findFirst: async () => ({ id: 'p1', ownerId: 'u1' }),
          delete: async () => {
            order.push('delete');
            return {};
          },
        },
        publicComment: counter('publicComment', 2),
        publicArgumentSubmission: counter('publicArgumentSubmission', 0),
        publicParticipant: counter('publicParticipant', 0),
        clientReport: counter('clientReport', 0),
        employerAgencyEngagement: counter('employerAgencyEngagement', 0),
      };
      const artifacts = { discardForProject: async () => undefined };
      const service = new ProjectsService(prisma as never, artifacts as never);
      const report = (await service.remove('u1', 'p1')) as {
        tookFromOthers: Array<{ key: string; count: number }>;
        tookFromOthersNote: string;
        notRemovedHere: string[];
      };

      expect(report.tookFromOthers.map((l) => `${l.key}=${l.count}`)).toEqual(['discussion-comments=2']);
      expect(report.tookFromOthersNote).toBe(PROJECT_LOSSES_NOTE);
      expect(report.notRemovedHere).toEqual([...PROJECT_NOT_REMOVED_HERE]);

      // Считаем ДО каскада: после него считать нечего.
      expect(order.indexOf('delete') > order.lastIndexOf('count:publicComment')).toBe(true);
    });

    it('маршрут предпросмотра есть и закрыт владением', () => {
      const controller = readFileSync(join(__dirname, '..', 'projects', 'projects.controller.ts'), 'utf8');
      expect(controller.includes("@Get(':id/deletion-preview')")).toBe(true);
      const service = readFileSync(join(__dirname, '..', 'projects', 'projects.service.ts'), 'utf8');
      const preview = service.slice(service.indexOf('async deletionPreview('), service.indexOf('async remove('));
      expect(preview.includes('assertProjectOwnership')).toBe(true);
    });

    it('приписка над списком есть и говорит, что вернуть нельзя', () => {
      expect(PROJECT_LOSSES_NOTE.length > 80).toBe(true);
      expect(PROJECT_LOSSES_NOTE.includes('вернуть их будет нельзя')).toBe(true);
      expect(PROJECT_NOT_REMOVED_HERE.length).toBe(5);
    });
  });
});
