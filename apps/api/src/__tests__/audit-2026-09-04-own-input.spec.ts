// Сверка своего ввода 2026-09-04, серверная половина.
//
// Все прежние заходы про потери закрывали отброшенный ответ МОДЕЛИ. Здесь
// терялись СЛОВА САМОГО ЧЕЛОВЕКА, и в продукте, обещающем «только из
// ваших слов», это дефект другого веса.
//
//  1. Пакет отклика резал список вопросов до восьми — и не в одном месте,
//     а в двух подряд: `.slice(0, 8)` на экране и такой же здесь. Обе
//     обрезки молчали, а число было вписано по месту дважды — то есть
//     два потолка, которые умели разъехаться. Теперь потолок один,
//     назван константой, и сервер сообщает, сколько не поместилось.
//
//  2. При пустом поле подставляются ТРИ вопроса продукта, и ответы на них
//     возвращались без пометки — то есть человек мог отправить
//     работодателю ответы на вопросы, которых не задавал.
//
//  3. `fromEmailAlert` отбрасывал строку, не прошедшую проверку адреса, и
//     не считал её. Отбрасывать обязаны — небезопасный адрес не грузим, —
//     но молчать нельзя: человек вставил десять строк из письма, увидел
//     семь кандидатов и прочитал это как «в письме было семь».
//
//  4. `skippedKnown` считался ВЫЧИТАНИЕМ (`items.length - created.length`)
//     и складывал два разных события: «уже есть в базе» и «упёрлись в
//     потолок 200». Для человека это противоположные вещи: первое значит
//     «ничего не потеряно», второе — «остальное не добавлено, освободите
//     место». Отчёт, называющий одним словом оба, хуже отчёта, который
//     молчит: он выглядит полным. Та же находка, что была в отчёте
//     обновления досье, — здесь она нашлась в приёме вакансий.

import { VacancyIntakeService, MAX_CANDIDATES_PER_CONFIG } from '../vacancy-intake/vacancy-intake.service';
import { MAX_PACKAGE_QUESTIONS, DEFAULT_PACKAGE_QUESTIONS } from '../vacancy-intake/job-search-tools.service';
import { createHiringFakePrisma } from './fake-prisma';

jest.mock('../common/safe-url-fetch', () => {
  const actual = jest.requireActual('../common/safe-url-fetch');
  const page = 'Вакансия: Backend. Оплата 2000 USD.';
  return { ...actual, fetchUrlText: async () => ({ text: page, intake: { used: page.length, total: page.length, limit: 12_000 } }) };
});

function setup() {
  const prisma = createHiringFakePrisma();
  const project = prisma.seed('project', { ownerId: 'u1', mode: 'JOB_SEARCH' });
  const config = prisma.seed('jobSearchConfig', { projectId: project.id });
  const intake = new VacancyIntakeService(prisma as any);
  return { prisma, project, config, intake };
}

describe('Свой ввод: то, что человек написал сам, не теряется молча', () => {
  it('КЛЮЧЕВОЙ ТЕСТ: строки, не прошедшие проверку адреса, посчитаны, а не забыты', async () => {
    const s = setup();
    const res = await s.intake.fromEmailAlert('u1', s.project.id, [
      { url: 'https://djinni.co/jobs/1', title: 'Backend' },
      { url: 'Дизайнер', title: null }, // строка записана наоборот — «ссылкой» стало название
      { url: 'ftp://example.com/x', title: null }, // не http
      { url: 'https://djinni.co/jobs/2', title: null },
    ]);
    expect(res.created).toHaveLength(2);
    expect(res.skippedNotUsable).toBe(2);
  });

  it('КЛЮЧЕВОЙ ТЕСТ: «уже было в базе» и «упёрлись в потолок» — разные числа, а не одно', async () => {
    const s = setup();
    // Заполняем базу почти до потолка и добавляем дубль плюс лишние.
    for (let i = 0; i < MAX_CANDIDATES_PER_CONFIG - 1; i++) {
      s.prisma.seed('vacancyCandidate', { configId: s.config.id, title: `t${i}`, url: `https://x/${i}`, intakeSource: 'EMAIL_ALERT' });
    }
    const res = await s.intake.fromEmailAlert('u1', s.project.id, [
      { url: 'https://x/0', title: null }, // уже есть
      { url: 'https://new/1', title: null }, // поместится: осталось одно место
      { url: 'https://new/2', title: null }, // уже не поместится
      { url: 'https://new/3', title: null }, // и это тоже
    ]);
    expect(res.created).toHaveLength(1);
    expect(res.skippedKnown).toBe(1);
    expect(res.skippedOverCap).toBe(2);
    // Потолок назван числом: человеку сказано, сколько мест всего, иначе
    // «освободите место» — совет без меры.
    expect(res.cap).toBe(MAX_CANDIDATES_PER_CONFIG);
  });

  it('КЛЮЧЕВОЙ ТЕСТ: дубль не выдаётся за переполнение и наоборот', async () => {
    // Обратная половина: когда места полно, «уже было» не превращается в
    // «не поместилось». Проверка, которая смотрит только на сумму, обе
    // мутации пропустила бы.
    const s = setup();
    s.prisma.seed('vacancyCandidate', { configId: s.config.id, title: 't', url: 'https://x/0', intakeSource: 'EMAIL_ALERT' });
    const res = await s.intake.fromEmailAlert('u1', s.project.id, [
      { url: 'https://x/0', title: null },
      { url: 'https://x/1', title: null },
    ]);
    expect(res.created).toHaveLength(1);
    expect(res.skippedKnown).toBe(1);
    expect(res.skippedOverCap).toBe(0);
    expect(res.skippedNotUsable).toBe(0);
  });

  it('КЛЮЧЕВОЙ ТЕСТ: потолок вопросов — одна константа, и он назван наружу', () => {
    // Число было вписано по месту дважды (экран и сервер). Проверка
    // держит именно это: константа существует, экспортирована и
    // используется — иначе потолки снова разъедутся.
    expect(MAX_PACKAGE_QUESTIONS).toBeGreaterThan(0);
    expect(DEFAULT_PACKAGE_QUESTIONS.length).toBeGreaterThan(0);
    const src = require('fs').readFileSync(require('path').join(__dirname, '../vacancy-intake/job-search-tools.service.ts'), 'utf8');
    // Обрезка идёт по константе, а не по числу, вписанному рядом.
    expect(src).toMatch(/slice\(0, MAX_PACKAGE_QUESTIONS\)/);
    expect(src).not.toMatch(/questions\.slice\(0, 8\)/);
  });
});
