// Пункт [job-domain-v2] — общий in-memory фейк Prisma для спеков ядра найма.
//
// До него каждый спек писал свой фейк на 100–150 строк под одну-две модели.
// Здесь — один универсальный: любая модель по имени, where с равенством,
// in / notIn / not, вложенными { some } / { is } по связям, include /
// select с одним уровнем связей. Не Prisma: ровно столько, сколько нужно
// спекам, и падает явно на том, чего не умеет.
//
// Связи описываются в конструкторе: `relations[model][field] =
// { model, localKey?, foreignKey?, many? }`.

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

type Row = Record<string, any>;

// Схема читается один раз: из неё берутся дефолты (@default) и nullable-поля
// (тип с «?»), чтобы create() отдавал строки той же формы, что Postgres —
// иначе `x === null` в сервисах не совпадал бы с undefined фейка.
interface FieldMeta { optional: boolean; list: boolean; def?: any; type: string }
const SCHEMA_META: Record<string, Record<string, FieldMeta>> = (() => {
  let text = '';
  try {
    text = readFileSync(join(__dirname, '..', '..', 'prisma', 'schema.prisma'), 'utf8');
  } catch {
    return {};
  }
  const out: Record<string, Record<string, FieldMeta>> = {};
  for (const m of text.matchAll(/^model (\w+) \{([\s\S]*?)^\}/gm)) {
    const model = m[1][0].toLowerCase() + m[1].slice(1);
    const fields: Record<string, FieldMeta> = {};
    for (const line of m[2].split('\n')) {
      const f = /^\s*(\w+)\s+([A-Za-z]+)(\[\])?(\?)?\s*(.*)$/.exec(line);
      if (!f || f[1].startsWith('@@')) continue;
      const [, name, type, list, optional, rest] = f;
      if (/@relation\(/.test(rest) || /^[A-Z]/.test(type) && !['String', 'Int', 'Boolean', 'DateTime', 'Json', 'Decimal', 'Float', 'BigInt'].includes(type) && !/@default|@map|@unique|@id/.test(rest) && !/enum/.test(rest)) {
        // связь (модельный тип без скалярных атрибутов) — пропускаем; enum-поля с дефолтом пройдут ниже
        if (/@relation\(/.test(rest) || (list && /^[A-Z]/.test(type) && !/@default/.test(rest) && !['String'].includes(type))) continue;
      }
      let def: any = undefined;
      const d = /@default\(([^)]*)\)/.exec(rest);
      if (d) {
        const raw = d[1].trim();
        if (raw === 'now()') def = () => new Date();
        else if (raw === 'true') def = true;
        else if (raw === 'false') def = false;
        else if (/^".*"$/.test(raw)) def = raw.slice(1, -1);
        else if (/^-?\d+(\.\d+)?$/.test(raw)) def = Number(raw);
        else if (/^[A-Z_]+$/.test(raw)) def = raw; // enum
        // cuid()/uuid()/autoincrement() — id выдаёт фейк
      }
      fields[name] = { optional: !!optional, list: !!list, def, type };
    }
    out[model] = fields;
  }
  return out;
})();

interface RelationDef {
  model: string;
  /** поле в ЭТОЙ модели, ссылающееся на id связанной (belongs-to) */
  localKey?: string;
  /** поле в СВЯЗАННОЙ модели, ссылающееся на id этой (has-many / has-one) */
  foreignKey?: string;
  many?: boolean;
}

export class FakePrisma {
  readonly tables = new Map<string, Row[]>();
  private counter = 0;
  [model: string]: any;

  constructor(private readonly relations: Record<string, Record<string, RelationDef>> = {}) {
    return new Proxy(this, {
      get: (target, prop: string) => {
        if (prop in target) return (target as any)[prop];
        if (typeof prop !== 'string') return undefined;
        return target.model(prop);
      },
    });
  }

  nextId(prefix = 'id') {
    return `${prefix}-${++this.counter}`;
  }

  rows(model: string): Row[] {
    if (!this.tables.has(model)) this.tables.set(model, []);
    return this.tables.get(model)!;
  }

  /** Посеять строку напрямую (без create-валидации). */
  seed(model: string, row: Row): Row {
    const full = { id: this.nextId(model), createdAt: new Date(), ...row };
    this.fillDefaults(model, full);
    this.rows(model).push(full);
    return full;
  }

  /** Сверка «половины операции» 2026-09-04: фейк умеет откатывать.
   *
   * Раньше `$transaction` просто выполнял колбэк — то есть спек не мог
   * отличить «пишется одной операцией» от «пишется двумя подряд», и
   * инвариант держался только чтением кода. Теперь перед колбэком
   * снимается снимок таблиц, и при исключении строки возвращаются на
   * место.
   *
   * Граница честная: это МОДЕЛЬ отката, а не откат. Снимок поверхностный
   * (копируются массивы строк, не сами строки), изоляции и уровней
   * согласованности здесь нет и быть не может. Тест на этом фейке
   * доказывает ровно одно: что запись идёт одной операцией, чей провал
   * не оставляет половины. */
  /** Сырой SQL, который понимает РОВНО ОДИН оператор — тот, что ввёл
   *  Пункт [two-comments-one-survived] 2026-09-30 (атомарное добавление
   *  комментария к ссылке вычитки с проверкой потолка в том же
   *  запросе).
   *
   *  Честная граница, и она здесь важнее удобства: фейк НЕ умеет
   *  исполнять SQL. Он распознаёт этот единственный оператор по форме и
   *  повторяет его смысл на строках в памяти. На любой другой сырой
   *  запрос он БРОСАЕТ, а не возвращает пустой массив, — иначе первый
   *  же новый `$queryRaw` в продуктовом коде проходил бы в тестах
   *  «успешно», ничего не сделав, и спека зеленела бы на действии,
   *  которого не было. Это та же порода, что «сверка, которой не на что
   *  смотреть»: фейк, отвечающий на всё, проверяет ничего. */
  async $queryRaw(strings: TemplateStringsArray | string[], ...values: any[]) {
    const sql = Array.isArray(strings) ? strings.join('?') : String(strings);
    const isCommentAppend =
      sql.includes('UPDATE posting_review_shares') &&
      sql.includes('jsonb_array_length') &&
      sql.includes("|| ");
    // Пункт [the-answer-was-typed-and-lost] 2026-10-01: второй известный
    // фейку оператор — атомарное добавление ответа квиза. Учтён ЯВНО, по
    // тому же правилу, что и первый: фейк, отвечающий на всё, проверяет
    // ничего.
    const isAnswerAppend =
      sql.includes('UPDATE intake_sessions') &&
      sql.includes('jsonb_array_length') &&
      sql.includes("|| ");
    if (!isCommentAppend && !isAnswerAppend) {
      throw new Error(
        `FakePrisma.$queryRaw: этот фейк знает два оператора — атомарное добавление комментария к posting_review_shares ` +
          `и атомарное добавление ответа к intake_sessions. ` +
          `Получен другой запрос — научите фейк ЯВНО, а не рассчитывайте на молчаливый пустой ответ:\n${sql}`,
      );
    }
    if (isAnswerAppend) {
      const [entryJson, id] = values as [string, string];
      const row = this.rows('intakeSession').find((r: any) => r.id === id) as any;
      // Условие `status = 'IN_PROGRESS'` живёт в самом операторе —
      // фейк обязан его воспроизводить, иначе спека на «сессия
      // завершена» зеленела бы на действии, которого в бою не будет.
      if (!row || row.status !== 'IN_PROGRESS') return [];
      const existingAnswers = Array.isArray(row.answers) ? row.answers : [];
      row.answers = [...existingAnswers, ...JSON.parse(entryJson)];
      return [{ count: row.answers.length }];
    }
    const [entryJson, id, limit] = values as [string, string, number];
    const row = this.rows('postingReviewShare').find((r: any) => r.id === id) as any;
    if (!row) return [];
    const existing = Array.isArray(row.comments) ? row.comments : [];
    if (existing.length >= Number(limit)) return [];
    row.comments = [...existing, ...JSON.parse(entryJson)];
    return [{ count: row.comments.length }];
  }

  async $transaction(arg: any) {
    if (typeof arg !== 'function') return Promise.all(arg);
    const snapshot = new Map<string, Row[]>();
    for (const [model, rows] of this.tables) snapshot.set(model, [...rows]);
    try {
      return await arg(this);
    } catch (err) {
      this.tables.clear();
      for (const [model, rows] of snapshot) this.tables.set(model, rows);
      throw err;
    }
  }

  private matchValue(value: any, cond: any): boolean {
    if (cond === null || cond === undefined) return value === null || value === undefined;
    if (cond instanceof Date) return value instanceof Date && value.getTime() === cond.getTime();
    if (typeof cond !== 'object' || Array.isArray(cond)) return value === cond;
    // операторы
    return Object.entries(cond).every(([op, v]) => {
      switch (op) {
        case 'in':
          return (v as any[]).includes(value);
        case 'notIn':
          return !(v as any[]).includes(value);
        case 'not':
          return v === null ? value !== null && value !== undefined : !this.matchValue(value, v);
        case 'equals':
          return this.matchValue(value, v);
        case 'lt':
          return value < (v as any);
        case 'lte':
          return value <= (v as any);
        case 'gt':
          return value > (v as any);
        case 'gte':
          return value >= (v as any);
        case 'contains':
          return typeof value === 'string' && value.includes(v as string);
        case 'startsWith':
          return typeof value === 'string' && value.startsWith(v as string);
        case 'has':
          return Array.isArray(value) && value.includes(v);
        case 'isEmpty':
          return Array.isArray(value) && value.length === 0 === v;
        default:
          throw new Error(`FakePrisma: оператор where «${op}» не поддержан`);
      }
    });
  }

  private matches(model: string, row: Row, where: Row | undefined): boolean {
    if (!where) return true;
    return Object.entries(where).every(([key, cond]) => {
      if (key === 'AND') return (cond as Row[]).every((w) => this.matches(model, row, w));
      if (key === 'OR') return (cond as Row[]).some((w) => this.matches(model, row, w));
      if (key === 'NOT') return !this.matches(model, row, cond as Row);
      const rel = this.relations[model]?.[key];
      if (rel) {
        const related = this.related(model, row, key);
        if (rel.many) {
          const c = cond as Row;
          if (c.some) return (related as Row[]).some((r) => this.matches(rel.model, r, c.some));
          if (c.none) return !(related as Row[]).some((r) => this.matches(rel.model, r, c.none));
          if (c.every) return (related as Row[]).every((r) => this.matches(rel.model, r, c.every));
          throw new Error(`FakePrisma: фильтр по связи-списку «${key}» без some/none/every`);
        }
        const c = cond as Row;
        if (c && 'is' in c) return related !== null && this.matches(rel.model, related as Row, c.is);
        if (c && 'isNot' in c) return c.isNot === null ? related !== null : !(related && this.matches(rel.model, related as Row, c.isNot));
        if (cond === null) return related === null;
        return related !== null && this.matches(rel.model, related as Row, c);
      }
      // составной unique-ключ вида { teamId_userId: { teamId, userId } }
      if (key.includes('_') && cond && typeof cond === 'object' && !Array.isArray(cond) && !(cond instanceof Date) && Object.keys(cond).every((k) => key.split('_').includes(k))) {
        return Object.entries(cond).every(([k, v]) => this.matchValue(row[k], v));
      }
      return this.matchValue(row[key], cond);
    });
  }

  private related(model: string, row: Row, field: string): Row | Row[] | null {
    const rel = this.relations[model]?.[field];
    if (!rel) throw new Error(`FakePrisma: связь ${model}.${field} не описана`);
    const target = this.rows(rel.model);
    if (rel.many) return target.filter((r) => r[rel.foreignKey!] === row.id);
    if (rel.localKey) return target.find((r) => r.id === row[rel.localKey!]) ?? null;
    return target.find((r) => r[rel.foreignKey!] === row.id) ?? null;
  }

  private shape(model: string, row: Row, args: { include?: Row; select?: Row } | undefined): Row {
    if (!args?.include && !args?.select) return { ...row };
    const out: Row = args.select ? {} : { ...row };
    const spec = args.select ?? args.include!;
    for (const [key, v] of Object.entries(spec)) {
      if (!v) continue;
      const rel = this.relations[model]?.[key];
      if (rel) {
        const related = this.related(model, row, key);
        const sub = typeof v === 'object' ? (v as Row) : {};
        if (rel.many) {
          let list = (related as Row[]).filter((r) => this.matches(rel.model, r, sub.where));
          if (sub.orderBy) list = this.sort(list, sub.orderBy);
          if (sub.take) list = list.slice(0, sub.take);
          out[key] = list.map((r) => this.shape(rel.model, r, sub));
        } else {
          out[key] = related ? this.shape(rel.model, related as Row, typeof v === 'object' ? (v as Row) : undefined) : null;
        }
      } else if (args.select) {
        out[key] = row[key];
      }
    }
    return out;
  }

  private sort(list: Row[], orderBy: Row | Row[]): Row[] {
    const orders = Array.isArray(orderBy) ? orderBy : [orderBy];
    return [...list].sort((a, b) => {
      for (const o of orders) {
        const [field, dir] = Object.entries(o)[0] as [string, string];
        const av = a[field] instanceof Date ? a[field].getTime() : a[field];
        const bv = b[field] instanceof Date ? b[field].getTime() : b[field];
        if (av === bv) continue;
        if (av === null || av === undefined) return 1;
        if (bv === null || bv === undefined) return -1;
        return (av < bv ? -1 : 1) * (dir === 'desc' ? -1 : 1);
      }
      return 0;
    });
  }

  private applyData(model: string, row: Row, data: Row) {
    for (const [k, v] of Object.entries(data)) {
      if (v && typeof v === 'object' && !Array.isArray(v) && !(v instanceof Date)) {
        if ('increment' in v) {
          row[k] = (row[k] ?? 0) + v.increment;
          continue;
        }
        if ('decrement' in v) {
          row[k] = (row[k] ?? 0) - v.decrement;
          continue;
        }
        if ('set' in v) {
          row[k] = v.set;
          continue;
        }
        if ('create' in v || 'connect' in v) {
          // вложенное создание списка: rel has-many
          const rel = this.relations[model]?.[k];
          if (rel?.many && 'create' in v) {
            const items = Array.isArray(v.create) ? v.create : [v.create];
            for (const item of items) void this.model(rel.model).create({ data: { ...item, [rel.foreignKey!]: row.id } });
          }
          continue;
        }
      }
      row[k] = v;
    }
    row.updatedAt = new Date();
  }

  /** Дефолты и null для nullable-полей — как это сделал бы Postgres. */
  private fillDefaults(model: string, row: Row) {
    const meta = SCHEMA_META[model];
    if (!meta) return;
    for (const [name, f] of Object.entries(meta)) {
      if (row[name] !== undefined) continue;
      if (f.def !== undefined) row[name] = typeof f.def === 'function' ? f.def() : f.def;
      else if (f.list) row[name] = [];
      else if (f.optional) row[name] = null;
    }
  }

  model(name: string) {
    const rows = () => this.rows(name);
    // eslint-disable-next-line @typescript-eslint/no-this-alias -- методы объекта ниже вызываются без привязки this
    const self = this;
    return {
      create: async ({ data, include, select }: any) => {
        const row: Row = { id: data.id ?? self.nextId(name), createdAt: new Date() };
        self.applyData(name, row, data);
        self.fillDefaults(name, row);
        rows().push(row);
        return self.shape(name, row, { include, select });
      },
      createMany: async ({ data }: any) => {
        const items = Array.isArray(data) ? data : [data];
        for (const d of items) {
          const row: Row = { id: d.id ?? self.nextId(name), createdAt: new Date() };
          self.applyData(name, row, d);
          self.fillDefaults(name, row);
          rows().push(row);
        }
        return { count: items.length };
      },
      findUnique: async ({ where, include, select }: any) => {
        const row = rows().find((r) => self.matches(name, r, where));
        return row ? self.shape(name, row, { include, select }) : null;
      },
      findUniqueOrThrow: async ({ where, include, select }: any) => {
        const row = rows().find((r) => self.matches(name, r, where));
        if (!row) throw new Error(`FakePrisma: ${name} not found`);
        return self.shape(name, row, { include, select });
      },
      findFirst: async ({ where, include, select, orderBy }: any = {}) => {
        let list = rows().filter((r) => self.matches(name, r, where));
        if (orderBy) list = self.sort(list, orderBy);
        return list[0] ? self.shape(name, list[0], { include, select }) : null;
      },
      // Пункт [same-answer-either-way] 2026-09-24: заглушка была беднее
      // production — метода не было вовсе, потому что до этой правки его
      // никто не звал. Появился он ровно там, где перечитывают строку
      // после проигранной гонки: «её точно кто-то уже создал» — это
      // утверждение, и падать на его нарушении правильнее, чем молча
      // продолжать с null.
      findFirstOrThrow: async ({ where, include, select, orderBy }: any = {}) => {
        let list = rows().filter((r) => self.matches(name, r, where));
        if (orderBy) list = self.sort(list, orderBy);
        if (!list[0]) throw new Error(`FakePrisma: ${name} not found`);
        return self.shape(name, list[0], { include, select });
      },
      findMany: async ({ where, include, select, orderBy, take, skip }: any = {}) => {
        let list = rows().filter((r) => self.matches(name, r, where));
        if (orderBy) list = self.sort(list, orderBy);
        if (skip) list = list.slice(skip);
        if (take) list = list.slice(0, take);
        return list.map((r) => self.shape(name, r, { include, select }));
      },
      count: async ({ where }: any = {}) => rows().filter((r) => self.matches(name, r, where)).length,
      groupBy: async ({ by, where }: any) => {
        const groups = new Map<string, Row>();
        for (const r of rows().filter((x) => self.matches(name, x, where))) {
          const key = (by as string[]).map((f) => String(r[f])).join('|');
          const g = groups.get(key) ?? Object.fromEntries([...(by as string[]).map((f) => [f, r[f]]), ['_count', { _all: 0 }]]);
          g._count._all++;
          groups.set(key, g);
        }
        return [...groups.values()];
      },
      update: async ({ where, data, include, select }: any) => {
        const row = rows().find((r) => self.matches(name, r, where));
        if (!row) throw new Error(`FakePrisma: ${name} not found for update`);
        self.applyData(name, row, data);
        return self.shape(name, row, { include, select });
      },
      updateMany: async ({ where, data }: any) => {
        const list = rows().filter((r) => self.matches(name, r, where));
        for (const r of list) self.applyData(name, r, data);
        return { count: list.length };
      },
      upsert: async ({ where, create, update, include, select }: any) => {
        const row = rows().find((r) => self.matches(name, r, where));
        if (row) {
          self.applyData(name, row, update);
          return self.shape(name, row, { include, select });
        }
        const created: Row = { id: create.id ?? self.nextId(name), createdAt: new Date() };
        self.applyData(name, created, create);
        self.fillDefaults(name, created);
        rows().push(created);
        return self.shape(name, created, { include, select });
      },
      delete: async ({ where }: any) => {
        const idx = rows().findIndex((r) => self.matches(name, r, where));
        if (idx < 0) throw new Error(`FakePrisma: ${name} not found for delete`);
        return rows().splice(idx, 1)[0];
      },
      deleteMany: async ({ where }: any = {}) => {
        const before = rows().length;
        const kept = rows().filter((r) => !self.matches(name, r, where));
        self.tables.set(name, kept);
        return { count: before - kept.length };
      },
    };
  }
}

/** Связи моделей найма, которыми пользуются сервисы job-domain-v2. */
export const HIRING_RELATIONS: Record<string, Record<string, RelationDef>> = {
  project: {
    owner: { model: 'user', localKey: 'ownerId' },
    interviewPoolConfig: { model: 'interviewPoolConfig', foreignKey: 'projectId' },
    jobSearchConfig: { model: 'jobSearchConfig', foreignKey: 'projectId' },
  },
  interviewPoolConfig: {
    project: { model: 'project', localKey: 'projectId' },
    questions: { model: 'questionnaireItem', foreignKey: 'configId', many: true },
    complianceFlags: { model: 'complianceFlag', foreignKey: 'configId', many: true },
    interviewStages: { model: 'interviewStageDefinition', foreignKey: 'configId', many: true },
  },
  questionnaireItem: { config: { model: 'interviewPoolConfig', localKey: 'configId' } },
  jobSearchConfig: {
    project: { model: 'project', localKey: 'projectId' },
    criteria: { model: 'jobSearchCriterion', foreignKey: 'configId', many: true },
    vacancies: { model: 'jobVacancy', foreignKey: 'configId', many: true },
  },
  jobVacancy: {
    config: { model: 'jobSearchConfig', localKey: 'configId' },
    termsSheet: { model: 'termsSheet', foreignKey: 'vacancyId' },
    employerDossier: { model: 'employerDossier', localKey: 'employerDossierId' },
  },
  vacancyCandidate: { config: { model: 'jobSearchConfig', localKey: 'configId' } },
  candidatePipelineStatus: {
    project: { model: 'project', localKey: 'projectId' },
    candidateProfile: { model: 'candidateProfile', localKey: 'candidateProfileId' },
    stageProgress: { model: 'candidateStageProgress', foreignKey: 'statusId', many: true },
    followUpRequests: { model: 'candidateFollowUpRequest', foreignKey: 'statusId', many: true },
    termsSheet: { model: 'termsSheet', foreignKey: 'pipelineStatusId' },
    preQuestionnaireInvites: { model: 'preQuestionnaireInvite', foreignKey: 'pipelineStatusId', many: true },
  },
  candidateStageProgress: {
    status: { model: 'candidatePipelineStatus', localKey: 'statusId' },
    stageDefinition: { model: 'interviewStageDefinition', localKey: 'stageDefinitionId' },
  },
  preQuestionnaireInvite: { pipelineStatus: { model: 'candidatePipelineStatus', localKey: 'pipelineStatusId' } },
  sparringSession: {
    project: { model: 'project', localKey: 'projectId' },
    messages: { model: 'sparringMessage', foreignKey: 'sessionId', many: true },
  },
  sparringMessage: { session: { model: 'sparringSession', localKey: 'sessionId' } },
  liveHintEvent: { clause: { model: 'termsClause', localKey: 'clauseId' } },
  candidateProfile: {
    pipelineStatuses: { model: 'candidatePipelineStatus', foreignKey: 'candidateProfileId', many: true },
  },
  termsSheet: {
    project: { model: 'project', localKey: 'projectId' },
    pipelineStatus: { model: 'candidatePipelineStatus', localKey: 'pipelineStatusId' },
    clauses: { model: 'termsClause', foreignKey: 'sheetId', many: true },
    offers: { model: 'offerDocument', foreignKey: 'sheetId', many: true },
    cvVariants: { model: 'cvVariant', foreignKey: 'sheetId', many: true },
  },
  termsClause: {
    sheet: { model: 'termsSheet', localKey: 'sheetId' },
    positions: { model: 'clausePosition', foreignKey: 'clauseId', many: true },
  },
  clausePosition: { clause: { model: 'termsClause', localKey: 'clauseId' } },
  offerDocument: { sheet: { model: 'termsSheet', localKey: 'sheetId' } },
  cvVariant: { sheet: { model: 'termsSheet', localKey: 'sheetId' } },
  conversation: {
    project: { model: 'project', localKey: 'projectId' },
    transcript: { model: 'transcript', foreignKey: 'conversationId' },
    participants: { model: 'conversationParticipant', foreignKey: 'conversationId', many: true },
  },
  transcript: {
    conversation: { model: 'conversation', localKey: 'conversationId' },
    segments: { model: 'transcriptSegment', foreignKey: 'transcriptId', many: true },
  },
  transcriptSegment: { transcript: { model: 'transcript', localKey: 'transcriptId' } },
  conversationParticipant: { conversation: { model: 'conversation', localKey: 'conversationId' } },
  vacancyPosting: {
    project: { model: 'project', localKey: 'projectId' },
    revisions: { model: 'vacancyPostingRevision', foreignKey: 'postingId', many: true },
    variants: { model: 'vacancyPostingVariant', foreignKey: 'postingId', many: true },
    reviewShares: { model: 'postingReviewShare', foreignKey: 'postingId', many: true },
  },
  vacancyPostingRevision: {
    posting: { model: 'vacancyPosting', localKey: 'postingId' },
    variants: { model: 'vacancyPostingVariant', foreignKey: 'derivedFromRevisionId', many: true },
    complianceFlags: { model: 'complianceFlag', foreignKey: 'postingRevisionId', many: true },
  },
  vacancyPostingVariant: { posting: { model: 'vacancyPosting', localKey: 'postingId' } },
  postingReviewShare: {
    posting: { model: 'vacancyPosting', localKey: 'postingId' },
    revision: { model: 'vacancyPostingRevision', localKey: 'revisionId' },
  },
  clientBrief: {
    project: { model: 'project', localKey: 'projectId' },
    complianceFlags: { model: 'complianceFlag', foreignKey: 'clientBriefId', many: true },
  },
  complianceFlag: {
    config: { model: 'interviewPoolConfig', localKey: 'configId' },
    postingRevision: { model: 'vacancyPostingRevision', localKey: 'postingRevisionId' },
    clientBrief: { model: 'clientBrief', localKey: 'clientBriefId' },
  },
  employerDossier: {
    project: { model: 'project', localKey: 'projectId' },
    facts: { model: 'employerDossierFact', foreignKey: 'dossierId', many: true },
    representatives: { model: 'employerRepresentativeClaim', foreignKey: 'dossierId', many: true },
    jobVacancies: { model: 'jobVacancy', foreignKey: 'employerDossierId', many: true },
  },
  employerDossierFact: { dossier: { model: 'employerDossier', localKey: 'dossierId' } },
  employerRepresentativeClaim: {
    dossier: { model: 'employerDossier', localKey: 'dossierId' },
    person: { model: 'person', localKey: 'personId' },
  },
  employerAgencyEngagement: { employerProject: { model: 'project', localKey: 'employerProjectId' } },
  clientReport: { project: { model: 'project', localKey: 'projectId' } },
  candidateShare: { sourceCandidate: { model: 'candidateProfile', localKey: 'sourceCandidateId' } },
  recruitingTeam: { members: { model: 'recruitingTeamMember', foreignKey: 'teamId', many: true } },
  recruitingTeamMember: { team: { model: 'recruitingTeam', localKey: 'teamId' } },
  commitment: {
    project: { model: 'project', localKey: 'projectId' },
    person: { model: 'person', localKey: 'personId' },
    candidateProfile: { model: 'candidateProfile', localKey: 'candidateProfileId' },
  },
};

export function createHiringFakePrisma() {
  return new FakePrisma(HIRING_RELATIONS);
}

/** Роутер-фейк: очередь ответов по taskType или общий обработчик. */
export function createFakeRouter(handler: (req: any) => string | Promise<string>) {
  const calls: any[] = [];
  const completionHandlers = new Map<string, (o: any) => Promise<void>>();
  const queued: any[] = [];
  return {
    calls,
    queued,
    completionHandlers,
    registerCompletionHandler: (taskType: string, handler: (o: any) => Promise<void>) => completionHandlers.set(taskType, handler),
    enqueue: async (req: any) => {
      queued.push(req);
      return { jobId: `job-${queued.length}` };
    },
    execute: async (req: any) => {
      calls.push(req);
      const text = await handler(req);
      if (req.validateOutput && !req.validateOutput(text)) {
        throw new Error(`FakeRouter: ответ не прошёл validateOutput для ${req.taskType}: ${text.slice(0, 200)}`);
      }
      return { aiInferenceId: `inf-${calls.length}`, jobId: `job-${calls.length}`, text };
    },
  };
}

export const fakeAudit = { record: async () => ({}) };
