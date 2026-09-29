// Сверка 2026-09-06 — правило отзыва согласия разъехалось в том же
// файле, где объявлено как одно.
//
// КОНТЕКСТ. `interview-pool/consent-revocation.ts` заведён прошлой
// сверкой ровно с целью, записанной в его заголовке: «отзыв согласия
// кандидата как ОДНО правило, а не как отдельная проверка в каждом
// месте». Там же названа и граница правила, прямым текстом: «отзыв
// исключает кандидата из всего, что ПОКИДАЕТ проект или
// ПЕРЕСОБИРАЕТСЯ, но НЕ прячет его из внутренних списков рекрутера:
// исчезнувший без следа человек выглядит как сбой продукта, а не как
// исполненная воля кандидата. В списке он остаётся с отметкой».
//
// НАЙДЕННОЕ, ТРИ ВЕЩИ.
//
// 1. `assertConsentActive()` — функция «403 по конкретному кандидату» —
//    НЕ ВЫЗЫВАЛАСЬ НИ ОТКУДА. Оба адресных места (добавление кандидата
//    в пул и добавление существующего кандидата в проект) читали флаг
//    сами.
//
// 2. И один из них сообщал человеку СВОЙ текст: «Согласие кандидата
//    отозвано» — без главного, что есть в общем сообщении: что отчёты
//    и разборы по кандидату не формируются и что СНЯТЬ ОТЗЫВ МОЖЕТ
//    ТОЛЬКО САМ КАНДИДАТ. Рекрутер, прочитавший короткую версию, идёт
//    просить коллегу добавить кандидата соседней кнопкой — то есть
//    текст не просто беднее, он ведёт не туда.
//
// 3. Матрица покрытия кандидатов НАРУШАЛА границу, записанную в том же
//    файле: строка кандидата с отозванным согласием просто
//    пропускалась (`continue`) — ни строки, ни счётчика. Человек
//    исчезал из таблицы бесследно, ровно как файл запрещает, и матрица
//    выглядела полной при том, что часть пула из неё выпала.
//
// ФОРМА: ОДНО ПРАВИЛО В НЕСКОЛЬКИХ ЭКЗЕМПЛЯРАХ, РАСХОДЯЩИХСЯ В
// ФОРМУЛИРОВКЕ И В ПОВЕДЕНИИ — тот же класс, что [one-quote-rule],
// только здесь экземпляры разъехались внутри домена, у которого общий
// файл правила уже был.

import { readdirSync, readFileSync, statSync } from 'fs';
import { join } from 'path';
import {
  CONSENT_REVOKED_MESSAGE,
  CONSENT_REVOKED_ROW_NOTE,
  assertConsentActive,
  consentRevoked,
} from '../interview-pool/consent-revocation';
import { ForbiddenException } from '@nestjs/common';

const API_SRC = join(__dirname, '..');

function tsFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) return name === '__tests__' || name === 'node_modules' ? [] : tsFiles(full);
    return name.endsWith('.ts') ? [full] : [];
  });
}

describe('Сверка [revocation-not-one-rule]: отзыв согласия — одно правило', () => {
  describe('правило на своих данных', () => {
    it('КЛЮЧЕВОЙ ТЕСТ: адресная проверка бросает 403 с ОБЩИМ сообщением, а не своим', async () => {
      const prisma = {
        candidateProfile: { findUnique: async () => ({ consentRevokedAt: new Date('2026-09-01') }) },
      } as never;
      await expect(assertConsentActive(prisma, 'cp-1')).rejects.toBeInstanceOf(ForbiddenException);
      await expect(assertConsentActive(prisma, 'cp-1')).rejects.toThrow(CONSENT_REVOKED_MESSAGE);
    });

    it('активное согласие проходит; отсутствующий профиль не трактуется как отзыв', async () => {
      const active = { candidateProfile: { findUnique: async () => ({ consentRevokedAt: null }) } } as never;
      const missing = { candidateProfile: { findUnique: async () => null } } as never;
      await expect(assertConsentActive(active, 'cp-1')).resolves.toBeUndefined();
      await expect(assertConsentActive(missing, 'cp-1')).resolves.toBeUndefined();
    });

    it('общее сообщение говорит и о последствиях, и о том, кто может снять отзыв', () => {
      expect(CONSENT_REVOKED_MESSAGE).toContain('не формируются отчёты');
      expect(CONSENT_REVOKED_MESSAGE).toContain('снимает только сам кандидат');
    });

    it('отметка для списка объясняет, почему строка пустая, и почему она вообще осталась', () => {
      expect(CONSENT_REVOKED_ROW_NOTE).toContain('не пересобирается');
      expect(CONSENT_REVOKED_ROW_NOTE).toContain('исчезнувший без следа');
    });

    it('признак отзыва читается через общую функцию и на неполных данных не падает', () => {
      expect(consentRevoked({ candidateProfile: { consentRevokedAt: new Date() } })).toBe(true);
      expect(consentRevoked({ candidateProfile: { consentRevokedAt: null } })).toBe(false);
      expect(consentRevoked({ candidateProfile: null })).toBe(false);
      expect(consentRevoked({})).toBe(false);
    });
  });

  describe('второго экземпляра правила не будет', () => {
    it('КЛЮЧЕВОЙ ТЕСТ: флаг отзыва читают только само правило и сам отзыв', () => {
      // Обход дерева. Читать `consentRevokedAt` вправе: файл правила и
      // два метода, которыми человек отзыв и СОВЕРШАЕТ (им нужно
      // отличить «уже отозвано» и вернуть дату). Всем остальным — через
      // правило, иначе снова разъедется текст или поведение.
      const allowed = [
        'interview-pool/consent-revocation.ts',
        'interview-pool/interview-pool-candidate.service.ts', // отзыв кандидатом
        'hiring-extras/hiring-extras.service.ts', // отзыв рекрутером от лица кандидата
        'candidate-self-share/candidate-self-share.service.ts', // отзыв соискателем
      ];
      const offenders: string[] = [];
      for (const f of tsFiles(API_SRC)) {
        const rel = f.slice(API_SRC.length + 1).split('\\').join('/');
        if (allowed.includes(rel)) continue;
        const code = readFileSync(f, 'utf8').replace(/\/\/[^\n]*/g, '');
        // Чтение флага как условия — не `select:`/`data:`/`where:`.
        if (/(?:\?\.|\.)consentRevokedAt\s*(?:\)|\?|&&|\|\||;|$)/m.test(code)) offenders.push(rel);
      }
      expect(offenders).toEqual([]);
    });

    /** «Адресное место отвечает ОБЩИМ текстом» проверяется ПОВЕДЕНИЕМ,
     * в hiring-extras.service.spec.ts: добавление кандидата с отозванным
     * согласием падает именно с общим сообщением. Текстовые двойники
     * убраны — дублировать поведенческий тест текстом ровно то, против
     * чего стоит проверка проверок. Остаётся одно текстовое правило: свой
     * короткий текст не должен вернуться в код. */
    it('свой короткий текст отказа не вернулся в код', () => {
      const extras = readFileSync(join(API_SRC, 'hiring-extras', 'hiring-extras.service.ts'), 'utf8');
      expect(extras).not.toContain("ForbiddenException('Согласие кандидата отозвано')");
    });

    it('проба: новый файл, читающий флаг сам, правилом ловится', () => {
      const offender = 'if (profile.consentRevokedAt) throw new Error("нет");';
      expect(/(?:\?\.|\.)consentRevokedAt\s*(?:\)|\?|&&|\|\||;|$)/m.test(offender)).toBe(true);
    });
  });
});
