// ТЗ devils-advocate-domain-ui-and-voice-intake-tz.md §0 — манифест домена.
// Один набор generic-компонентов, параметризованный данными, не семь копий UI.

// Повторный аудит 2026-09-01: 'job-search' добавлен седьмым. До этого
// сценарий существовал в классификаторе интейка и полностью в API, но
// не в этом типе — квиз отправлял пользователя в домен, экрана которого
// нет: проект создавался, а страница отвечала «Неизвестный сценарий».
export type DomainId = 'dtp' | 'family-law' | 'health' | 'interview-pool' | 'investment' | 'major-purchase' | 'job-search';

export type FieldType = 'text' | 'textarea' | 'number' | 'date' | 'datetime' | 'select' | 'bool' | 'money' | 'url' | 'file-base64';

export interface FieldSpec {
  name: string;
  label: string;
  type: FieldType;
  required?: boolean;
  options?: Array<{ value: string; label: string }>;
  hint?: string;
  /** для type=money — имя поля валюты рядом (по умолчанию 'currency') */
  currencyField?: string;
}

export interface EntitySpec {
  key: string;                 // ключ вкладки
  label: string;
  singular: string;
  listRoute: (configId: string) => string;
  createRoute: (configId: string) => string;
  fields: FieldSpec[];
  /** какое поле показывать заголовком строки */
  titleField: string;
  /** сессии, привязанные к сущности этого типа (консультации/встречи) */
  sessions?: SessionSpec;
  /** доп. read-only подпанели сущности */
  detailPanels?: Array<{ key: string; label: string; route: (entityId: string) => string }>;
  /** доп. действия над сущностью (POST с формой) */
  actions?: Array<{ key: string; label: string; route: (entityId: string) => string; fields: FieldSpec[]; method?: 'POST' | 'PATCH' }>;
}

export interface SessionSpec {
  label: string;               // «Консультации» / «Встречи»
  singular: string;
  listRoute: (entityId: string) => string;   // GET
  createRoute: (entityId: string) => string; // POST
  detailRoute?: (sessionId: string) => string;
  fields: FieldSpec[];
  generateRoute: (sessionId: string) => string;   // POST generate-breakdown|conclusion
  generateLabel: string;
  reviewRoute: (sessionId: string) => string;     // POST review
  reviewFields: FieldSpec[];
  /** read-only подпанели сессии (напр. mediation-notice) */
  detailPanels?: Array<{ key: string; label: string; route: (sessionId: string) => string }>;
}

export interface ExtraPanelSpec {
  key: string;
  label: string;
  /** GET по configId; возвращает произвольный JSON — рендерится generic-вьюером */
  route: (configId: string) => string;
  /** если панель живёт на уровне проекта, а не конфига */
  projectRoute?: (projectId: string) => string;
  kind: 'comparison-table' | 'budget' | 'json';
  /** для kind=budget — маршрут добавления строки */
  budgetCreateRoute?: (configId: string) => string;
  budgetFields?: FieldSpec[];
}

export interface DomainManifest {
  id: DomainId;
  title: string;
  icon: string;
  tagline: string;
  /** поля, которые нужно спросить при создании проекта помимо question */
  createProjectFields?: FieldSpec[];
  /** тип согласия, требуемый backend до создания проекта */
  requiredConsent?: string;
  routes: {
    listProjects: string;
    createProject: string;
    createOnboarding: (projectId: string) => string;
    getOnboarding: (conversationId: string) => string;
    appendAnswer: (conversationId: string) => string;
    extract: (conversationId: string) => string;
    checklist?: (conversationId: string) => string; // interview-pool: маршрут статический, аргумент игнорируется
    createConfig: (projectId: string) => string;
    getConfig: (projectId: string) => string;
  };
  /** поля верхнего уровня драфта конфига (остальное пробрасывается как есть) */
  configFields: FieldSpec[];
  /** есть ли у конфига массив criteria (у всех, кроме interview-pool) */
  hasCriteria: boolean;
  criteriaCategories?: string[];
  entities: EntitySpec[];
  extras: ExtraPanelSpec[];
}
