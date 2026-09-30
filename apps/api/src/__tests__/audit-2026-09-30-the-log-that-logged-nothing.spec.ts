// Сверка 2026-09-30 — журнал, в который ничего не писалось.
//
// НАЙДЕНО. Экран доказательств ДТП обещал человеку буквально: «Файл
// получает хеш и время фиксации при загрузке, КАЖДЫЙ ПРОСМОТР ПИШЕТСЯ
// В ЖУРНАЛ — это и есть „доказательная фиксация“». Журнал был ВСЕГДА
// ПУСТ.
//
// Единственной записью в него был побочный эффект `GET
// /dtp/evidence/:id` — маршрута, который не вызывал НИ ОДИН клиент: ни
// TMA, ни админка. Экран рисуется из списка (`listEvidence`, в журнал
// не пишет), а файл открывался ПРЯМОЙ ссылкой на Blob, минуя сервер
// вообще. Значение `DOWNLOADED` перечисления доступа не записывалось
// нигде во всём проекте — мёртвое значение в схеме.
//
// То есть человек открывал свои доказательства сколько угодно раз,
// жал «Журнал доступа» и читал «Доступов не было». Запись в журнале
// появлялась только у ОПЕРАТОРА в песочнице.
//
// Это единственная находка захода, где неверное утверждение читает
// конечный человек, и оно про ДОКАЗУЕМОСТЬ: по этому журналу он
// собирался показывать страховой, что снимок не подменён.
//
// ЧТО СДЕЛАНО. Открытие файла стало ДЕЙСТВИЕМ на сервере
// (`POST /dtp/evidence/:id/opened`, действие `DOWNLOADED`), экран его
// вызывает перед открытием, а текст обещания переписан на то, что
// действительно происходит — и называет то, что НЕ происходит:
// переданную кому-то ссылку продукт не отслеживает.

import { readFileSync } from 'fs';
import { join } from 'path';

const REPO = join(__dirname, '..', '..', '..', '..');
const API_SRC = join(__dirname, '..');

function code(rel: string, root = API_SRC): string {
  return readFileSync(join(root, rel), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/.*$/gm, '$1');
}

function tma(rel: string): string {
  return readFileSync(join(REPO, 'apps', 'tma', 'src', rel), 'utf8')
    .replace(/\{\/\*[\s\S]*?\*\/\}/g, '')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/.*$/gm, '$1');
}

describe('[the-log-that-logged-nothing] журнал доступа к доказательствам', () => {
  it('КЛЮЧЕВОЙ ТЕСТ: экран больше не обещает того, чего продукт не делает', () => {
    const screen = tma(join('components', 'domains', 'dtp', 'DtpWorkspace.tsx'));
    expect(screen.includes('каждый просмотр пишется в журнал')).toBe(false);
    // И обещает то, что делает: открытие ОТСЮДА.
    expect(screen.includes('Каждое открытие файла отсюда пишется в журнал доступа')).toBe(true);
    // И называет границу: переданную ссылку продукт не видит. Без
    // этого «каждое открытие» читалось бы как «любое открытие кем
    // угодно», то есть та же неправда в другой формулировке.
    expect(screen.includes('его открытия продукт не увидит')).toBe(true);
  });

  it('КЛЮЧЕВОЙ ТЕСТ: открытие файла идёт через сервер, а не прямой ссылкой мимо него', () => {
    const screen = tma(join('components', 'domains', 'dtp', 'DtpWorkspace.tsx'));
    // Прежде здесь стоял `<a href={e.blobUrl}>` — браузер уходил в
    // Blob, сервер об этом не знал, и журнал оставался пуст.
    expect(/<a[^>]*href=\{e\.blobUrl\}/.test(screen)).toBe(false);
    expect(screen.includes('/opened`')).toBe(true);
    // И сбой записи назван человеку: журнал — это то, чем он
    // собирается доказывать, и «открыл, но не записалось» он обязан
    // отличать от «открыл и записалось».
    expect(screen.includes('в журнал доступа записать не удалось')).toBe(true);
  });

  it('КЛЮЧЕВОЙ ТЕСТ: маршрут отметки существует, проверяет владение и пишет именно открытие', () => {
    const ctrl = code('dtp/dtp.controller.ts');
    expect(ctrl.includes("@Post('evidence/:id/opened')")).toBe(true);
    // Владение — не формальность: без него в чужой журнал можно было
    // бы писать по чужому id.
    const block = ctrl.slice(ctrl.indexOf("@Post('evidence/:id/opened')"));
    const body = block.slice(0, block.indexOf('\n  }'));
    expect(body.includes('this.dtp.getEvidence(userId, evidenceId)')).toBe(true);
    expect(body.includes("'DOWNLOADED'")).toBe(true);
  });

  it('КЛЮЧЕВОЙ ТЕСТ: значение DOWNLOADED больше не мёртвое', () => {
    // Правило по дереву: значение перечисления, которое не пишет
    // никто, — это обещание схемы без исполнения. Считаем места
    // записи в продовом коде.
    const ctrl = code('dtp/dtp.controller.ts');
    const sandbox = code('admin-sandbox/admin-sandbox.service.ts');
    const written = (ctrl.match(/'DOWNLOADED'/g) ?? []).length + (sandbox.match(/'DOWNLOADED'/g) ?? []).length;
    expect(written).toBeGreaterThan(0);
  });
});
