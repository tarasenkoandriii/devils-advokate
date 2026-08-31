// Пункт [multimodal] §3.3 — разрешение MediaRef → URI в момент вызова.
//
// Почему разрешение живёт здесь, а не в момент постановки джобы:
// подписанный URL протухает, а inputHash по нему был бы бесполезен для
// дедупликации (§10.1). Джоба хранит MediaRef (videoId/pathname), URL
// появляется только в теле запроса к провайдеру и в БД не сохраняется
// никогда (§9.2).
//
// Для blob используется РОВНО тот же механизм подписи, что уже отдаёт
// файлы AssemblyAI (issueSignedToken + presignUrl, см.
// AudioBlobService.presignForTranscription) — не новый способ доступа
// к приватному стору, а второй потребитель существующего.
//
// Срок подписи — PRESIGN_TTL_MS, выведенный из потолка ожидания
// внешней задачи, НЕ из длительности вызова: под background:true
// Google забирает файл в неизвестный момент после постановки задачи в
// свою очередь (§3.3 [R2]). Отдельная константа от 6-часового TTL
// AssemblyAI намеренно: у них разные модели забора файла.

import { Injectable } from '@nestjs/common';
import { issueSignedToken, presignUrl } from '@vercel/blob';
import { SecretsService } from '../secrets/secrets.service';
import { resolveBlobToken } from '../common/blob-token';
import { MediaRef, MediaUriResolver, PRESIGN_TTL_MS } from './ai-provider-client';

@Injectable()
export class MediaUriResolverService implements MediaUriResolver {
  constructor(private readonly secrets: SecretsService) {}

  async resolve(ref: MediaRef): Promise<{ uri: string; mimeType?: string }> {
    switch (ref.source) {
      case 'youtube':
        // Без сетевых вызовов: провайдер принимает YouTube-ссылку
        // нативно, наша инфраструктура байтов не видит (§0).
        return { uri: `https://www.youtube.com/watch?v=${ref.videoId}` };
      case 'blob': {
        const token = await resolveBlobToken(this.secrets);
        const validUntil = Date.now() + PRESIGN_TTL_MS;
        const signed = await issueSignedToken({
          token,
          pathname: ref.pathname,
          operations: ['get'],
          validUntil,
        });
        const { presignedUrl } = await presignUrl(signed, {
          operation: 'get',
          pathname: ref.pathname,
          access: 'private',
          validUntil,
        });
        return { uri: presignedUrl, mimeType: ref.mimeType };
      }
      default: {
        // exhaustiveness: новый source без ветки — ошибка компиляции
        const never: never = ref;
        throw new Error(`Unknown MediaRef source: ${JSON.stringify(never)}`);
      }
    }
  }
}
