// Пункт [latest-migration-was-from-memory] 2026-09-24 — «последняя
// миграция», названная по памяти, отстала на одиннадцать файлов.
//
// НАЙДЕННОЕ. Диагностика схемы — сообщение, которое оператор читает в
// момент, когда прод уже не работает, — называла файл по памяти:
//
//   «(см. apps/api/prisma/manual-migrations/, последняя —
//    voice_reply_processing_2026_09_02.sql)»
//
// Файл от 2 сентября. Ручных миграций после него — одиннадцать, до
// 24 сентября включительно. Человек с нерабочей базой идёт применять
// не то.
//
// И ХУЖЕ ТОГО, УТВЕРЖДЕНИЕ БЫЛО НЕВЕРНО ПО РОДУ. Сообщение про
// «значение перечисления, которого база не знает» называет ОДИН файл, а
// `ALTER TYPE … ADD VALUE` есть в ДВУХ: `job_domain_v2_2026_09_02.sql`
// (ProjectMode.EMPLOYER_HIRING, ConsentType.CANDIDATE_DATA_TRANSFER) и
// `voice_reply_processing_2026_09_02.sql`
// (SparringVoiceReplyStatus.PROCESSING). Ошибка от первого отправляла
// оператора чинить второй.
//
// ПРЕЦЕДЕНТ РЯДОМ, И ОН ЗАПИСАН СЛОВАМИ. В соседнем файле
// `expected-cron-jobs.ts` стоит: «Синхронность с SQL-файлами держит НЕ
// ДИСЦИПЛИНА, А ТЕСТ… иначе список снова отстанет от реальности, как
// отстал EXPECTED_SCHEDULES». Тот же каталог, тот же модуль, тот же
// урок — и рядом файл, названный по памяти.
//
// ЗАЧЕМ ПРОБЫ, А НЕ ПРОСТО СПИСОК. Список файлов отвечает на вопрос
// «что бывает», а оператору нужен ответ на «что у МЕНЯ не применено».
// Поэтому у каждой миграции есть проба: колонка или значение
// перечисления, по которым видно, прошла она на этом инстансе или нет.
// «Не смогли посмотреть» и «не применено» — разные ответы, и они
// различаются (см. `admin-db-state.service.ts`).

export type MigrationProbe =
  | { kind: 'column'; table: string; column: string }
  | { kind: 'enumValue'; type: string; value: string }
  | { kind: 'none'; why: string };

export interface ManualMigration {
  /** Имя файла в `prisma/manual-migrations/` — ровно как на диске. */
  file: string;
  /** Что перестаёт работать, пока она не применена. Формулировка — для
   * оператора в момент, когда что-то уже не работает. */
  breaksWhenMissing: string;
  probe: MigrationProbe;
}

/** Все ручные миграции, кроме `pg_cron_*.sql`: те описаны отдельно в
 * `expected-cron-jobs.ts` и проверяются по таблице `cron.job`. */
