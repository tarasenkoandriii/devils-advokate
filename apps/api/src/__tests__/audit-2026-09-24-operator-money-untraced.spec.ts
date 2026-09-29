// Сверка 2026-09-24 — след операторского решения там, где спорят о
// деньгах.
//
// КАК СВЕРКА ВЫРОСЛА ИЗ ПРЕДЫДУЩЕЙ. [copy-outlived-consent] сравнивал
// три дороги одного действия. Здесь сравниваются пять действий по
// ОДНОМУ объекту — заявке заведения, — и вопрос тот же: делают ли они
// то, что вместе обещают.
//
// ИЗМЕРЕНИЕ. Журнал покрывал операторскую поверхность неровно:
// admin-users 2 из 2, admin-domains 1 из 1, prompt-registry 2 из 5,
// library 1 из 2, venue-application 2 из 5, evaluation 0 из 3,
// calibration 0 из 1, admin-sandbox 0 из 79.
//
// НАЙДЕННОЕ. Из пяти решений оператора по заведению аудировались допуск
// и отказ, а не аудировались ровно два: СУММА реферальной платы и
// ПОДЪЁМ НАД ОРГАНИЧЕСКОЙ ВЫДАЧЕЙ. Те самые, что про деньги с внешней
// стороной и про то, что человек увидит первым.
//
// Второе стои́т назвать отдельно. Флаг приоритетного партнёра поднимает
// заведение над обычной выдачей, и экран рисует такие карточки
// отдельным списком с пометкой «Реклама». Пометка честна ПЕРЕД
// ЧИТАТЕЛЕМ — но она не отвечает на вопрос «кто и когда так решил», а
// платное продвижение ровно этот вопрос и порождает.
//
// ЧЕГО НЕ НАЙДЕНО, и это половина результата. Остальные нули не того же
// рода: песочница действует НАД СОБСТВЕННЫМИ данными оператора (её
// первый принцип — никакой имперсонации, проверено: все 79 методов
// берут userId из админ-сессии и требуют роль); черновики промптов и
// наборов оценки ничего не меняют для людей, пока их не повысят — а
// повышение уже пишется; пересчёт калибровки запускается расписанием и
// воспроизводим из данных, запись сказала бы «оператор решил», чего не
// было. Записать их как находки значило бы преувеличить, то есть
// соврать в другую сторону.
//
// ЧТО ОТСЮДА СНЯТО И ПОЧЕМУ. Первая редакция проверяла ещё и то, что
// имена двух новых действий ВСТРЕЧАЮТСЯ В ИСХОДНИКЕ сервиса. Это чтение
// текста там, где рядом стои́т поведение: спек сервиса прогоняет
// настоящий метод и смотрит на записанное действие. Сторож проверок
// сработал на превышении — и первым делом снялось именно это, а не
// потолок. Утверждения о СОДЕРЖИМОМ РЕЕСТРА переехали в отдельный файл
// без чтения исходников: та же мера, что в [scope-not-applied].
//
// ПОВЕДЕНИЕ, НЕ ТЕКСТ. Обе новые записи проверены на настоящем сервисе
// в venue-application.service.spec.ts: журнал вызван ровно один раз,
// назван тот, кто решил, и названы СТАРОЕ и НОВОЕ значения — «поставили
// 7.5» и «подняли с 3 до 7.5» разные сведения, и спор бывает о втором.
// Здесь — то, что иначе не выразить.

import { readFileSync, readdirSync, statSync } from 'fs';
import { join } from 'path';
import { UNAUDITED_OPERATOR_ACTIONS } from '../audit-log/operator-actions';

const SRC = join(__dirname, '..');

function code(path: string): string {
  return readFileSync(path, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
}

function serviceFiles(): Array<{ service: string; path: string }> {
  const out: Array<{ service: string; path: string }> = [];
  for (const dir of readdirSync(SRC)) {
    const full = join(SRC, dir);
    if (!statSync(full).isDirectory() || dir === '__tests__') continue;
    for (const name of readdirSync(full)) {
      if (name.endsWith('.service.ts')) out.push({ service: dir, path: join(full, name) });
    }
  }
  return out;
}

/** Операторская мутация: метод сервиса, который требует роль (оператора
 * или модератора) И пишет в базу. Признак по ФОРМЕ, а не по имени
 * каталога: новая операторская поверхность заведётся не там, где ждут. */
function operatorMutations(): Array<{ service: string; method: string; audits: boolean }> {
  const out: Array<{ service: string; method: string; audits: boolean }> = [];
  for (const { service, path } of serviceFiles()) {
    const src = code(path);
    for (const m of src.matchAll(/\n {2}(?:private )?async (\w+)\(([^)]*)\)[^{]*\{/g)) {
      const start = m.index! + m[0].length;
      let depth = 1;
      let i = start;
      while (i < src.length && depth) {
        if (src[i] === '{') depth++;
        else if (src[i] === '}') depth--;
        i++;
      }
      const body = src.slice(start, i - 1);
      const gated = /assertOperator\(|assertModerator\(/.test(body);
      const writes = /prisma\.\w+\.(create|update|updateMany|delete|deleteMany|upsert)\(/.test(body);
      if (!gated || !writes) continue;
      out.push({ service, method: m[1], audits: /auditLog\.record\(|audit\.record\(/.test(body) });
    }
  }
  return out;
}

describe('Сверка [operator-money-untraced]: решение оператора оставляет след или объяснено', () => {
  it('КЛЮЧЕВОЙ ТЕСТ: каждая операторская мутация либо пишет в журнал, либо названа в реестре', () => {
    const excused = new Set(UNAUDITED_OPERATOR_ACTIONS.map((a) => `${a.service}.${a.method}`));
    const excusedServices = new Set(
      UNAUDITED_OPERATOR_ACTIONS.filter((a) => a.method === '*').map((a) => a.service),
    );
    const mutations = operatorMutations();
    // Разбор жив: операторские мутации вообще находятся.
    expect(mutations.length).toBeGreaterThan(5);

    const silent = mutations
      .filter((m) => !m.audits)
      .filter((m) => !excused.has(`${m.service}.${m.method}`) && !excusedServices.has(m.service))
      .map((m) => `${m.service}.${m.method}`);
    expect([...new Set(silent)].sort()).toEqual([]);
  });

  it('КЛЮЧЕВОЙ ТЕСТ: правило срабатывает на новой молчащей мутации', () => {
    // Обратная проба. За эту сессию шесть раз выяснялось, что правило
    // сторожит ровно то, что уже исправлено.
    const probe = `
  async setSomething(userId: string, id: string) {
    await this.assertModerator(userId);
    return this.prisma.approvedVenue.update({ where: { id }, data: { x: 1 } });
  }`;
    const gated = /assertOperator\(|assertModerator\(/.test(probe);
    const writes = /prisma\.\w+\.(create|update|updateMany|delete|deleteMany|upsert)\(/.test(probe);
    const audits = /auditLog\.record\(|audit\.record\(/.test(probe);
    expect([gated, writes, audits]).toEqual([true, true, false]);
  });

  it('в реестре нет действий, которых больше нет', () => {
    const known = new Set(operatorMutations().map((m) => `${m.service}.${m.method}`));
    const vanished = UNAUDITED_OPERATOR_ACTIONS.filter((a) => a.method !== '*')
      .map((a) => `${a.service}.${a.method}`)
      .filter((k) => !known.has(k));
    expect(vanished).toEqual([]);
  });
});
