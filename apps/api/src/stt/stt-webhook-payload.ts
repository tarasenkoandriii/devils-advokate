// Пункт [stt-multi] 2026-09-02 — тело вебхука распознавания.
//
// Провайдеров два, и оба присылают МИНИМУМ: идентификатор задачи и
// статус, без текста (текст добирается отдельным запросом). Отличается
// только имя поля с идентификатором:
//
//   AssemblyAI → { transcript_id, status }
//   Soniox     → { id, status }
//
// Разбор вынесен сюда, а не размазан по трём контроллерам, ровно по той
// причине, по которой в проекте уже собраны в одно место проверки
// согласий и ошибки AI: три копии одного условия — способ разъехаться.

export interface SttWebhookPayload {
  /** Идентификатор задачи в терминах ПРОВАЙДЕРА (без нашего префикса). */
  externalJobId: string | null;
  status: 'completed' | 'error' | string;
  /** Кто прислал — по имени поля с идентификатором (аудит 2026-09-02:
   *  нужно, чтобы убрать у провайдера задачу, владельца которой у нас
   *  уже нет — в базе искать нечего, а провайдер известен только так). */
  providerHint: 'assemblyai' | 'soniox' | null;
}

export function parseSttWebhookPayload(body: unknown): SttWebhookPayload {
  const payload = (body ?? {}) as Record<string, unknown>;

  const transcriptId = typeof payload.transcript_id === 'string' ? payload.transcript_id : null;
  const id = typeof payload.id === 'string' ? payload.id : null;
  const status = typeof payload.status === 'string' ? payload.status : 'unknown';

  return {
    externalJobId: transcriptId ?? id,
    status,
    providerHint: transcriptId ? 'assemblyai' : id ? 'soniox' : null,
  };
}
