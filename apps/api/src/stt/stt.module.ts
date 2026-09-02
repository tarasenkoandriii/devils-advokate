// Пункт [stt-multi] 2026-09-02 — модуль распознавания речи.
//
// TranscriptionService (клиент AssemblyAI) объявлен и здесь: он не
// хранит состояния — только SecretsService и fetch, — а импортировать
// ради него ConversationsModule значило бы завести цикл модулей
// (ConversationsModule сам зависит от SttService). Ровно та же причина,
// по которой SecretsModule сделан глобальным.
import { Module } from '@nestjs/common';
import { SecretsModule } from '../secrets/secrets.module';
import { TranscriptionService } from '../conversations/transcription.service';
import { AssemblyAiSttProvider } from './assemblyai-stt.provider';
import { ElevenLabsSttProvider } from './elevenlabs-stt.provider';
import { SonioxSttProvider } from './soniox-stt.provider';
import { SttService } from './stt.service';
import { VoiceReplyReaperService } from './voice-reply-reaper.service';

@Module({
  imports: [SecretsModule],
  providers: [TranscriptionService, AssemblyAiSttProvider, SonioxSttProvider, ElevenLabsSttProvider, SttService, VoiceReplyReaperService],
  exports: [SttService, VoiceReplyReaperService],
})
export class SttModule {}
