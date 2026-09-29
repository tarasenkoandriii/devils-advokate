// Пункт [deploy-step-did-nothing] 2026-09-26 — состояние боевой базы не
// проверялось ничем.
//
// НАЙДЕНО, и это честно записано в самом `VERCEL.md`: папки
// `prisma/migrations/` нет, ни одной миграции не сгенерировано ни разу,
// `prisma migrate deploy` при пустой истории завершается успешно с
// «No migration found» и не создаёт ни одной таблицы. Схема на проде
// появлялась через `db push` или ручным SQL — «и ничто не проверяет, что
// боевая база соответствует `schema.prisma`».
//
// Предупреждение в документации стоит и написано честно. Но это
// предупреждение читает тот, кто открыл документ; продукт о своём
// расхождении со схемой не знает НИЧЕГО и оператору не говорит ничего.
//
// ЧЕГО ЭТА СВЕРКА НЕ ДЕЛАЕТ, И ЭТО ГЛАВНОЕ ЕЁ СВОЙСТВО. Она сверяет
// ТОЛЬКО имена таблиц, в обе стороны. Не колонки, не типы, не индексы,
// не ограничения, не значения перечислений (для последних есть пробы
// ручных миграций рядом). Причина не в лени: точную сверку колонок и
// индексов даёт только настоящая история миграций, а без неё любая
// «почти сверка» либо промолчит там, где расхождение есть, либо
// закричит там, где его нет. Второе хуже: правило, которое кричит на
// каждом деплое, через неделю перестают читать. Поэтому здесь ровно то,
// что можно утверждать точно, — и сказано, чего утверждать нельзя.
//
// Пропавшая таблица — самый дорогой вид расхождения: фича не работает
// целиком, и узнаёт об этом человек, а не оператор.
//
// ПОЧЕМУ НЕ ЗАМЕНЯЕТ BASELINE. Не заменяет. Baseline остаётся решением
// владельца (см. `TODO.md`): в этой среде его не собрать — Prisma тянет
// движок схемы с `binaries.prisma.sh`, а он закрыт политикой сети, и
// писать 169 таблиц DDL руками значило бы получить baseline, про
// который нельзя сказать, верен ли он.

/** Таблица, объявленная в схеме. */
export interface DeclaredTable {
  /** Имя модели Prisma — им человек ищет её в схеме. */
  model: string;
  /** Имя таблицы в базе: `@@map(...)`, а без него — имя модели как есть. */
  table: string;
}

/** Разбор `schema.prisma`: какие таблицы она объявляет.
 *
 * Разбор текстом, а не через движок Prisma: движок недоступен без сети,
 * а вопрос «какие имена таблиц объявлены» текстом решается точно.
 * Единственная тонкость — `@@map`, и она учтена. */
export function declaredTables(schema: string): DeclaredTable[] {
  const out: DeclaredTable[] = [];
  const re = /^model\s+(\w+)\s*\{([\s\S]*?)^\}/gm;
  let m: RegExpExecArray | null;
  while ((m = re.exec(schema)) !== null) {
    const model = m[1];
    const mapped = /^\s*@@map\("([^"]+)"\)/m.exec(m[2]);
    out.push({ model, table: mapped ? mapped[1] : model });
  }
  return out;
}

export interface SchemaTablesDrift {
  /** Объявлено в схеме, но в базе нет. Самое дорогое расхождение. */
  missingInDatabase: DeclaredTable[];
  /** Есть в базе, но схема о таких не знает. */
  unknownInSchema: string[];
  /** Сколько таблиц объявлено и сколько найдено — чтобы «совпало» не
   * читалось как «сверили пустоту». */
  declaredCount: number;
  observedCount: number;
  /** Чего эта сверка НЕ проверяет — едет вместе с ответом, а не живёт
   * отдельной подписью в документации. */
  notChecked: readonly string[];
}

export const SCHEMA_TABLES_NOT_CHECKED: readonly string[] = [
  'колонки и их типы — совпадение имён таблиц не означает совпадения их содержимого',
  'индексы и ограничения: в схеме их 225 объявлений, и сверить их точно можно только по настоящей истории миграций',
  'значения перечислений — для них рядом стоят пробы ручных миграций',
  'порядок применения: таблица могла появиться руками, а не миграцией, и это отсюда не видно',
];

/** Таблицы Postgres, которые к схеме Prisma не относятся: служебные
 * каталоги и то, что заводят ручные миграции и расширения. */
const IGNORED_TABLES = new Set([
  '_prisma_migrations',
  'spatial_ref_sys',
]);

export function compareSchemaTables(schema: string, observed: readonly string[]): SchemaTablesDrift {
  const declared = declaredTables(schema);
  const present = new Set(observed);
  const declaredNames = new Set(declared.map((d) => d.table));
  return {
    missingInDatabase: declared.filter((d) => !present.has(d.table)),
    unknownInSchema: observed.filter((t) => !declaredNames.has(t) && !IGNORED_TABLES.has(t)).sort(),
    declaredCount: declared.length,
    observedCount: observed.length,
    notChecked: SCHEMA_TABLES_NOT_CHECKED,
  };
}
