export interface RequestTranscriptionDto {
  // URL, уже полученный клиентом от AssemblyAI (см. ConversationsController
  // "/upload" — потоковая передача без буферизации) ИЛИ любой другой
  // публично доступный AssemblyAI URL. Сервер этот файл не хранит —
  // см. TranscriptionService.streamUpload().
  audioUrl: string;
  languageCode?: string;
}
