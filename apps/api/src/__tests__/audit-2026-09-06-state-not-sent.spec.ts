// Сверка 2026-09-06 — пробел в `select` выглядел как «выключено».
//
// НАЙДЕННОЕ, ПЕРВОЕ. `JobSearchService.listVacancies()` перечисляет поля
// в `select`, и этот перечень застыл на наборе, существовавшем до
// пункта [job-domain-v2]. В него не попали `watchEnabled`, `favorite`,
// `responseStatus`, `duplicateOfId`, `intakeSource`,
// `employerDossierId` — при том что экран вакансий их ОБЪЯВЛЯЕТ
// (`interface Vacancy`) и рисует по ним подписи и кнопки.
//
// Результат на экране:
//  • кнопка слежения ВСЕГДА говорила «Следить за изменениями», в том
//    числе когда слежение включено, и нажатие на неё его ВЫКЛЮЧАЛО —
//    подпись обещала обратное тому, что делала;
//  • «В избранное» никогда не превращалась в «Убрать из избранного», а
//    звёздочка в заголовке не показывалась ни у одной вакансии;
//  • выбранный статус отклика всегда выглядел как «отклика не было» —
//    включая статусы, принесённые выгрузкой с площадки (К-29);
//  • бейдж «дубликат» и кнопка «Это не дубликат» не появлялись
//    никогда: отменить склейку дублей было нельзя.
//
// Форма та же, что во всём этом ряду: ПРОБЕЛ ВЫГЛЯДИТ КАК
// ОПРЕДЕЛЁННОСТЬ. Отсутствующее поле и «выключено» оба falsy, и
// отличить их экран не мог.
//
// НАЙДЕННОЕ, ВТОРОЕ (с него сверка и началась). Снятие вакансии с
// публикации записывалось В САМ ТЕКСТ ВАКАНСИИ: перечитывание,
// получив 404, дописывало в конец `rawText` строку «[Снята с
// публикации: источник ответил 404 — ДАТА]». Колонки под состояние
// источника не было. Разбор всех четырёх следствий — в
// source-availability.ts; коротко: поле объявлено как «текст страницы,
// НЕ пересказ», а продукт дописывал туда свои слова и отдавал их
// модели и человеку; плановый тик дописывал метку каждые сутки, поэтому
// текст рос на строку в день и «Изменения» показывали свежий diff
// ежедневно; `contentHash` расходился с текстом; а список, где текста
// нет вовсе, показать снятие не мог ничем.
//
// ИЗМЕРЕНО, А НЕ ПРЕДПОЛОЖЕНО. Обход экранов TMA: интерфейсов с
// optional-полями, которые используются в условиях, восемь; из них
// приходящих с сервера и управляющих подписью действия — ОДИН, тот
// самый `Vacancy`. Остальные — парсеры выгрузок, тип `window` и
// честно необязательные поля. Правило написано на найденную пару, а
// не раздуто до «все интерфейсы всех экранов»: соответствие
// «интерфейс ↔ эндпоинт» механически не выводится, и делать вид, что
// выводится, значило бы писать проверку, которая молчит.

import * as fs from 'fs';
import * as path from 'path';
import {
  availabilityNote,
  isRemovedFromSource,
  stripRemovalMarkers,
  REMOVAL_MARKER_RE,
} from '../vacancy-intake/source-availability';

const API_SRC = path.join(__dirname, '..');
const TMA_SRC = path.join(API_SRC, '..', '..', 'tma', 'src');

function listVacanciesSelect(): string[] {
  const src = fs.readFileSync(path.join(API_SRC, 'job-search', 'job-search.service.ts'), 'utf8');
  const at = src.indexOf('async listVacancies(');
  expect(at).toBeGreaterThan(-1);
  const body = src.slice(at, src.indexOf('\n  }', at));
  const sel = body.slice(body.indexOf('select: {'));
  return [...sel.matchAll(/^\s*(\w+):\s*true,/gm)].map((m) => m[1]);
}

