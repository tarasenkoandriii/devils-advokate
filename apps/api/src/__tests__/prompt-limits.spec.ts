// Аудит границ ввода 2026-09-03 — сколько текста клиент может послать в
// платный внешний вызов.
//
// Сверка DTO показала: у 135 DTO нет ни одного декоратора class-validator
// (осознанное решение Пункта [validation] — глобальный whitelist положил бы
// API), и среди них есть поля, уходящие в промпт ПРЯМО ИЗ ЗАПРОСА. У живых
// циклов это особенно заметно: клиент вызывает их сам каждые 15–45 секунд и
// сам задаёт содержимое окна. Часть сервисов резала вход, часть нет —
// правило было, общим оно не было.
import { BadRequestException } from '@nestjs/common';
import { MAX_LIVE_WINDOW_CHARS, MAX_USER_PROMPT_CHARS, assertWithinLimit } from '../ai-router/prompt-limits';

describe('Границы ввода в платный вызов', () => {
  it('КЛЮЧЕВОЙ ТЕСТ: слишком длинный текст ОТКЛОНЯЕТСЯ, а не обрезается молча', () => {
    // Обрезка была бы хуже отказа: модель ответила бы про урезанный
    // фрагмент, а человек считал бы, что она видела весь разговор.
    const tooLong = 'а'.repeat(MAX_LIVE_WINDOW_CHARS + 1);
    let thrown: any = null;
    try {
      assertWithinLimit(tooLong, MAX_LIVE_WINDOW_CHARS, 'Окно транскрипта');
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(BadRequestException);
    expect(String(thrown.message)).toMatch(/Окно транскрипта/);
    // В тексте отказа названы обе величины — иначе «слишком длинный»
    // невозможно исправить, не гадая.
    expect(String(thrown.message)).toMatch(new RegExp(String(MAX_LIVE_WINDOW_CHARS)));
    expect(String(thrown.message)).toMatch(new RegExp(String(tooLong.length)));
  });

  it('ровно предел — проходит: граница не «примерно», а точная', () => {
    expect(() => assertWithinLimit('а'.repeat(MAX_LIVE_WINDOW_CHARS), MAX_LIVE_WINDOW_CHARS, 'Окно')).not.toThrow();
  });

  it('предел роутера заведомо больше самого длинного честного промпта проекта (сверка вариантов CV — 24 000)', () => {
    expect(MAX_USER_PROMPT_CHARS).toBeGreaterThan(24_000);
    // И заведомо меньше «сколько влезет»: потолок существует, чтобы за
    // чужую шалость не платил владелец.
    expect(MAX_USER_PROMPT_CHARS).toBeLessThan(1_000_000);
  });

  it('окно живого цикла строже общего предела — это разные вопросы, а не одно число в двух местах', () => {
    expect(MAX_LIVE_WINDOW_CHARS).toBeLessThan(MAX_USER_PROMPT_CHARS);
  });
});
