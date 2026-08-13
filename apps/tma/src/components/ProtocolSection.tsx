'use client';

// Пункт 62 (backend) → TMA UI: протокол по итогам решения (§3.30 ТЗ).
// "Отправить второй стороне для подтверждения прямо в Telegram" —
// переиспользует уже существующий Safe Share pipeline (Пункт 12,
// §3.48 — safeSharePreflight/safeShareConfirm), тот же паттерн, что
// ShareButton.tsx, но с изолированной локальной state-machine (не
// трогаем уже рабочий ShareButton.tsx, тот жёстко привязан к
// question+arguments, здесь готовый текст протокола).

import { useEffect, useState } from 'react';
import { generateProtocol, listProtocols, safeSharePreflight, safeShareConfirm } from '../lib/features';
import { haptic, shareViaTelegram } from '../lib/telegram';
import { Protocol } from '../lib/types';

interface ProtocolSectionProps {
  projectId: string;
}

type ShareState = 'idle' | 'scanning' | 'preview' | 'blocked' | 'error';

export function ProtocolSection({ projectId }: ProtocolSectionProps) {
  const [protocols, setProtocols] = useState<Protocol[]>([]);
  const [loading, setLoading] = useState(true);
  const [generating, setGenerating] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [shareState, setShareState] = useState<ShareState>('idle');
  const [sharingProtocolId, setSharingProtocolId] = useState<string | null>(null);
  const [previewText, setPreviewText] = useState('');
  const [detectedCount, setDetectedCount] = useState(0);
  const [safeShareActionId, setSafeShareActionId] = useState<string | null>(null);
  const [shareError, setShareError] = useState<string | null>(null);

  function reload() {
    return listProtocols(projectId)
      .then(setProtocols)
      .catch(() => setProtocols([]));
  }

  useEffect(() => {
    reload().finally(() => setLoading(false));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectId]);

  async function handleGenerate() {
    setGenerating(true);
    setError(null);
    try {
      const protocol = await generateProtocol(projectId);
      setProtocols((prev) => [protocol, ...prev]);
      haptic('success');
    } catch (err) {
      haptic('error');
      setError(err instanceof Error ? err.message : 'Не удалось составить протокол');
    } finally {
      setGenerating(false);
    }
  }

  async function handleStartShare(protocol: Protocol) {
    setSharingProtocolId(protocol.id);
    setShareState('scanning');
    setShareError(null);
    try {
      const result = await safeSharePreflight(protocol.summaryText, 'protocol-summary', projectId);
      if (result.blocked) {
        setShareState('blocked');
        return;
      }
      setPreviewText(result.sanitizedText);
      setDetectedCount(result.detectedItemsCount);
      setSafeShareActionId(result.safeShareActionId);
      setShareState('preview');
    } catch (err) {
      setShareError(err instanceof Error ? err.message : 'Не удалось проверить текст перед отправкой');
      setShareState('error');
    }
  }

  async function handleConfirmSend() {
    if (!safeShareActionId) return;
    try {
      await safeShareConfirm(safeShareActionId);
      haptic('light');
      shareViaTelegram(previewText);
      setShareState('idle');
      setSharingProtocolId(null);
    } catch (err) {
      setShareError(err instanceof Error ? err.message : 'Не удалось подтвердить отправку');
      setShareState('error');
    }
  }

  function handleCancelShare() {
    setShareState('idle');
    setSharingProtocolId(null);
    setSafeShareActionId(null);
  }

  if (loading) return null;

  return (
    <section className="protocol-section">
      <h3>Протокол по итогам</h3>
      <p className="conversations-section__hint">
        Лёгкая версия соглашения — без юридической силы, для подтверждения второй стороной прямо в Telegram.
      </p>

      {protocols.length > 0 && (
        <ul className="protocol-section__list">
          {protocols.map((p) => (
            <li key={p.id} className="protocol-section__item">
              <p className="script-text">{p.summaryText}</p>
              {sharingProtocolId === p.id && shareState !== 'idle' ? (
                <div className="safe-share-preview">
                  {shareState === 'scanning' && <p className="conversations-section__hint">Проверяем…</p>}
                  {shareState === 'blocked' && (
                    <>
                      <p className="generation-error">Отправка отклонена проверкой безопасности содержимого.</p>
                      <button type="button" onClick={handleCancelShare}>
                        Закрыть
                      </button>
                    </>
                  )}
                  {shareState === 'error' && (
                    <>
                      <p className="generation-error">{shareError}</p>
                      <button type="button" onClick={handleCancelShare}>
                        Закрыть
                      </button>
                    </>
                  )}
                  {shareState === 'preview' && (
                    <>
                      <p className="steelman-case__label">Вот что увидит получатель</p>
                      {detectedCount > 0 && (
                        <p className="safe-share-preview__notice">Обнаружено и скрыто чувствительных данных: {detectedCount}</p>
                      )}
                      <p className="script-text">{previewText}</p>
                      <div className="safe-share-preview__actions">
                        <button type="button" onClick={handleConfirmSend}>
                          Отправить
                        </button>
                        <button type="button" onClick={handleCancelShare} className="safe-share-preview__cancel">
                          Отмена
                        </button>
                      </div>
                    </>
                  )}
                </div>
              ) : (
                <button type="button" onClick={() => handleStartShare(p)}>
                  Отправить второй стороне
                </button>
              )}
            </li>
          ))}
        </ul>
      )}

      {error && <p className="generation-error">{error}</p>}
      <button type="button" onClick={handleGenerate} disabled={generating}>
        {generating ? 'Составляем…' : 'Составить протокол'}
      </button>
    </section>
  );
}
