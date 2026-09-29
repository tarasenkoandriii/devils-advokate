// Аудит времени 2026-09-03 — час прогноза, который показывался не тот.
//
// Виджет погоды отвечает на вопрос «переносить ли встречу», то есть его
// ошибка не абстрактная: человек читает «гроза» про час, в котором грозы
// нет, и переносит разговор зря — либо наоборот. Ошибок было две, и обе
// тихие (прогноз показывался, просто не для того момента):
//   1. `timezone=auto` возвращает МЕСТНОЕ время точки без смещения
//      («2026-06-15T14:00»), а такую строку JS разбирает в часовом поясе
//      СРЕДЫ. Ближайший час промахивался ровно на смещение точки.
//   2. Диапазон дат брался в UTC, а трактовался API в местном поясе:
//      встреча в 00:30 по местному времени выпадала из запрошенных суток.
//
// Лечение — не «поддержка часовых поясов» (их в продукте нет), а отказ от
// местного времени: просим UTC и берём сутки с запасом.
import { getForecast, parseApiHourUtc } from '../weather-forecast/open-meteo-client';

const originalFetch = (global as any).fetch;

afterEach(() => {
  (global as any).fetch = originalFetch;
});

describe('Open-Meteo: час прогноза не зависит ни от пояса точки, ни от пояса сервера', () => {
  it('КЛЮЧЕВОЙ ТЕСТ: строка без суффикса разбирается как UTC, а не как местное время среды', () => {
    expect(parseApiHourUtc('2026-06-15T14:00')).toBe(Date.parse('2026-06-15T14:00:00Z'));
    // Явное смещение уважается как есть — строку не «дочиняем» вторым Z.
    expect(parseApiHourUtc('2026-06-15T14:00Z')).toBe(Date.parse('2026-06-15T14:00:00Z'));
    expect(parseApiHourUtc('2026-06-15T17:00+03:00')).toBe(Date.parse('2026-06-15T14:00:00Z'));
  });

  it('КЛЮЧЕВОЙ ТЕСТ: запрашивается UTC и сутки с запасом — встреча около полуночи не выпадает из окна', async () => {
    const urls: string[] = [];
    (global as any).fetch = async (url: string) => {
      urls.push(url);
      return {
        ok: true,
        json: async () => ({
          hourly: {
            time: ['2026-06-14T21:00', '2026-06-14T22:00', '2026-06-14T23:00'],
            temperature_2m: [11, 12, 13],
            weathercode: [0, 0, 95],
          },
        }),
      };
    };

    // Встреча 15 июня в 00:30 по местному времени точки (UTC+3) — это
    // 14 июня 21:30 UTC. Раньше сутки просились по UTC-дате самой встречи,
    // и нужного часа в ответе не было вовсе.
    const target = new Date('2026-06-14T21:30:00Z');
    const res = await getForecast({ latitude: 50.45, longitude: 30.52 }, target);

    expect(urls[0]).toContain('timezone=UTC');
    expect(urls[0]).toContain('start_date=2026-06-13');
    expect(urls[0]).toContain('end_date=2026-06-15');
    // Ближайший час к 21:30 UTC — 21:00, а не 23:00 (не «последний в списке»).
    expect(res.temperatureCelsius).toBe(11);
  });

  it('выбирается ближайший час, а не совпадающий по номеру: 14:40 → 15:00', async () => {
    (global as any).fetch = async () => ({
      ok: true,
      json: async () => ({
        hourly: { time: ['2026-06-15T14:00', '2026-06-15T15:00'], temperature_2m: [20, 24], weathercode: [0, 0] },
      }),
    });

    const res = await getForecast({ latitude: 50.45, longitude: 30.52 }, new Date('2026-06-15T14:40:00Z'));
    expect(res.temperatureCelsius).toBe(24);
  });

  it('пустой почасовой ответ — честное «нет данных», не выдуманный ноль градусов', async () => {
    (global as any).fetch = async () => ({ ok: true, json: async () => ({ hourly: { time: [] } }) });
    const res = await getForecast({ latitude: 0, longitude: 0 }, new Date('2026-06-15T12:00:00Z'));
    /** ПЕРЕПИСАН, Пункт [forecast-without-source] 2026-09-06. Смысл
     * теста сохранён полностью — «пусто, а не выдуманный ноль», — но
     * пустота теперь `null`, а не строка «нет данных»: та строка
     * сохранялась как описание погоды и уходила в промпт, после чего
     * модель советовала по ней «проводить / перенести». Изменён код,
     * а не ослаблено требование. */
    expect(res).toEqual({ temperatureCelsius: null, condition: null, source: 'open-meteo' });
  });
});
