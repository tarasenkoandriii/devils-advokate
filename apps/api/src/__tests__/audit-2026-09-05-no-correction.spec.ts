// Сверка 2026-09-05 — запись о человеке нельзя было ни подтвердить, ни
// оспорить, ни удалить.
//
// НАЙДЕННОЕ ИЗМЕРЕНИЕМ. У `PersonFact` было ровно два действия: создать
// и прочитать. И при этом:
//
//  1. `FactStatus` в схеме знает DISPUTED и EXPIRED, и ТРИ сервиса на них
//     ветвятся: `EvidenceGapService` объявляет факт «противоречивым»,
//     `SourceConflictService` и `StaleFactService` исключают истёкшие.
//     Выставить эти состояния не мог НИКТО — поиск по всей кодовой базе
//     не находит ни одной записи в это поле. Ветки существовали и не
//     могли сработать никогда: механизм есть, доступа к нему нет — та же
//     форма, что в пункте [candidate-rights], где отзыв согласия был
//     построен и не выдан.
//  2. `lastVerifiedAt` не записывался нигде. Значит «давно не
//     подтверждался» считалось от даты создания и НАВСЕГДА: продукт звал
//     перепроверить факт и не давал сказать, что перепроверил.
//     Предупреждение, которое нельзя снять, перестают читать — а вместе
//     с ним перестают читать и те, которые снять стоило бы.
//
// ЧЕГО ЭТО НЕ ДЕЛАЕТ, и это сказано человеку прямо на экране: удаление
// факта не убирает выводы, уже построенные с его участием. Черты профиля
// и прецеденты ссылаются на источник ТЕКСТОМ (архитектурное решение
// §3.11, не недосмотр) — связать их с конкретной записью нечем.

import { readFileSync, readdirSync } from 'fs';
import { join } from 'path';
import { BadRequestException, NotFoundException } from '@nestjs/common';
import { FactStatus } from '@prisma/client';
import { PersonFactsService } from '../person-facts/person-facts.service';

const API_SRC = join(__dirname, '..');

function code(rel: string): string {
  return readFileSync(join(API_SRC, rel), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/.*$/gm, '$1');
}

function servicesReadingFactStatus(): string[] {
  const found: string[] = [];
  (function walk(dir: string, rel: string) {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.name === '__tests__' || entry.name === 'node_modules') continue;
      const full = join(dir, entry.name);
      const r = rel ? `${rel}/${entry.name}` : entry.name;
      if (entry.isDirectory()) walk(full, r);
      else if (entry.name.endsWith('.service.ts') && /FactStatus\.(DISPUTED|EXPIRED)/.test(code(r))) found.push(r);
    }
  })(API_SRC, '');
  return found;
}

function fakePrisma() {
  const facts: any[] = [];
  const people = new Map<string, any>();
  return {
    _seedPerson(p: any) { people.set(p.id, p); },
    _seedFact(f: any) {
      facts.push({ id: `f-${facts.length + 1}`, status: 'ACTIVE', lastVerifiedAt: null, sourceType: 'PERSONAL_RECORD', ...f });
    },
    _facts() { return facts; },
    person: {
      findFirst: async ({ where }: any) => {
        const p = people.get(where.id);
        return p && p.createdByUserId === where.createdByUserId ? p : null;
      },
    },
    personFact: {
      findFirst: async ({ where }: any) => facts.find((f) => f.id === where.id && f.personId === where.personId) ?? null,
      update: async ({ where, data }: any) => Object.assign(facts.find((f) => f.id === where.id), data),
      delete: async ({ where }: any) => {
        const i = facts.findIndex((f) => f.id === where.id);
        return facts.splice(i, 1)[0];
      },
    },
  };
}

function setup() {
  const prisma = fakePrisma();
  prisma._seedPerson({ id: 'p1', createdByUserId: 'me' });
  prisma._seedFact({ personId: 'p1', content: 'уезжает в мае' });
  return { prisma, service: new PersonFactsService(prisma as any) };
}

