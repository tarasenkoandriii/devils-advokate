// Пункт [criteria-comparison] (devils-advocate-family-law-v2-tz.md §3.5 —
// амендмент до devils-advocate-dtp-v2-tz.md §3.7/5.6/6): спільний,
// ДОМЕННО-АГНОСТИЧНИЙ сервіс зіставлення слів між джерелами.
//
// Форма {criterionId, whatWasSaid, sourceSegmentId} підтверджена
// byte-for-byte ідентичною в трьох незалежно написаних реалізаціях
// (DTP/family-law/health) — конвергенція без форсування, на відміну
// від DtpFaultDetermination/FamilyLawStatusDetermination, які НЕ
// уніфіковані через розбіжність `source` (задокументовано в
// devils-advocate-family-law-v2-tz.md §0).
//
// НАЙВАЖЛИВІШЕ ОБМЕЖЕННЯ: AI тут порівнює ДВА чи більше формулювань
// і позначає, що вони РОЗХОДЯТЬСЯ — ніколи не визначає, яке з них
// правдиве. Той самий принцип "радник, не суддя", розширений на
// порівняльний рівень, доменно-незалежний (заборона не потребує
// знання, ДТП це чи розлучення чи консультація лікаря).

import { BadGatewayException, ForbiddenException, Injectable } from '@nestjs/common';
import { AIRouterService, AIRouterContentBlockedError } from '../ai-router/ai-router.service';

export type CrossConsultationStatus = 'NO_DISCREPANCY_FOUND' | 'DISCREPANCY_FOUND' | 'INSUFFICIENT_DATA';

// Той самий рядок, що вже вжитий у system prompt DtpService/FamilyLawService/
// HealthService generateBreakdown() ("Якщо фахівець взагалі не торкнувся
// критерію — чесно напиши..."). Експортується звідси, щоб фільтрація в
// crossConsultationCheck (DtpV2Service/FamilyLawV2Service) використовувала
// той самий рядок, не окрему копію, що могла б розійтись.
export const NOT_DISCUSSED_PLACEHOLDER = 'не піднімалось у розмові';

export interface StatementSource {
  consultationId: string;
  sourceLabel: string; // наприклад ім'я/label консультанта — доменно-нейтральна назва
  whatWasSaid: string;
  sourceSegmentId?: string | null;
}

export interface CrossConsultationCheckResult {
  status: CrossConsultationStatus;
  statements: StatementSource[];
  discrepancyNote?: string;
}

interface RawComparison {
  hasDiscrepancy: boolean;
  discrepancyNote?: string;
}

function isValidComparison(text: string): boolean {
  try {
    const parsed = JSON.parse(text);
    return typeof parsed?.hasDiscrepancy === 'boolean';
  } catch {
    return false;
  }
}

// Доменно-агностичний — заборона "ніколи не визначай, яке твердження
// правдиве" не потребує знання предметної області.
const COMPARISON_SYSTEM_PROMPT =
  'Тебе дано кілька тверджень різних джерел про той самий критерій — кожне почато позначкою джерела. ' +
  'Визнач, чи ці твердження СУТТЄВО суперечать одне одному по суті (не стилістично, не за деталізацією). ' +
  'КРИТИЧНО ВАЖЛИВО: НІКОЛИ не визначай, яке з тверджень правдиве чи достовірніше — тільки фіксуй сам факт розбіжності, нейтрально. ' +
  'Якщо суттєвих розбіжностей немає — hasDiscrepancy: false. ' +
  'Відповідай СТРОГО валідним JSON вида {"hasDiscrepancy": boolean, "discrepancyNote": string}. discrepancyNote — нейтральний опис розбіжності (порожній рядок, якщо hasDiscrepancy=false). Без пояснень поза JSON.';

@Injectable()
export class CriteriaComparisonService {
  constructor(private readonly aiRouter: AIRouterService) {}

  /** statements — усі твердження РІЗНИХ консультацій для ОДНОГО
   * критерію, вже зібрані й відфільтровані (непорожній whatWasSaid)
   * викликаючим кодом — сервіс сам не звертається до жодної БД,
   * доменно-незалежний. */
  async compare(userId: string, projectId: string, taskType: string, statements: StatementSource[]): Promise<CrossConsultationCheckResult> {
    // §3.7 ТЗ (devils-advocate-dtp-v2-tz.md) — чесна деградація за
    // браком даних: менше двох джерел — немає з чим порівнювати.
    if (statements.length < 2) {
      return { status: 'INSUFFICIENT_DATA', statements };
    }

    const userPrompt = statements
      .map((s, i) => `[Джерело ${i + 1}: ${s.sourceLabel}] ${s.whatWasSaid}`)
      .join('\n');

    let result;
    try {
      result = await this.aiRouter.execute({
        userId,
        projectId,
        taskType,
        systemPrompt: COMPARISON_SYSTEM_PROMPT,
        userPrompt,
        jsonMode: true,
        maxTokens: 1000,
        validateOutput: isValidComparison,
      });
    } catch (err) {
      if (err instanceof ForbiddenException) throw err;
      if (err instanceof AIRouterContentBlockedError) {
        // Чесна деградація — блокування контенту не повинно видаватись
        // за "розбіжностей не знайдено".
        return { status: 'INSUFFICIENT_DATA', statements };
      }
      throw new BadGatewayException('Не удалось сравнить утверждения — AI-провайдер недоступен или вернул некорректный ответ.');
    }

    const parsed: RawComparison = JSON.parse(result.text);
    if (!parsed.hasDiscrepancy) {
      return { status: 'NO_DISCREPANCY_FOUND', statements };
    }
    return { status: 'DISCREPANCY_FOUND', statements, discrepancyNote: parsed.discrepancyNote };
  }
}
