'use client';

// MVP-фича 4 → доработана в фиче 12 (Safe Share, §3.48 ТЗ). ДО этого
// прохода компонент шарил текст аргументов напрямую в Telegram, минуя
// content scan вообще — реальная дыра в приватности, не гипотетическая:
// PII, попавшая в вопрос/цель пользователя, могла быть эхом отражена в
// сгенерированных аргументах и уйти наружу без проверки. Теперь —
// preflight (сканирование + превью того, что увидит получатель) перед
// каждой отправкой, не только когда что-то явно найдено.

import { useState } from 'react';
import { haptic, shareViaTelegram } from '../lib/telegram';
import { safeSharePreflight, safeShareConfirm } from '../lib/features';
import { Argument } from '../lib/types';

interface ShareButtonProps {
  question: string;
  arguments: Argument[];
  projectId?: string;
}

type ShareState = 'idle' | 'scanning' | 'preview' | 'blocked' | 'error';

function buildShareText(question: string, args: Argument[]): string {
  const pros = args.filter((a) => a.stance === 'PRO').slice(0, 3);
  const cons = args.filter((a) => a.stance === 'CON').slice(0, 3);

  const lines = [`🤔 ${question}`, ''];
  if (pros.length > 0) {
    lines.push('За:', ...pros.map((a) => `+ ${a.text}`), '');
  }
  if (cons.length > 0) {
    lines.push('Против:', ...cons.map((a) => `− ${a.text}`));
  }
  lines.push('', "Подготовлено в Devil's Advocate");

  return lines.join('\n');
}

export function ShareButton({ question, arguments: args, projectId }: ShareButtonProps) {
  const [state, setState] = useState<ShareState>('idle');
  const [previewText, setPreviewText] = useState('');
  const [detectedCount, setDetectedCount] = useState(0);
  const [safeShareActionId, setSafeShareActionId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  if (args.length === 0) return null;

  async function handleStart() {
    setState('scanning');
    setError(null);
    try {
      const rawText = buildShareText(question, args);
      const result = await safeSharePreflight(rawText, 'arguments-summary', projectId);
      if (result.blocked) {
        setState('blocked');
        return;
      }
      setPreviewText(result.sanitizedText);
      setDetectedCount(result.detectedItemsCount);
      setSafeShareActionId(result.safeShareActionId);
      setState('preview');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Не удалось проверить текст перед отправкой');
      setState('error');
    }
  }

  async function handleConfirmSend() {
    if (!safeShareActionId) return;
    try {
      await safeShareConfirm(safeShareActionId);
      haptic('light');
      shareViaTelegram(previewText);
      setState('idle');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Не удалось подтвердить отправку');
      setState('error');
    }
  }

  function handleCancel() {
    setState('idle');
    setSafeShareActionId(null);
  }

  if (state === 'idle' || state === 'scanning') {
    return (
      <button type="button" className="share-button" onClick={handleStart} disabled={state === 'scanning'}>
        {state === 'scanning' ? 'Проверяем…' : 'Поделиться'}
      </button>
    );
  }

  if (state === 'blocked') {
    return (
      <div className="safe-share-preview">
        <p className="generation-error">
          Отправка отклонена проверкой безопасности содержимого. Переформулируйте текст.
        </p>
        <div className="safe-share-preview__actions">
          <button type="button" onClick={handleCancel}>
            Закрыть
          </button>
        </div>
      </div>
    );
  }

  if (state === 'error') {
    return (
      <div className="safe-share-preview">
        <p className="generation-error">{error}</p>
        <div className="safe-share-preview__actions">
          <button type="button" onClick={handleCancel}>
            Закрыть
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="safe-share-preview">
      <h3>Вот что увидит получатель</h3>
      {detectedCount > 0 && (
        <p className="safe-share-preview__notice">
          Обнаружено и скрыто чувствительных данных: {detectedCount}
        </p>
      )}
      <p className="script-text">{previewText}</p>
      <div className="safe-share-preview__actions">
        <button type="button" onClick={handleConfirmSend}>
          Отправить
        </button>
        <button type="button" onClick={handleCancel} className="safe-share-preview__cancel">
          Отмена
        </button>
      </div>
    </div>
  );
}
