// Пункт [prompt-framework]: EvaluationService
// (devils-advocate-prompt-framework-tz.md, §4.1/§4.2, §5.2) —
// классификационный и структурный evaluation gate. Калибровочный gate
// (§4.3) — ОТДЕЛЬНЫЙ сервис (CalibrationService), принципиально другая
// механика (реальные накопленные исходы, не фиксированный датасет с
// заранее размеченными кейсами) — см. обоснование в самом ТЗ, раздел 4.

import { BadRequestException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { AIRouterService } from '../ai-router/ai-router.service';
import { EvaluationRunStatus, EvaluationSubjectType } from '@prisma/client';

interface EvaluationCaseInput {
  input: string;
  expectedOutput?: unknown;
  caseType: 'classification' | 'structural';
}

// Стартовые пороги — ТЗ §4.1/§4.2, буквально зафиксированы как
// стартовые значения, калибруются по факту первого реального прогона
// (ТЗ, раздел 7 "что сознательно не входит").
const FALSE_POSITIVE_THRESHOLD_STRONG_DISCREPANCY = 0.05;
const ALTERNATIVE_EXPLANATION_COMPLETENESS_THRESHOLD = 1.0; // 100%, ТЗ §4.2: "иначе gate не пройден", не процент с запасом
const MIN_CLASSIFICATION_DATASET_SIZE = 40; // ТЗ §4.1

@Injectable()
export class EvaluationService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly aiRouter: AIRouterService,
  ) {}

  private async assertOperator(userId: string) {
    const user = await this.prisma.user.findUnique({ where: { id: userId }, select: { isOperator: true } });
    if (!user?.isOperator) {
      throw new ForbiddenException('Требуется роль оператора');
    }
  }

  async createDataset(userId: string, name: string, version: string, description?: string) {
    await this.assertOperator(userId);
    return this.prisma.evaluationDataset.create({ data: { name, version, description } });
  }

  async addCases(userId: string, evaluationDatasetId: string, cases: EvaluationCaseInput[]) {
    await this.assertOperator(userId);
    const dataset = await this.prisma.evaluationDataset.findUnique({ where: { id: evaluationDatasetId } });
    if (!dataset) {
      throw new NotFoundException(`EvaluationDataset ${evaluationDatasetId} not found`);
    }
    if (cases.length === 0) {
      throw new BadRequestException('cases must not be empty');
    }
    return Promise.all(
      cases.map((c) =>
        this.prisma.evaluationCase.create({
          data: {
            evaluationDatasetId,
            input: c.input,
            expectedOutput: c.expectedOutput as any,
            caseType: c.caseType,
          },
        }),
      ),
    );
  }

  // ТЗ §5.2: "Запустить прогон — только для caseType: classification/
  // structural, не для калибровки (§4.3, отдельный механизм)".
  async evaluate(userId: string, promptVersionId: string, evaluationDatasetId: string) {
    await this.assertOperator(userId);

    const promptVersion = await this.prisma.promptVersion.findUnique({ where: { id: promptVersionId } });
    if (!promptVersion) {
      throw new NotFoundException(`PromptVersion ${promptVersionId} not found`);
    }
    const dataset = await this.prisma.evaluationDataset.findUnique({
      where: { id: evaluationDatasetId },
      include: { cases: true },
    });
    if (!dataset) {
      throw new NotFoundException(`EvaluationDataset ${evaluationDatasetId} not found`);
    }
    if (dataset.cases.length === 0) {
      throw new BadRequestException(`EvaluationDataset ${evaluationDatasetId} has no cases — nothing to run`);
    }

    const caseType = dataset.cases[0].caseType;
    if (dataset.cases.some((c: any) => c.caseType !== caseType)) {
      throw new BadRequestException('EvaluationDataset must contain cases of a single caseType per run');
    }
    if (caseType !== 'classification' && caseType !== 'structural') {
      throw new BadRequestException(
        `caseType "${caseType}" is not runnable via evaluate() — calibration (§4.3) uses a separate mechanism, not EvaluationDataset`,
      );
    }
    if (caseType === 'classification' && dataset.cases.length < MIN_CLASSIFICATION_DATASET_SIZE) {
      throw new BadRequestException(
        `Classification dataset has ${dataset.cases.length} cases, minimum is ${MIN_CLASSIFICATION_DATASET_SIZE} (ТЗ §4.1) — too few for a statistically valid production decision`,
      );
    }

    const run = await this.prisma.evaluationRun.create({
      data: {
        subjectType: EvaluationSubjectType.PROMPT_VERSION,
        promptVersionId,
        evaluationDatasetId,
        status: EvaluationRunStatus.RUNNING,
      },
    });

    try {
      if (caseType === 'classification') {
        await this.runClassification(userId, run.id, promptVersion, dataset.cases as any[]);
      } else {
        await this.runStructural(userId, run.id, promptVersion, dataset.cases as any[]);
      }
      await this.prisma.evaluationRun.update({
        where: { id: run.id },
        data: { status: EvaluationRunStatus.COMPLETED, completedAt: new Date() },
      });
    } catch (err) {
      await this.prisma.evaluationRun.update({
        where: { id: run.id },
        data: { status: EvaluationRunStatus.FAILED, completedAt: new Date() },
      });
      throw err;
    }

    return this.getRun(userId, run.id);
  }

  // ТЗ §4.1 — классификация: precision/recall/false_positive_rate
  // прямым сравнением actualOutput с expectedOutput.label.
  private async runClassification(userId: string, runId: string, promptVersion: any, cases: any[]) {
    let truePositive = 0;
    let falsePositive = 0;
    let falseNegative = 0;
    let strongDiscrepancyFalsePositive = 0;

    for (const evalCase of cases) {
      const expectedLabel = (evalCase.expectedOutput as any)?.label;
      let actualLabel: string | null = null;
      let actualOutputText = '';

      try {
        const result = await this.aiRouter.execute({
          userId,
          taskType: promptVersion.promptId,
          promptVersionId: promptVersion.id,
          systemPrompt: promptVersion.template,
          userPrompt: evalCase.input,
          jsonMode: true,
          maxTokens: 300,
        });
        actualOutputText = result.text;
        const parsed = JSON.parse(result.text);
        actualLabel = parsed.label ?? null;
      } catch {
        // Честная деградация: сбой AI-вызова или невалидный JSON —
        // кейс засчитывается провальным (passed=false), не пропускается
        // молча — сбой на evaluation-прогоне сам по себе информативен.
        actualOutputText = actualOutputText || '(AI call failed or returned invalid JSON)';
      }

      const passed = actualLabel === expectedLabel;
      // false positive для strong_discrepancy: детектор сказал
      // strong_discrepancy, а на самом деле не было
      if (actualLabel === 'strong_discrepancy' && expectedLabel !== 'strong_discrepancy') {
        strongDiscrepancyFalsePositive++;
      }
      if (actualLabel === expectedLabel && expectedLabel !== 'none') truePositive++;
      if (actualLabel !== 'none' && actualLabel !== expectedLabel) falsePositive++;
      if (actualLabel === 'none' && expectedLabel !== 'none') falseNegative++;

      await this.prisma.evaluationCaseResult.create({
        data: {
          evaluationRunId: runId,
          evaluationCaseId: evalCase.id,
          actualOutput: actualOutputText,
          passed,
          note: passed ? null : `expected label="${expectedLabel}", got="${actualLabel}"`,
        },
      });
    }

    const precision = truePositive + falsePositive > 0 ? truePositive / (truePositive + falsePositive) : null;
    const recall = truePositive + falseNegative > 0 ? truePositive / (truePositive + falseNegative) : null;
    // false_positive_rate считается ИМЕННО для категории strong_discrepancy
    // (ТЗ §4.1: "обязательный порог false positive для strong_discrepancy",
    // не общий FPR по всем меткам сразу). Знаменатель — ВСЕ кейсы прогона,
    // не только кейсы с реальным expectedLabel !== strong_discrepancy
    // (классическое FP/(FP+TN)) — выбор сделан при реализации, чтобы точно
    // воспроизвести числа acceptance-теста ТЗ §6.2 буквально (3 ложных
    // срабатывания из 40 кейсов датасета → 0.075), а не строгое FP/TN,
    // которое ТЗ явно не определяет. Аудит нашёл и убрал более раннюю
    // версию этой формулы, где отдельно накапливался strongDiscrepancyTotal
    // ради условия "posted > 0 ? ... : 0" — условие было математическим
    // no-op (x/(n||1) уже равно 0 при x=0 независимо от условия), мертвый
    // код удалён, поведение не изменилось.
    const strongDiscrepancyFpr = strongDiscrepancyFalsePositive / (cases.length || 1);

    const fprPassed = strongDiscrepancyFpr <= FALSE_POSITIVE_THRESHOLD_STRONG_DISCREPANCY;

    const fprMetric = await this.findOrCreateMetric('false_positive_rate');
    await this.prisma.evaluationResult.create({
      data: {
        evaluationRunId: runId,
        evaluationMetricId: fprMetric.id,
        value: strongDiscrepancyFpr,
        threshold: FALSE_POSITIVE_THRESHOLD_STRONG_DISCREPANCY,
        passed: fprPassed,
      },
    });

    if (precision !== null) {
      const precisionMetric = await this.findOrCreateMetric('precision');
      await this.prisma.evaluationResult.create({
        data: { evaluationRunId: runId, evaluationMetricId: precisionMetric.id, value: precision, passed: true },
      });
    }
    if (recall !== null) {
      const recallMetric = await this.findOrCreateMetric('recall');
      await this.prisma.evaluationResult.create({
        data: { evaluationRunId: runId, evaluationMetricId: recallMetric.id, value: recall, passed: true },
      });
    }

    await this.prisma.releaseGate.create({
      data: { evaluationRunId: runId, passed: fprPassed, gateType: 'prompt_promotion', decidedBy: 'system' },
    });
  }

  // ТЗ §4.2 — структурная проверка: доля сгенерированных гипотез, где
  // alternativeExplanation непустой, порог 100% буквально.
  private async runStructural(userId: string, runId: string, promptVersion: any, cases: any[]) {
    let totalHypotheses = 0;
    let completeHypotheses = 0;

    for (const evalCase of cases) {
      let actualOutputText = '';
      let hypotheses: Array<{ explanation?: string; alternativeExplanation?: string }> = [];

      try {
        const result = await this.aiRouter.execute({
          userId,
          taskType: promptVersion.promptId,
          promptVersionId: promptVersion.id,
          systemPrompt: promptVersion.template,
          userPrompt: evalCase.input,
          jsonMode: true,
          maxTokens: 800,
        });
        actualOutputText = result.text;
        const parsed = JSON.parse(result.text);
        hypotheses = Array.isArray(parsed) ? parsed : (parsed.hypotheses ?? []);
      } catch {
        actualOutputText = actualOutputText || '(AI call failed or returned invalid JSON)';
      }

      let missingIndex: number | null = null;
      hypotheses.forEach((h, i) => {
        totalHypotheses++;
        if (h.alternativeExplanation && h.alternativeExplanation.trim().length > 0) {
          completeHypotheses++;
        } else if (missingIndex === null) {
          missingIndex = i;
        }
      });

      const casePassed = missingIndex === null && hypotheses.length > 0;
      await this.prisma.evaluationCaseResult.create({
        data: {
          evaluationRunId: runId,
          evaluationCaseId: evalCase.id,
          actualOutput: actualOutputText,
          passed: casePassed,
          note: casePassed
            ? null
            : hypotheses.length === 0
              ? 'no hypotheses generated'
              : `hypothesis #${missingIndex} missing alternativeExplanation`,
        },
      });
    }

    const completeness = totalHypotheses > 0 ? completeHypotheses / totalHypotheses : 0;
    const passed = completeness >= ALTERNATIVE_EXPLANATION_COMPLETENESS_THRESHOLD;

    const metric = await this.findOrCreateMetric('alternative_explanation_completeness');
    await this.prisma.evaluationResult.create({
      data: {
        evaluationRunId: runId,
        evaluationMetricId: metric.id,
        value: completeness,
        threshold: ALTERNATIVE_EXPLANATION_COMPLETENESS_THRESHOLD,
        passed,
      },
    });

    await this.prisma.releaseGate.create({
      data: { evaluationRunId: runId, passed, gateType: 'prompt_promotion', decidedBy: 'system' },
    });
  }

  async getRun(userId: string, id: string) {
    await this.assertOperator(userId);
    const run = await this.prisma.evaluationRun.findUnique({
      where: { id },
      include: {
        results: { include: { evaluationMetric: true } },
        caseResults: true,
        releaseGate: true,
      },
    });
    if (!run) {
      throw new NotFoundException(`EvaluationRun ${id} not found`);
    }
    return {
      ...run,
      failedCases: run.caseResults.filter((c: any) => !c.passed),
    };
  }

  private async findOrCreateMetric(name: string) {
    const existing = await this.prisma.evaluationMetric.findUnique({ where: { name } });
    if (existing) return existing;
    return this.prisma.evaluationMetric.create({ data: { name } });
  }
}
