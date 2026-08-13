'use client';

// Пункт 70 (backend) → TMA UI: компромиссный лист при спарринге
// (§3.41 ТЗ). Изолированная локальная state-machine для отправки
// через Safe Share — тот же паттерн, что уже применён в
// ProtocolSection.tsx (Пункт 62), не рефакторинг общего компонента.
//
// "sentToFigurant не может стать true без previewedByUser=true" —
// backend уже проверяет это жёстко (Пункт 70), здесь UI дополнительно
// не даёт нажать "Отправить" до просмотра — тот же инвариант с двух
// сторон, не полагается только на одну.

import { useEffect, useState } from 'react';
import {
  generateCompromiseSheet,
  generateCompromiseSheetVoiceOver,
  listCompromiseSheets,
  markCompromiseSheetPreviewed,
  markCompromiseSheetSentToFigurant,
  safeSharePreflight,
  safeShareConfirm,
} from '../lib/features';
import { CompromiseSheet, CompromiseSheetPhase } from '../lib/types';
import { haptic, shareViaTelegram } from '../lib/telegram';
import { UserVoiceRecordingSection } from './UserVoiceRecordingSection';

interface CompromiseSheetSectionProps {
  sessionId: string;
  projectId: string;
  hasDialogue: boolean; // "после" требует хотя бы одного обмена репликами
}

type ShareState = 'idle' | 'scanning' | 'preview' | 'blocked' | 'error';

export function CompromiseSheetSection({ sessionId, projectId, hasDialogue }: CompromiseSheetSectionProps) {
  const [sheets, setSheets] = useState<CompromiseSheet[]>([]);
  const [loading, setLoading] = useState(true);
  const [generating, setGenerating] = useState<CompromiseSheetPhase | null>(null);
  const [error, setError] = useState<string | null>(null);

  const [shareState, setShareState] = useState<ShareState>('idle');
  const [sharingSheetId, setSharingSheetId] = useState<string | null>(null);
  const [previewText, setPreviewText] = useState('');
  const [detectedCount, setDetectedCount] = useState(0);
  const [safeShareActionId, setSafeShareActionId] = useState<string | null>(null);
  const [shareError, setShareError] = useState<string | null>(null);
  const [recordingForSheetId, setRecordingForSheetId] = useState<string | null>(null);

  function reload() {
    return listCompromiseSheets(sessionId)
      .then(setSheets)
      .catch(() => setSheets([]));
  }

  useEffect(() => {
    reload().finally(() => setLoading(false));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionId]);

  async function handleGenerate(phase: CompromiseSheetPhase) {
    setGenerating(phase);
    setError(null);
    try {
      const sheet = await generateCompromiseSheet(sessionId, phase);
      setSheets((prev) => [sheet, ...prev]);
      haptic('success');
    } catch (err) {
      haptic('error');
      setError(err instanceof Error ? err.message : 'Не удалось составить лист');
    } finally {
      setGenerating(null);
    }
  }

  async function handleVoiceOver(sheetId: string) {
    try {
      const updated = await generateCompromiseSheetVoiceOver(sheetId);
      setSheets((prev) => prev.map((s) => (s.id === sheetId ? updated : s)));
      if (updated.audioBase64) {
        new Audio(`data:audio/mpeg;base64,${updated.audioBase64}`).play();
      }
      haptic('success');
    } catch {
      haptic('error');
    }
  }

  async function handleMarkPreviewed(sheetId: string) {
    try {
      const updated = await markCompromiseSheetPreviewed(sheetId);
      setSheets((prev) => prev.map((s) => (s.id === sheetId ? updated : s)));
      haptic('light');
    } catch {
      haptic('error');
    }
  }

  async function handleStartShare(sheet: CompromiseSheet) {
    setSharingSheetId(sheet.id);
    setShareState('scanning');
    setShareError(null);
    try {
      const text = sheet.items.map((i) => `— ${i.argument.text}`).join('\n');
      const result = await safeSharePreflight(text, 'compromise-sheet', projectId);
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
    if (!safeShareActionId || !sharingSheetId) return;
    try {
      await safeShareConfirm(safeShareActionId);
      const updated = await markCompromiseSheetSentToFigurant(sharingSheetId);
      setSheets((prev) => prev.map((s) => (s.id === sharingSheetId ? updated : s)));
      haptic('light');
      shareViaTelegram(previewText);
      setShareState('idle');
      setSharingSheetId(null);
    } catch (err) {
      setShareError(err instanceof Error ? err.message : 'Не удалось подтвердить отправку');
      setShareState('error');
    }
  }

  function handleCancelShare() {
    setShareState('idle');
    setSharingSheetId(null);
    setSafeShareActionId(null);
  }

  if (loading) return null;

  return (
    <section className="compromise-sheet-section">
      <h3>Компромиссный лист</h3>
      <p className="conversations-section__hint">
        Конкретные пункты для переговоров — 🟡 рекомендация, не факт. Отправляется только в виде аргументов, без
        приватных фактов/файлов.
      </p>

      {sheets.map((sheet) => (
        <div key={sheet.id} className="compromise-sheet-section__sheet">
          <p className="steelman-case__label">{sheet.phase === 'BEFORE' ? 'До тренировки' : 'После тренировки'}</p>
          <ul className="compromise-sheet-section__items">
            {sheet.items.map((item) => (
              <li key={item.id}>{item.argument.text}</li>
            ))}
          </ul>

          {sharingSheetId === sheet.id && shareState !== 'idle' ? (
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
          ) : recordingForSheetId === sheet.id ? (
            <UserVoiceRecordingSection
              sheet={sheet}
              onSaved={(updated) => {
                setSheets((prev) => prev.map((s) => (s.id === updated.id ? updated : s)));
                setRecordingForSheetId(null);
              }}
              onClose={() => setRecordingForSheetId(null)}
            />
          ) : (
            <div className="conversations-section__add-actions">
              <button type="button" onClick={() => handleVoiceOver(sheet.id)}>
                {sheet.audioGenerated ? '🔊 Прослушать снова' : '🔊 Озвучить'}
              </button>
              <button type="button" onClick={() => setRecordingForSheetId(sheet.id)}>
                🎤 Своим голосом
              </button>
              {!sheet.previewedByUser && (
                <button type="button" onClick={() => handleMarkPreviewed(sheet.id)}>
                  Отметить просмотренным
                </button>
              )}
              {sheet.sentToFigurant ? (
                <span className="conversations-section__hint">✓ Отправлено</span>
              ) : (
                <button type="button" onClick={() => handleStartShare(sheet)} disabled={!sheet.previewedByUser}>
                  Отправить фигуранту
                </button>
              )}
            </div>
          )}
        </div>
      ))}

      {error && <p className="generation-error">{error}</p>}
      <div className="conversations-section__add-actions">
        <button type="button" onClick={() => handleGenerate('BEFORE')} disabled={generating !== null}>
          {generating === 'BEFORE' ? 'Составляем…' : 'Составить лист до тренировки'}
        </button>
        <button type="button" onClick={() => handleGenerate('AFTER')} disabled={generating !== null || !hasDialogue}>
          {generating === 'AFTER' ? 'Составляем…' : 'Составить лист после тренировки'}
        </button>
      </div>
    </section>
  );
}