describe('Запись о человеке: подтвердить, оспорить, удалить', () => {
  it('КЛЮЧЕВОЙ ТЕСТ: состояния, на которые ветвятся сервисы, теперь достижимы', async () => {
    // Три сервиса читали DISPUTED/EXPIRED, и выставить их не мог никто.
    expect(servicesReadingFactStatus().length).toBeGreaterThanOrEqual(3);

    const s = setup();
    const disputed = await s.service.setStatus('me', 'p1', 'f-1', FactStatus.DISPUTED);
    expect(disputed.status).toBe('DISPUTED');
    const expired = await s.service.setStatus('me', 'p1', 'f-1', FactStatus.EXPIRED);
    expect(expired.status).toBe('EXPIRED');
  });

  it('КЛЮЧЕВОЙ ТЕСТ: подтверждение проставляет дату проверки — предупреждение можно снять', async () => {
    // Без этого «давно не подтверждался» считалось от даты создания и
    // навсегда: продукт звал перепроверить и не давал сказать, что
    // перепроверил.
    const s = setup();
    expect(s.prisma._facts()[0].lastVerifiedAt).toBeNull();
    const confirmed = await s.service.confirm('me', 'p1', 'f-1');
    expect(confirmed.lastVerifiedAt).toBeInstanceOf(Date);
  });

  it('КЛЮЧЕВОЙ ТЕСТ: подтверждение возвращает оспоренный факт в силу', async () => {
    // Обратная половина: человек оспорил, потом проверил и убедился, что
    // всё-таки так. Односторонняя дверь здесь была бы своей ловушкой.
    const s = setup();
    await s.service.setStatus('me', 'p1', 'f-1', FactStatus.DISPUTED);
    const confirmed = await s.service.confirm('me', 'p1', 'f-1');
    expect(confirmed.status).toBe('ACTIVE');
  });

  it('КЛЮЧЕВОЙ ТЕСТ: удаление действительно удаляет', async () => {
    const s = setup();
    await s.service.remove('me', 'p1', 'f-1');
    expect(s.prisma._facts()).toHaveLength(0);
  });

  it('КЛЮЧЕВОЙ ТЕСТ: чужую запись не тронуть — ни одним из четырёх действий', async () => {
    const s = setup();
    await expect(s.service.confirm('someone-else', 'p1', 'f-1')).rejects.toBeInstanceOf(NotFoundException);
    await expect(s.service.setStatus('someone-else', 'p1', 'f-1', FactStatus.DISPUTED)).rejects.toBeInstanceOf(NotFoundException);
    await expect(s.service.remove('someone-else', 'p1', 'f-1')).rejects.toBeInstanceOf(NotFoundException);
    // И чужой факт под своим человеком — тоже нет.
    await expect(s.service.remove('me', 'p1', 'f-999')).rejects.toBeInstanceOf(NotFoundException);
    expect(s.prisma._facts()).toHaveLength(1);
  });

  it('КЛЮЧЕВОЙ ТЕСТ: «вернуть в силу» не делается сменой статуса вслепую', () => {
    // ACTIVE через общий эндпоинт статуса означал бы возврат факта в силу
    // БЕЗ даты проверки — то есть снова факт, который никто не
    // подтверждал. Контроллер отвергает такое и называет верный путь.
    const src = code('person-facts/person-facts.controller.ts');
    expect(src).toMatch(/FactStatus\.DISPUTED && dto\.status !== FactStatus\.EXPIRED/);
    expect(src).toMatch(/подтвердите его/);
    expect(BadRequestException).toBeDefined();
  });

  it('измерение: все четыре действия доступны снаружи', () => {
    const src = code('person-facts/person-facts.controller.ts');
    for (const route of ['@Post()', "@Get()", "@Patch(':factId/confirm')", "@Patch(':factId/status')", "@Delete(':factId')"]) {
      expect({ route, present: src.includes(route) }).toEqual({ route, present: true });
    }
  });
});
