'use client';

// Пункт 61 (backend) → TMA UI: импорт текстовой переписки (§3.29 ТЗ).
// Пункт 88 расширил на Telegram JSON-экспорт и одно .eml-письмо —
// формат определяется по расширению файла, backend полностью
// формат-независим (принимает уже разобранный {sender, text,
// timestampMs}[], не сырой текст экспорта — см. обоснование выбора
// формата в lib/chat-import-parse.ts). Создаёт обычный Conversation
// — появится в списке ConversationsSection.tsx при следующей
// загрузке, отдельная детальная страница здесь не нужна.

import { useState } from 'react';
import type { ChangeEvent } from 'react';
import { importChat } from '../lib/features';
import { parseWhatsAppExport, parseTelegramExport, parseEmlFile } from '../lib/chat-import-parse';
import { haptic } from '../lib/telegram';

interface ChatImportSectionProps {
  projectId: string;
  onImported?: () => void;
}

export function ChatImportSection({ projectId, onImported }: ChatImportSectionProps) {
  const [parsedMessages, setParsedMessages] = useState<{ sender: string; text: string; timestampMs: number }[] | null>(null);
  const [senders, setSenders] = useState<string[]>([]);
  const [selfSender, setSelfSender] = useState('');
  const [fileName, setFileName] = useState('');
  const [importing, setImporting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState(false);

  async function handleFileSelected(e: ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;

    setError(null);
    setSuccess(false);
    const text = await file.text();

    // Пункт 88 — определяем формат по расширению файла, не по
    // содержимому (проще и честнее гадать по содержимому: .json может
    // быть чем угодно, но раз пользователь выбрал .json в этом
    // диалоге — это ожидаемо Telegram-экспорт).
    const lowerName = file.name.toLowerCase();
    let messages;
    let distinctSenders;
    if (lowerName.endsWith('.json')) {
      ({ messages, distinctSenders } = parseTelegramExport(text));
    } else if (lowerName.endsWith('.eml')) {
      const single = parseEmlFile(text);
      messages = single ? [single] : [];
      distinctSenders = single ? [single.sender] : [];
    } else {
      ({ messages, distinctSenders } = parseWhatsAppExport(text));
    }

    if (messages.length === 0) {
      setError('Не удалось распознать ни одного сообщения — поддерживается .txt-экспорт WhatsApp, .json-экспорт Telegram, .eml-письмо.');
      return;
    }

    setParsedMessages(messages);
    setSenders(distinctSenders);
    setSelfSender(distinctSenders[0] ?? '');
    setFileName(file.name);
  }

  async function handleConfirmImport() {
    if (!parsedMessages || !selfSender) return;
    setImporting(true);
    setError(null);
    try {
      await importChat(projectId, { messages: parsedMessages, selfSenderName: selfSender, rawFileRef: fileName });
      setParsedMessages(null);
      setSenders([]);
      setSuccess(true);
      haptic('success');
      onImported?.();
    } catch (err) {
      haptic('error');
      setError(err instanceof Error ? err.message : 'Не удалось импортировать переписку');
    } finally {
      setImporting(false);
    }
  }

  return (
    <section className="chat-import-section">
      <h3>Импорт переписки</h3>
      <p className="conversations-section__hint">
        Экспорт чата WhatsApp (.txt), Telegram (.json, «Экспортировать историю чата») или одно письмо (.eml) —
        файл обрабатывается на устройстве, на сервер уходит только разобранный текст сообщений, дальше с ним
        работает тот же разбор, что и с записанными разговорами. Для email — цепочка из нескольких писем
        загружается по одному .eml-файлу за раз.
      </p>

      {!parsedMessages && (
        <div className="conversations-section__add">
          <label>
            Файл экспорта (.txt / .json / .eml)
            <input type="file" accept=".txt,.json,.eml" onChange={handleFileSelected} />
          </label>
          {error && <p className="generation-error">{error}</p>}
          {success && <p className="conversations-section__hint">✓ Переписка импортирована.</p>}
        </div>
      )}

      {parsedMessages && (
        <div className="conversations-section__add">
          <p className="conversations-section__hint">
            Распознано сообщений: {parsedMessages.length}. Укажите, кто из отправителей — вы.
          </p>
          <label>
            Это вы
            <select value={selfSender} onChange={(e) => setSelfSender(e.target.value)}>
              {senders.map((s) => (
                <option key={s} value={s}>
                  {s}
                </option>
              ))}
            </select>
          </label>
          {error && <p className="generation-error">{error}</p>}
          <div className="conversations-section__add-actions">
            <button type="button" onClick={handleConfirmImport} disabled={importing}>
              {importing ? 'Импортируем…' : 'Подтвердить импорт'}
            </button>
            <button type="button" onClick={() => setParsedMessages(null)} disabled={importing}>
              Отмена
            </button>
          </div>
        </div>
      )}
    </section>
  );
}