export const MANUAL_MIGRATIONS: ManualMigration[] = [
  {
    file: 'schema_audit_2026_08_30.sql',
    breaksWhenMissing: 'Нет колонок updatedAt у части таблиц — записи не отражают время последнего изменения.',
    probe: { kind: 'column', table: 'users', column: 'updatedAt' },
  },
  {
    file: 'router_simplify_2026_09_01.sql',
    breaksWhenMissing: 'Остаются устаревшие записи маршрутизации AI; на работу не влияет, чистка.',
    probe: { kind: 'none', why: 'только удаление устаревших строк — по схеме не видно, применена ли' },
  },
  {
    file: 'intake_session.sql',
    breaksWhenMissing: 'Intake-квиз не сохраняет сессии: анкета не доходит до dispatch в домен.',
    probe: { kind: 'column', table: 'projects', column: 'frozenAt' },
  },
  {
    file: 'ai_locale_2026_09_02.sql',
    breaksWhenMissing: 'Язык ответа AI не сохраняется у пользователя — разборы приходят на языке по умолчанию.',
    probe: { kind: 'column', table: 'users', column: 'languageCode' },
  },
  {
    file: 'intake_attribution_2026_09_02.sql',
    breaksWhenMissing: 'Источник и кампания перехода в квиз не записываются.',
    probe: { kind: 'column', table: 'intake_sessions', column: 'source' },
  },
  {
    file: 'job_domain_v2_2026_09_02.sql',
    breaksWhenMissing:
      'База не знает режима проекта EMPLOYER_HIRING и согласия CANDIDATE_DATA_TRANSFER: домен найма работодателем не создаётся вовсе.',
    probe: { kind: 'enumValue', type: 'ProjectMode', value: 'EMPLOYER_HIRING' },
  },
  {
    file: 'multimodal_media_queue_project.sql',
    breaksWhenMissing: 'Очередь разбора медиа не привязывается к проекту — автоматический разбор не запускается.',
    probe: { kind: 'column', table: 'media_review_queues', column: 'projectId' },
  },
  {
    file: 'voice_reply_processing_2026_09_02.sql',
    breaksWhenMissing:
      'База не знает статуса PROCESSING у голосового ответа спарринга: работаем без атомарного забора задачи и без сторожевой.',
    probe: { kind: 'enumValue', type: 'SparringVoiceReplyStatus', value: 'PROCESSING' },
  },
  {
    file: 'project_log_v2_2026_09_03.sql',
    breaksWhenMissing: 'Журнал проекта не связывает события с людьми и не хранит отметку спорности сигнала.',
    probe: { kind: 'column', table: 'conversation_signals', column: 'disputedAt' },
  },
  {
    file: 'cache_retention_2026_09_03.sql',
    breaksWhenMissing: 'Кэш фактчеков не может хранить запись без текста утверждения — чистка по сроку падает.',
    probe: { kind: 'none', why: 'снимает NOT NULL: наличие колонки не отличает применённую миграцию от неприменённой' },
  },
  {
    file: 'transcription_claim_2026_09_04.sql',
    breaksWhenMissing: 'Забор задачи распознавания не атомарен: два процесса могут взять один разговор.',
    probe: { kind: 'column', table: 'conversations', column: 'transcriptionClaimedAt' },
  },
  {
    file: 'invite_revocation_2026_09_04.sql',
    breaksWhenMissing: 'Приглашения в команду и инвестиционную группу нельзя отозвать — ссылка живёт до срока.',
    probe: { kind: 'column', table: 'recruiting_team_invites', column: 'revokedAt' },
  },
  {
    file: 'person_fact_cascade_2026_09_04.sql',
    breaksWhenMissing: 'Факты о человеке не удаляются каскадом вместе с проектом — остаются без владельца.',
    probe: { kind: 'none', why: 'меняет внешний ключ: по колонкам и типам не видно' },
  },
  {
    file: 'pool_snapshot_not_assessed_2026_09_04.sql',
    breaksWhenMissing:
      'Снимок релевантности не хранит список непроверенных кандидатов — экран показывает снимок как полный.',
    probe: { kind: 'column', table: 'pool_relevance_snapshots', column: 'notAssessed' },
  },
  {
    file: 'vacancy_removal_state_2026_09_06.sql',
    breaksWhenMissing: 'Не отмечается, что источник вакансии перестал отвечать: текст выглядит актуальным.',
    probe: { kind: 'column', table: 'job_vacancies', column: 'removedFromSourceAt' },
  },
  {
    file: 'vacancy_text_total_2026_09_06.sql',
    breaksWhenMissing: 'Не хранится полный объём текста вакансии — нельзя сказать, что разобрана лишь часть.',
    probe: { kind: 'column', table: 'job_vacancies', column: 'rawTextTotalChars' },
  },
  {
    file: 'weather_source_2026_09_06.sql',
    breaksWhenMissing: 'Прогноз не помнит, какой провайдер его дал.',
    probe: { kind: 'column', table: 'weather_forecasts', column: 'source' },
  },
  {
    file: 'paralinguistics_outcome_2026_09_06.sql',
    breaksWhenMissing: 'Не сохраняется причина неудачи паралингвистики и число пропущенных фрагментов.',
    probe: { kind: 'column', table: 'conversations', column: 'paralinguisticsError' },
  },
  {
    file: 'public_participant_withdraw_token_2026_09_24.sql',
    breaksWhenMissing:
      'Участник публичного обсуждения не может забрать написанное: удостоверения у него нет, а старое (его id) больше не принимается.',
    probe: { kind: 'column', table: 'public_participants', column: 'withdrawToken' },
  },
  {
    file: 'one_active_row_2026_10_05.sql',
    breaksWhenMissing:
      'Единственность не обеспечена базой: активных версий промпта может стать две (откат оператора не доходит до потребителей), а участников SELF в деле ДТП и в разводном деле — по два (человек дважды в черновике протокола, его расходы разложены по двум «себе»). В коде это держит advisory-замок, но строку, заведённую мимо него — ручным SQL, сидом, новым путём, — остановит только индекс.',
    // Проба — не колонка и не значение перечисления: индекс не виден ни
    // тем, ни другим способом. Честнее сказать это, чем подобрать
    // похожую колонку и выдать её наличие за наличие ограничения.
    probe: {
      kind: 'none',
      why: 'Это три ЧАСТИЧНЫХ уникальных индекса; ни колонки, ни значения перечисления они не добавляют. Применён ли файл — видно запросом к pg_indexes по именам prompt_versions_promptId_active_key, dtp_participants_configId_self_key, family_law_parties_configId_self_key.',
    },
  },
];

/** Миграции, добавляющие значения перечислений. Диагностика ошибки
 * «база не знает значения» называет ИХ ВСЕ — называть одну значило бы
 * отправить оператора чинить не то. */
export function enumMigrations(): ManualMigration[] {
  return MANUAL_MIGRATIONS.filter((m) => m.probe.kind === 'enumValue');
}

/** Последняя по имени файла (имена начинаются с темы и кончаются
 * датой — сортировка по дате в имени). Выводится, а не помнится. */
export function latestManualMigration(): string {
  return latestOf(MANUAL_MIGRATIONS.map((m) => m.file));
}

/** Отдельно от реестра — чтобы порядок записей в нём можно было
 * ПРОВЕРИТЬ, а не принять на веру. Пункт
 * [latest-migration-was-from-memory] 2026-09-24: сломанное извлечение
 * даты сначала не поймалось — самая новая миграция оказалась последней
 * и по порядку в файле, и ответ совпал случайно. */
export function latestOf(files: string[]): string {
  const dated = files.filter((f) => /\d{4}_\d{2}_\d{2}\.sql$/.test(f));
  return [...dated].sort((a, b) => dateIn(a).localeCompare(dateIn(b))).at(-1) ?? files[0];
}

function dateIn(file: string): string {
  return /(\d{4}_\d{2}_\d{2})\.sql$/.exec(file)?.[1] ?? '0000_00_00';
}