function vacancyInterfaceFields(): string[] {
  const src = fs.readFileSync(
    path.join(TMA_SRC, 'components', 'domains', 'job-search', 'JobSearchWorkspace.tsx'),
    'utf8',
  );
  const at = src.indexOf('interface Vacancy {');
  expect(at).toBeGreaterThan(-1);
  const body = src.slice(at, src.indexOf('\n}', at));
  const withoutComments = body.replace(/\/\/[^\n]*/g, '');
  return [...withoutComments.matchAll(/^\s*(\w+)\??:/gm)].map((m) => m[1]);
}

describe('Сверка [state-not-sent]: состояние обязано доезжать до экрана', () => {
  describe('контракт «список ↔ экран»', () => {
    it('КЛЮЧЕВОЙ ТЕСТ: каждое поле, объявленное экраном вакансий, есть в select списка', () => {
      const select = listVacanciesSelect();
      const missing = vacancyInterfaceFields().filter((f) => !select.includes(f));
      expect(missing).toEqual([]);
    });

    it('поля состояния названы поимённо — проверка не держится на одном пересчёте длины', () => {
      const select = listVacanciesSelect();
      for (const f of ['watchEnabled', 'favorite', 'responseStatus', 'duplicateOfId', 'removedFromSourceAt']) {
        expect(select).toContain(f);
      }
    });

    it('rawText в список НЕ отдаётся — и экран его не объявляет, иначе проверка выше потребовала бы его', () => {
      expect(listVacanciesSelect()).not.toContain('rawText');
      expect(vacancyInterfaceFields()).not.toContain('rawText');
    });
  });

  describe('состояние источника — колонка, а не текст', () => {
    it('КЛЮЧЕВОЙ ТЕСТ: в коде не осталось дописи метки в текст вакансии', () => {
      const svc = fs.readFileSync(path.join(API_SRC, 'vacancy-intake', 'vacancy-intake.service.ts'), 'utf8');
      const code = svc.replace(/\/\/[^\n]*/g, '');
      expect(code).not.toContain('Снята с публикации');
      // Поведение повторного 404 (дата не сдвигается, текст не растёт,
      // изменением это не считается) проверяется НА ПОВЕДЕНИИ, в
      // vacancy-intake.service.spec.ts: проверка на текст кода поймала
      // мутацию первой, и это ровно тот изъян — «проверка написана на
      // упоминание, а не на поведение», — который разбирается в самом
      // продукте. Здесь остаётся только текстовое правило: своих слов
      // в поле источника быть не должно.
    });

    it('КЛЮЧЕВОЙ ТЕСТ: ни одно поле с текстом источника не собирается шаблонной строкой', () => {
      // Правило на дереве, а не на одном файле: доисать состояние в
      // текст можно из любого сервиса, и поймать это должно везде.
      const offenders: string[] = [];
      const walk = (dir: string) => {
        for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
          const p = path.join(dir, e.name);
          if (e.isDirectory()) {
            if (e.name !== '__tests__' && e.name !== 'node_modules') walk(p);
            continue;
          }
          if (!e.name.endsWith('.ts')) continue;
          const code = fs.readFileSync(p, 'utf8').replace(/\/\/[^\n]*/g, '');
          for (const m of code.matchAll(/(rawText|previousRawText)\s*:\s*`([^`]*)`/g)) {
            offenders.push(`${path.relative(API_SRC, p)}: ${m[1]}`);
          }
        }
      };
      walk(API_SRC);
      expect(offenders).toEqual([]);
    });

    it('старая метка распознаётся и вычищается, а дата берётся САМАЯ РАННЯЯ из накопленных', () => {
      // Так выглядит текст снятой вакансии после трёх суток тиков.
      const polluted =
        'Вакансия: Backend. Удалённо.' +
        '\n\n[Снята с публикации: источник ответил 404 — 2026-09-03]' +
        '\n\n[Снята с публикации: источник ответил 404 — 2026-09-04]' +
        '\n\n[Снята с публикации: источник ответил 404 — 2026-09-05]';
      const r = stripRemovalMarkers(polluted);
      expect(r.markers).toBe(3);
      expect(r.text).toBe('Вакансия: Backend. Удалённо.');
      expect(r.removedFromSourceAt).toEqual(new Date('2026-09-03T00:00:00.000Z'));
    });

    /** Мутация «дата берётся не самая ранняя» сначала УШЛА: тик
     * дописывает метки по порядку, поэтому в тексте из реального
     * продукта первая метка и есть самая ранняя, и сортировка ни на
     * что не влияла. Сортировка оставлена намеренно — правило «дата
     * снятия это первый раз, когда мы это заметили» не должно
     * опираться на порядок строк в тексте, — и проверяется на входе,
     * где порядок нарушен. Такой текст тик не создаёт; создать его
     * может миграция, склейка дублей или правка руками. */
    it('дата снятия — самая ранняя из меток, даже если в тексте они не по порядку', () => {
      const r = stripRemovalMarkers(
        'Вакансия.' +
          '\n\n[Снята с публикации: источник ответил 404 — 2026-09-09]' +
          '\n\n[Снята с публикации: источник ответил 404 — 2026-09-04]',
      );
      expect(r.removedFromSourceAt).toEqual(new Date('2026-09-04T00:00:00.000Z'));
    });

    it('чистый текст не меняется и даты не выдумывает', () => {
      const r = stripRemovalMarkers('Вакансия: Backend. [условия] в скобках — не метка.');
      expect(r.text).toBe('Вакансия: Backend. [условия] в скобках — не метка.');
      expect(r.removedFromSourceAt).toBeNull();
      expect(r.markers).toBe(0);
    });

    it('ручная миграция чистит и rawText, и previousRawText — иначе diff покажет разницу наших же дописок', () => {
      const sql = fs.readFileSync(
        path.join(API_SRC, '..', 'prisma', 'manual-migrations', 'vacancy_removal_state_2026_09_06.sql'),
        'utf8',
      );
      expect(sql).toContain('ADD COLUMN IF NOT EXISTS "removedFromSourceAt"');
      expect(sql).toMatch(/UPDATE "job_vacancies"[\s\S]*SET "rawText" = RTRIM/);
      expect(sql).toMatch(/UPDATE "job_vacancies"[\s\S]*SET "previousRawText" = RTRIM/);
      // Хеш сбрасывается: в ветке снятия он не пересчитывался, а
      // dedupe() считает его тем, у кого его нет.
      expect(sql).toContain('SET "contentHash" = NULL');
    });
  });

  describe('что человек читает', () => {
    it('КЛЮЧЕВОЙ ТЕСТ: снятие с публикации не объявляется занятым местом', () => {
      const note = availabilityNote({ removedFromSourceAt: new Date('2026-09-03T00:00:00Z'), sourceUrl: 'https://w/1' })!;
      expect(note).toContain('перестал отвечать');
      expect(note).toContain('не всегда значит');
      expect(note).not.toMatch(/место занято(?!:)/);
      expect(note).not.toContain('вакансия закрыта');
      expect(note).not.toContain('взяли другого');
    });

    it('«никогда не перечитывалась» отличается от «источник отвечал»', () => {
      expect(availabilityNote({ sourceUrl: 'https://w/1', lastRefetchedAt: null })).toContain('ни разу');
      expect(availabilityNote({ sourceUrl: 'https://w/1', lastRefetchedAt: new Date() })).toBeNull();
      // Без ссылки перечитывать нечего — и говорить об этом нечего.
      expect(availabilityNote({ sourceUrl: null, lastRefetchedAt: null })).toBeNull();
    });

    it('экран показывает снятие первым бейджем и отдельной строкой', () => {
      const ws = fs.readFileSync(
        path.join(TMA_SRC, 'components', 'domains', 'job-search', 'JobSearchWorkspace.tsx'),
        'utf8',
      );
      expect(ws).toContain("v.removedFromSourceAt ? 'снята с публикации'");
      expect(ws).toContain('<AvailabilityNote v={v} />');
      expect(ws).toContain('не всегда значит, что место занято');
    });

    it('isRemovedFromSource читает колонку, а не подстроку', () => {
      expect(isRemovedFromSource({ removedFromSourceAt: new Date() })).toBe(true);
      expect(isRemovedFromSource({ removedFromSourceAt: null })).toBe(false);
      expect(isRemovedFromSource({})).toBe(false);
    });

    it('регулярка метки глобальная — иначе вычистилась бы только первая из накопленных', () => {
      expect(REMOVAL_MARKER_RE.flags).toContain('g');
    });
  });
});
