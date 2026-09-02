'use client';

// MVP-фича 11 (§3.47 ТЗ) — единый экран управления данными.
// Честно показывает только то, что реально существует: согласия,
// проекты (счётчик), персоны с правом на удаление, экспорт данных.

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import {
  getPrivacyOverview,
  deletePersonData,
  exportPrivacyData,
  deleteAccount,
  AccountDeletionResult,
  revokeConsent,
  getSafeShareLog,
  getRetentionClasses,
} from '../../lib/features';
import { PrivacyOverview, SafeShareLogEntry, RetentionClassInfo, ConsentType } from '../../lib/types';
import { useBackButton } from '../../hooks/useBackButton';
import { haptic } from '../../lib/telegram';
import { OnboardingForm } from '../../components/OnboardingForm';

export default function PrivacyPage() {
  const [deleteConfirm, setDeleteConfirm] = useState('');
  const [deleting, setDeleting] = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);
  const [deletionResult, setDeletionResult] = useState<AccountDeletionResult | null>(null);
  const router = useRouter();
  const [overview, setOverview] = useState<PrivacyOverview | null>(null);
  const [safeShareLog, setSafeShareLog] = useState<SafeShareLogEntry[]>([]);
  const [retentionClasses, setRetentionClasses] = useState<RetentionClassInfo[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [confirmingDeleteId, setConfirmingDeleteId] = useState<string | null>(null);
  const [exporting, setExporting] = useState(false);

  const { isTelegramAvailable } = useBackButton(() => router.push('/'));

  function load() {
    return Promise.all([
      getPrivacyOverview().then(setOverview),
      getSafeShareLog().then(setSafeShareLog),
      getRetentionClasses().then(setRetentionClasses),
    ]).catch((err) => setError(err instanceof Error ? err.message : 'Не удалось загрузить данные'));
  }

  useEffect(() => {
    void load().finally(() => setLoading(false));

  }, []);

  async function handleDeletePerson(personId: string) {
    if (confirmingDeleteId !== personId) {
      setConfirmingDeleteId(personId);
      return;
    }
    try {
      await deletePersonData(personId);
      setConfirmingDeleteId(null);
      await load();
      haptic('success');
    } catch (err) {
      haptic('error');
      setError(err instanceof Error ? err.message : 'Не удалось удалить');
    }
  }

  async function handleRevokeConsent(type: ConsentType) {
    try {
      await revokeConsent(type);
      await load();
      haptic('success');
    } catch (err) {
      haptic('error');
      setError(err instanceof Error ? err.message : 'Не удалось отозвать согласие');
    }
  }

  async function handleExport() {
    setExporting(true);
    try {
      const data = await exportPrivacyData();
      const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = url;
      link.download = 'devils-advocate-export.json';
      link.click();
      URL.revokeObjectURL(url);
      haptic('success');
    } catch (err) {
      haptic('error');
      setError(err instanceof Error ? err.message : 'Не удалось экспортировать данные');
    } finally {
      setExporting(false);
    }
  }

  if (loading) return <main className="page">Загрузка…</main>;

  return (
    <main className="page">
      {!isTelegramAvailable && (
        <p>
          <Link href="/">← Главная</Link>
        </p>
      )}

      <h1>Приватность</h1>
      {error && <p className="generation-error">{error}</p>}

      <OnboardingForm />

      <section className="card-section">
        <h3>Согласия</h3>
        {overview && overview.consents.length > 0 ? (
          <ul className="card-argument-list">
            {overview.consents.map((c) => (
              <li key={c.id} className="privacy-row">
                <span>{c.consentType}</span>
                <button type="button" onClick={() => handleRevokeConsent(c.consentType)}>
                  Отозвать
                </button>
              </li>
            ))}
          </ul>
        ) : (
          <p className="card-section__empty">Активных согласий нет</p>
        )}
      </section>

      <section className="card-section">
        <h3>Проекты</h3>
        <p>
          Всего проектов: {overview?.projectsCount ?? 0}. Удаление отдельного проекта — на его
          странице.
        </p>
      </section>

      <section className="card-section">
        <h3>Люди, о которых собраны данные</h3>
        {overview && overview.people.length > 0 ? (
          <ul className="card-argument-list">
            {overview.people.map((p) => (
              <li key={p.id} className="privacy-row">
                <span>
                  {p.displayName ?? 'Без имени'} — {p.factsCount} фактов, {p.projectsCount} проектов
                </span>
                <button
                  type="button"
                  className={confirmingDeleteId === p.id ? 'privacy-delete-confirm' : ''}
                  onClick={() => handleDeletePerson(p.id)}
                >
                  {confirmingDeleteId === p.id ? 'Точно удалить?' : 'Удалить всё'}
                </button>
              </li>
            ))}
          </ul>
        ) : (
          <p className="card-section__empty">Пока нет ни одного человека</p>
        )}
      </section>

      <section className="card-section">
        <h3>Как долго хранятся данные</h3>
        <p className="retention-note">
          Это декларация политики продукта, не автоматическое удаление — сейчас данные
          удаляются только вручную, через действия в этом разделе.
        </p>
        {retentionClasses.length > 0 ? (
          <ul className="card-argument-list">
            {retentionClasses.map((rc) => (
              <li key={rc.classKey} className="retention-row">
                <span className="retention-row__title">{rc.displayName}</span>
                <span className="retention-row__period">
                  {rc.defaultRetentionDays !== null ? `${rc.defaultRetentionDays} дней` : 'Бессрочно'}
                </span>
              </li>
            ))}
          </ul>
        ) : (
          <p className="card-section__empty">Справочник политик пуст</p>
        )}
      </section>

      <section className="card-section">
        <h3>Экспорт данных</h3>
        <button type="button" onClick={handleExport} disabled={exporting}>
          {exporting ? 'Готовим файл…' : 'Скачать все мои данные'}
        </button>
      </section>

      <section className="card-section">
        <h3>Журнал Safe Share</h3>
        {safeShareLog.length > 0 ? (
          <ul className="card-argument-list">
            {safeShareLog.map((entry) => (
              <li key={entry.id} className="privacy-row">
                <span>
                  {entry.contentType} — {entry.sentAt ? 'отправлено' : 'только просмотрено'}
                  {entry.detectedItemsCount > 0 && `, скрыто элементов: ${entry.detectedItemsCount}`}
                </span>
              </li>
            ))}
          </ul>
        ) : (
          <p className="card-section__empty">Пока ничего не отправлялось через Safe Share</p>
        )}
      </section>

      <section className="card-section" style={{ borderColor: '#d33' }}>
        <h3>Удалить аккаунт и все данные</h3>
        <p className="card-section__empty">
          Проекты, разговоры и транскрипты, люди и факты о них, согласия, доказательства ДТП, анализы, профили кандидатов, intake-сессии — всё удаляется безвозвратно. Команды и группы без вас останутся. Копии транскриптов у STT-провайдера хранятся по его политике; у нас остаётся только обезличенная запись в журнале аудита.
        </p>
        {deletionResult ? (
          <div className="dtp-status dtp-status--ok">
            Аккаунт удалён. Удалено: {Object.entries(deletionResult.removed).map(([k, v]) => `${k}: ${v}`).join(', ')}.
            {deletionResult.externalArtifacts.failed > 0 && ` Не удалось удалить файлов во внешнем хранилище: ${deletionResult.externalArtifacts.failed} — напишите нам, удалим вручную.`}
            <br />При следующем открытии приложение начнёт с чистого листа.
          </div>
        ) : (
          <>
            <label className="entity-form__field">
              <span>Чтобы подтвердить, введите слово УДАЛИТЬ</span>
              <input value={deleteConfirm} onChange={(e) => setDeleteConfirm(e.target.value)} placeholder="УДАЛИТЬ" />
            </label>
            {deleteError && <p className="generation-error">{deleteError}</p>}
            <button type="button" className="secondary" style={{ borderColor: '#d33', color: '#d33' }} disabled={deleting || deleteConfirm.trim().toUpperCase() !== 'УДАЛИТЬ'}
              onClick={async () => {
                if (!window.confirm('Это необратимо. Удалить аккаунт и все данные?')) return;
                setDeleting(true); setDeleteError(null);
                try { setDeletionResult(await deleteAccount()); haptic('success'); }
                catch (e) { haptic('error'); setDeleteError(e instanceof Error ? e.message : 'Не удалось удалить'); }
                finally { setDeleting(false); }
              }}>{deleting ? 'Удаляем…' : 'Удалить аккаунт'}</button>
          </>
        )}
      </section>
    </main>
  );
}
