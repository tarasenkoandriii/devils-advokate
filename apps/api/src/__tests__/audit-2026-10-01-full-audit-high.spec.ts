// Полная сверка 2026-10-01 — ВЫСОКИЕ находки, закрытые в коде.
//
// Заход шёл шестью независимыми срезами (авторизация и охват маршрутов;
// целостность данных и одновременность; внешние провайдеры и отказы;
// клиенты и молчащий сбой; конфигурация и деплой; документация против
// кода) плюс отдельным срезом по модулю найма. Конфигурация и
// документация пришли практически чистыми — их класс закрыли прошлые
// заходы. Высокое нашлось там, где правило УЖЕ ЕСТЬ и применено не
// всюду; это повторяющаяся порода этого проекта, и каждая находка ниже
// названа парой «у кого стоит — у кого не стоит».
//
// Закрыто десять пунктов:
//   [one-fuse-where-the-neighbour-had-two]  — dev-вход TMA: один
//       предохранитель против двух у админки, на 540 маршрутах.
//   [the-second-line-skipped-the-hiring-side] — вторая линия запрета
//       выводов о людях отсутствовала во ВСЁМ модуле найма, а список
//       стоп-слов был только русским при украинских промптах.
//   [the-atomic-fix-stayed-on-one-path] — атомарное добавление
//       комментария сделали для публичного пути и не сделали для
//       внутреннего, к той же колонке; плюс у внутреннего не было
//       потолка вовсе.
//   [the-answer-was-typed-and-lost] — ответ квиза терялся в окне
//       шириной в вызов AI.
//   [two-profiles-one-consent] — две копии профиля из одной ссылки,
//       и вторая выпадала из обхода отзыва согласия.
//   [the-provider-spoke-english-to-the-person] — сырая англоязычная
//       строка провайдера уезжала человеку на экран, а оператор не
//       получал ничего.
//   [our-own-refusal-wore-a-provider-costume] — наш отказ «файл больше
//       25 МБ» выдавался за отказ всех провайдеров.
//   [the-secret-travelled-as-a-header] — секрет вебхука распознавания
//       уезжал провайдеру как значение заголовка без проверки формата.
//   [the-outcome-reached-one-route-of-three] — текст о последствиях
//       отзыва согласия, построенный из исхода, доехал до одного
//       маршрута из трёх.
//   [loading-never-ended] — отказ загрузки рисовался как «Загрузка…»
//       навсегда.
//
// ЧЕГО ЭТА СПЕКА НЕ ПРОВЕРЯЕТ. Одновременность не воспроизводится
// тестом: проверяется, что запись идёт ОДНИМ оператором (или внутри
// транзакции с условным забором), а не что два параллельных вызова
// действительно не мешают друг другу. Так же устроены и прошлые
// проверки атомарности в этом проекте, и так же честно это названо у
// них: «проверять на этом уровне семантику изоляции было бы враньём».

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { UnauthorizedException } from '@nestjs/common';
import { isDevAuthAllowed } from '../admin-auth/dev-login';
import { TelegramAuthGuard } from '../telegram-auth/telegram-auth.guard';
import {
  PERSON_VERDICT_GUARDED,
  PERSON_VERDICT_NOT_GUARDED,
  hasPersonVerdict,
} from '../common/no-person-verdict';
import { sttSecretProblem } from '../common/webhook/stt-secret-format';
import { revocationAlsoDone, revocationDoesNotUndo, CANDIDATE_REVOCATION_EFFECTS } from '../interview-pool/revocation-report';
import { failureText } from '../ai-router/failure-reason';

const SRC = join(__dirname, '..');
const read = (rel: string): string => readFileSync(join(SRC, rel), 'utf8');
const readRoot = (rel: string): string => readFileSync(join(SRC, '..', '..', '..', rel), 'utf8');

/** Текст без комментариев: иначе проверка «так написано в коде»
 *  зеленеет на закомментированном коде — ловушка, в которую этот проект
 *  попадал многократно. */
function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
}

describe('[one-fuse-where-the-neighbour-had-two] dev-вход TMA держат ДВА предохранителя', () => {
  it('ALLOW_DEV_AUTH=true в проде не открывает вход', () => {
    expect(isDevAuthAllowed({ ALLOW_DEV_AUTH: 'true', NODE_ENV: 'production' })).toBe(false);
  });

  it('вне прода тот же флаг вход открывает — иначе локальная разработка встала бы', () => {
    expect(isDevAuthAllowed({ ALLOW_DEV_AUTH: 'true', NODE_ENV: 'development' })).toBe(true);
    expect(isDevAuthAllowed({ ALLOW_DEV_AUTH: 'true' })).toBe(true);
  });

  it('без флага не открывает нигде', () => {
    expect(isDevAuthAllowed({ NODE_ENV: 'development' })).toBe(false);
    expect(isDevAuthAllowed({ ALLOW_DEV_AUTH: 'false', NODE_ENV: 'development' })).toBe(false);
  });

  // ПОВЕДЕНЧЕСКАЯ проверка самого guard'а, а не только функции рядом с
  // ним. Первая версия этой спеки проверяла `isDevAuthAllowed` вызовом, а
  // у guard'а — только УПОМИНАНИЕ имени в исходнике; мутация
  // `if (!devAuthAllowed && false)` её ВЫЖИЛА. То есть проверялось, что
  // функцию позвали, а не что её ответ на что-то влияет.
  const makeConfig = (values: Record<string, string>): any => ({
    get: (key: string) => values[key],
    getOrThrow: (key: string) => {
      if (!(key in values)) throw new Error(`Missing config ${key}`);
      return values[key];
    },
  });
  const makeContext = (request: any): any => ({ switchToHttp: () => ({ getRequest: () => request }) });
  const prismaThatWouldAuthenticate = (): any => ({
    user: { upsert: async () => ({ id: 'u1', isRestricted: false, isBlocked: false, restrictedNote: null, restrictedAt: null, blockedNote: null, blockedAt: null }) },
  });

  it('в проде X-Dev-User-Id НЕ аутентифицирует, хотя ALLOW_DEV_AUTH=true', async () => {
    const guard = new TelegramAuthGuard(makeConfig({ ALLOW_DEV_AUTH: 'true', NODE_ENV: 'production' }), prismaThatWouldAuthenticate());
    const request: any = { headers: { 'x-dev-user-id': '42' } };
    await expect(guard.canActivate(makeContext(request))).rejects.toThrow(UnauthorizedException);
    // Главное — не тип исключения, а что userId не выдан.
    expect(request.userId).toBeUndefined();
  });

  it('вне прода тот же запрос проходит — иначе локальная разработка встала бы', async () => {
    const guard = new TelegramAuthGuard(makeConfig({ ALLOW_DEV_AUTH: 'true', NODE_ENV: 'development' }), prismaThatWouldAuthenticate());
    const request: any = { headers: { 'x-dev-user-id': '42' } };
    await expect(guard.canActivate(makeContext(request))).resolves.toBe(true);
    expect(request.userId).toBe('u1');
  });

  it('guard зовёт ту же функцию, а не повторяет условие своей копией', () => {
    const src = stripComments(read('telegram-auth/telegram-auth.guard.ts'));
    expect(src.includes('isDevAuthAllowed')).toBe(true);
    // Прежнее собственное условие в guard'е не осталось рядом с новым:
    // две проверки одного флага — ровно тот способ, которым он и
    // разъезжается (это сказано в шапке `dev-login.ts`).
    expect(src.includes("this.config.get<string>('ALLOW_DEV_AUTH') === 'true'")).toBe(false);
  });

  // Проба переписана после того, как сторож проекта
  // [probe-checked-the-neighbour] её ОТВЕРГ: она не трогала ни одного
  // имени, объявленного в этой спеке, то есть проверяла не ту же
  // машинерию, что ключевые тесты рядом. Теперь она идёт через тот же
  // guard и те же хелперы — и попутно стала сильнее: проверяет, что
  // «production» различается ТОЧНЫМ значением, а не любым похожим.
  it('обратная проба: guard различает именно продовое значение, а не любое похожее', async () => {
    const guard = new TelegramAuthGuard(makeConfig({ ALLOW_DEV_AUTH: 'true', NODE_ENV: 'prod' }), prismaThatWouldAuthenticate());
    const request: any = { headers: { 'x-dev-user-id': '42' } };
    await expect(guard.canActivate(makeContext(request))).resolves.toBe(true);
    expect(isDevAuthAllowed({ ALLOW_DEV_AUTH: 'true', NODE_ENV: 'production' })).toBe(false);
  });
});

describe('[the-second-line-skipped-the-hiring-side] вторая линия запрета выводов о людях', () => {
  it('русские формы ловятся — как и раньше', () => {
    expect(hasPersonVerdict('собеседник лжёт и манипулирует, типичный нарцисс')).toBe(true);
  });

  it('УКРАИНСКИЕ формы ловятся: модуль найма разговаривает с моделью по-украински', () => {
    for (const text of ['кандидат бреше про строки', 'типовий нарцис', 'соціопат', 'він брехун', 'нечесна людина']) {
      expect(hasPersonVerdict(text)).toBe(true);
    }
  });

  it('работа самого разбора выводом о личности не считается', () => {
    for (const text of [
      'потребує перевірки досвід у Kubernetes',
      'в этой реплике подмена тезиса',
      'описав проєкт без деталей, варто попросити приклад роботи',
    ]) {
      expect(hasPersonVerdict(text)).toBe(false);
    }
  });

  // ЧЕСТНО О ГРАНИЦЕ ЭТОЙ ПРОВЕРКИ. Поведение `isValidAssessment`
  // хотелось проверить вызовом — так в этом проекте и принято
  // (Пункт [finding-without-substance-2]: «спека вызывает сам валидатор,
  // а не ищет в его тексте слово»). Сделать этого здесь НЕЛЬЗЯ: импорт
  // этого валидатора тянет весь сервис, сервис тянет `@prisma/client`, а
  // сгенерированный клиент в рабочем дереве отстал от схемы
  // (`ClauseCoverage`, `EvidenceKind`, `TermsClauseKind` в нём
  // отсутствуют) и перегенерировать его в этой среде нечем — выход к
  // `binaries.prisma.sh` запрещён политикой egress. Поэтому ниже проверка
  // ПО ТЕКСТУ, и это сказано прямо, а не выдано за поведенческую.
  //
  // Поведение самого фильтра при этом проверено вызовами выше: на тех же
  // украинских формулировках, которые модель найма и возвращает. Чего не
  // хватает — связки «валидатор действительно отвергнет такой ответ»;
  // она появится первым же прогоном после `npx prisma generate`.
  it('валидатор разбора релевантности зовёт проверку ДО возврата true', () => {
    const src = stripComments(read('interview-pool/interview-pool-relevance.service.ts'));
    const check = src.indexOf('hasPersonVerdict(text)');
    const ret = src.indexOf('return parsed.criteriaBreakdown.every(');
    expect(check > 0).toBe(true);
    expect(ret > 0).toBe(true);
    expect(check < ret).toBe(true);
  });

  it('валидатор вывода по кандидату зовёт её тоже', () => {
    const src = stripComments(read('interview-pool/interview-pool-report.service.ts'));
    expect(src.includes('hasPersonVerdict(text)')).toBe(true);
  });

  it('реестр охватывает оба разбора модуля найма и перечисляет исключения с причинами', () => {
    const sites = PERSON_VERDICT_GUARDED.map((e) => e.site);
    expect(sites.some((s) => s.includes('interview-pool-relevance.service.ts'))).toBe(true);
    expect(sites.some((s) => s.includes('interview-pool-report.service.ts'))).toBe(true);
    expect(PERSON_VERDICT_NOT_GUARDED.length > 0).toBe(true);
    for (const entry of PERSON_VERDICT_NOT_GUARDED) {
      expect(entry.why.trim().length > 10).toBe(true);
    }
  });

  it('каждый файл из реестра действительно зовёт проверку — реестр не опись намерений', () => {
    for (const entry of PERSON_VERDICT_GUARDED) {
      const file = entry.site.split('#')[0];
      expect(stripComments(read(file)).includes('hasPersonVerdict')).toBe(true);
    }
  });

  it('обратная проба: файлы из списка исключений проверку НЕ зовут — иначе список врёт', () => {
    for (const entry of PERSON_VERDICT_NOT_GUARDED) {
      const file = entry.site.split('#')[0];
      expect(stripComments(read(file)).includes('hasPersonVerdict')).toBe(false);
    }
  });
});

describe('[the-atomic-fix-stayed-on-one-path] добавление комментария одно на оба пути', () => {
  const helper = stripComments(read('vacancy-posting/posting-review-comments.ts'));

  it('оператор атомарный: добавление и проверка потолка в одном UPDATE', () => {
    expect(helper.includes('UPDATE posting_review_shares')).toBe(true);
    expect(helper.includes('jsonb_array_length')).toBe(true);
  });

  it('оба пути зовут общую функцию, и ни один не собирает массив в памяти', () => {
    for (const file of ['vacancy-posting/vacancy-posting.service.ts', 'employer-hiring/engagement.service.ts']) {
      const src = stripComments(read(file));
      // Именно ВЫЗОВ, а не упоминание: мутация, оставившая импорт и
      // убравшая вызов, проверку на `includes` ВЫЖИЛА.
      expect(src.includes('appendPostingReviewComment(this.prisma')).toBe(true);
      expect(/comments:\s*comments as never/.test(src)).toBe(false);
    }
  });

  it('у внутреннего пути появился потолок — раньше его не было вовсе', () => {
    const src = stripComments(read('employer-hiring/engagement.service.ts'));
    expect(src.includes("assertUnderPublicWriteLimit('comments-per-posting-review'")).toBe(true);
  });

  it('обратная проба: сам оператор остался ровно в одном месте', () => {
    const inHelper = (read('vacancy-posting/posting-review-comments.ts').match(/UPDATE posting_review_shares/g) ?? []).length;
    const elsewhere = ['vacancy-posting/vacancy-posting.service.ts', 'employer-hiring/engagement.service.ts']
      .map((f) => (read(f).match(/UPDATE posting_review_shares/g) ?? []).length)
      .reduce((a, b) => a + b, 0);
    expect(inHelper).toBe(1);
    expect(elsewhere).toBe(0);
  });
});

describe('[the-answer-was-typed-and-lost] ответ квиза добавляется атомарно', () => {
  const src = stripComments(read('intake/intake.service.ts'));

  it('добавление — один оператор с jsonb-склейкой, а не запись массива целиком', () => {
    expect(src.includes('UPDATE intake_sessions')).toBe(true);
    expect(src.includes('jsonb_array_length')).toBe(true);
  });

  it('условие статуса стои́т В САМОМ операторе: завершённая сессия ответа не примет', () => {
    expect(/WHERE id = \$\{session\.id\}[\s\S]{0,120}status = 'IN_PROGRESS'/.test(src)).toBe(true);
  });

  it('массив ответов больше не записывается целиком', () => {
    expect(/data:\s*\{\s*answers:\s*answers as any/.test(src)).toBe(false);
  });

  it('обратная проба: создание сессии массив ПИШЕТ — там это первый ответ, и склеивать нечего', () => {
    expect(src.includes('answers: answers as any')).toBe(true);
  });
});

describe('[two-profiles-one-consent] одна ссылка — один профиль', () => {
  const src = stripComments(read('interview-pool/interview-pool-candidate.service.ts'));

  it('ссылка забирается условной записью внутри транзакции', () => {
    expect(src.includes('$transaction')).toBe(true);
    expect(/updateMany\(\{[\s\S]{0,160}acceptedAt: null/.test(src)).toBe(true);
  });

  it('проигравший получает тот же отказ, что и при последовательном повторе', () => {
    expect((src.match(/Эта ссылка уже была принята раньше/g) ?? []).length).toBe(2);
  });

  it('создание профиля идёт в той же транзакции — «ссылка сожжена, профиля нет» невозможно', () => {
    expect(/\$transaction\(async \(tx\) => \{[\s\S]{0,900}tx\.candidateProfile\.create/.test(src)).toBe(true);
  });

  it('обратная проба: соседний маршрут самошеринга тоже в транзакции — правило теперь у обоих', () => {
    expect(stripComments(read('candidate-self-share/candidate-self-share.service.ts')).includes('$transaction')).toBe(true);
  });
});

describe('[the-provider-spoke-english-to-the-person] человеку — наш текст, оператору — подробность', () => {
  const src = stripComments(read('ai-router/ai-router.service.ts'));

  it('две новых причины отказа существуют и у каждой свой текст для человека', () => {
    const failed = failureText('provider-failed', 'status failed: Invalid interaction id');
    const unreachable = failureText('provider-unreachable', 'network error');
    expect(failed.person.includes('Invalid interaction id')).toBe(false);
    expect(failed.operator.includes('Invalid interaction id')).toBe(true);
    expect(String(failed.person) === String(unreachable.person)).toBe(false);
  });

  it('текст для человека и для оператора различаются — иначе лог оператора пропускается', () => {
    const pair = failureText('provider-failed', 'что-то от провайдера');
    expect(pair.person === pair.operator).toBe(false);
  });

  it('ни одна ветка разбора статуса не отдаёт сырую строку вместо пары', () => {
    expect(/failOrRequeue\(\s*jobId,\s*payload,\s*`/.test(src)).toBe(false);
  });

  it('обе прежние точки теперь зовут failureText', () => {
    expect(src.includes("failureText('provider-failed'")).toBe(true);
    expect(src.includes("failureText('provider-unreachable'")).toBe(true);
  });

  it('обратная проба: failureText по-прежнему кладёт подробность только оператору', () => {
    const pair = failureText('provider-rejected', 'HTTP 400: body');
    expect(pair.operator.includes('HTTP 400')).toBe(true);
    expect(pair.person.includes('HTTP 400')).toBe(false);
  });
});

describe('[our-own-refusal-wore-a-provider-costume] наш отказ не выдаётся за отказ провайдеров', () => {
  const src = stripComments(read('stt/stt.service.ts'));

  it('HTTP-отказ уходит наружу, а не в список отказов провайдеров', () => {
    expect(/catch \(err\) \{[\s\S]{0,200}if \(err instanceof HttpException\) throw err;/.test(src)).toBe(true);
  });

  it('возврат стои́т ПЕРЕД накоплением failures — иначе он ничего не меняет', () => {
    const rethrow = src.indexOf('err instanceof HttpException');
    const push = src.indexOf('failures.push(`${name}');
    expect(rethrow > 0 && push > 0).toBe(true);
    expect(rethrow < push).toBe(true);
  });

  it('обратная проба: отказ провайдера по-прежнему попадает в список и в 503', () => {
    expect(src.includes('failures.push')).toBe(true);
    expect(src.includes('Не удалось передать аудио ни одному провайдеру распознавания')).toBe(true);
  });
});

describe('[the-secret-travelled-as-a-header] формат секрета вебхука распознавания', () => {
  it('значение с переносом строки отвергается и причина названа словами', () => {
    const problem = sttSecretProblem('abcdefghijklmnopqrstuvwx\n') ?? '';
    expect(problem.includes('перенос строки')).toBe(true);
  });

  it('нормальные base64 и hex подходят: алфавит заголовка их допускает', () => {
    expect(sttSecretProblem('Zm9vYmFyL2Jheg+cXV1eHF1dXg=')).toBeNull();
    expect(sttSecretProblem('a'.repeat(64))).toBeNull();
  });

  it('пустое отвергается своей причиной', () => {
    expect(sttSecretProblem('')).toBe('значение пустое');
  });

  // Правка после первого живого прогона CI: минимума длины здесь БОЛЬШЕ
  // НЕТ. Он уронил `stt-routing.spec.ts` на трёхсимвольной фикстуре — и
  // падение было правильным: провайдер короткий секрет принимает, а
  // значит отказ от него не был «правилом чужой стороны», ради которого
  // этот пункт и заводился. Обоснование целиком — в шапке
  // `stt-secret-format.ts`.
  it('короткий, но корректный секрет НЕ отвергается — это не правило провайдера', () => {
    expect(sttSecretProblem('sec')).toBeNull();
  });

  it('символы, которые рвут заголовок, названы по одному разу', () => {
    const problem = sttSecretProblem('секрет с пробелом и кавычкой "x" плюс ещё') ?? '';
    expect(problem.includes('запрещённые символы')).toBe(true);
  });

  it('проверка стои́т ДО отправки задачи у ОБОИХ провайдерских путей', () => {
    for (const file of ['conversations/transcription.service.ts', 'stt/stt.service.ts']) {
      const src = stripComments(read(file));
      expect(src.includes('sttSecretProblem')).toBe(true);
    }
    const t = stripComments(read('conversations/transcription.service.ts'));
    expect(t.indexOf('sttSecretProblem') < t.indexOf('/transcript')).toBe(true);
  });

  it('разрешение секрета снимает краевые пробелы', () => {
    const src = stripComments(read('common/webhook/stt-webhook.guard.ts'));
    expect(src.includes('.trim()')).toBe(true);
  });

  // Та же переписка по той же причине (сторож [probe-checked-the-neighbour]):
  // проба обязана трогать ту же машинерию. Здесь это `read`/`stripComments` —
  // и проба заодно отвечает на вопрос, который без неё остаётся открытым:
  // проверяется ли ТО ЖЕ правило, которое продукт зовёт, или спека
  // смотрит на отдельно лежащую копию.
  it('обратная проба: проверка смотрит на содержимое, и продукт зовёт именно её', () => {
    expect(sttSecretProblem('A1b2C3d4E5f6G7h8')).toBeNull();
    expect(sttSecretProblem('A1b2 C3d4E5f6G7h8')).not.toBeNull();
    const guard = stripComments(read('common/webhook/stt-webhook.guard.ts'));
    expect(guard.includes("from './stt-secret-format'")).toBe(true);
  });
});

describe('[the-outcome-reached-one-route-of-three] текст о последствиях отзыва — у всех трёх маршрутов', () => {
  it('текст строится из исхода: недойденная цепочка названа', () => {
    const exhausted = revocationDoesNotUndo({ sharesRevoked: 1, copiesRevoked: 1, depthExhausted: true }, CANDIDATE_REVOCATION_EFFECTS.doesNotUndo);
    const fine = revocationDoesNotUndo({ sharesRevoked: 1, copiesRevoked: 1, depthExhausted: false }, CANDIDATE_REVOCATION_EFFECTS.doesNotUndo);
    expect(exhausted.includes('не «всё закрыто»')).toBe(true);
    expect(fine.includes('не «всё закрыто»')).toBe(false);
  });

  it('все три маршрута отзыва зовут те же две функции', () => {
    for (const file of [
      'hiring-extras/hiring-extras.service.ts',
      'interview-pool/interview-pool-candidate.service.ts',
      'candidate-self-share/candidate-self-share.service.ts',
    ]) {
      const src = stripComments(read(file));
      // ВЫЗОВ, а не упоминание: мутация, оставившая импорт и вернувшая
      // фиксированный текст, проверку на `includes` ВЫЖИЛА — и это ровно
      // тот дефект, который этот Пункт и закрывает.
      expect(/revocationAlsoDone\(/.test(src)).toBe(true);
      expect(/revocationDoesNotUndo\(/.test(src)).toBe(true);
    }
  });

  it('реестр постоянных текстов живёт рядом с функциями, а не внутри одного потребителя', () => {
    const report = stripComments(read('interview-pool/revocation-report.ts'));
    expect(report.includes('CANDIDATE_REVOCATION_EFFECTS')).toBe(true);
    expect(revocationAlsoDone({ sharesRevoked: 0, copiesRevoked: 0, depthExhausted: false }).includes('не было')).toBe(true);
  });

  it('экран самошеринга исход РИСУЕТ, а не выбрасывает', () => {
    const tma = readRoot(join('apps', 'tma', 'src', 'components', 'domains', 'hiring', 'CandidateSheetTools.tsx'));
    const src = stripComments(tma);
    expect(src.includes('CandidateRevocationOutcome')).toBe(true);
    // Нарисовать мало — состояние должно ЗАПОЛНЯТЬСЯ исходом. Мутация,
    // вернувшая `reload()` без `setRevocation(r)`, проверку «компонент
    // упомянут» ВЫЖИЛА: разметка оставалась, но показывать ей было нечего.
    expect(src.includes('setRevocation(')).toBe(true);
    expect(/revoke\(s\.id\),\s*\(r\) => \{[^}]*setRevocation\(r\)/.test(src)).toBe(true);
    expect(/selfShareApi\.revoke\(s\.id\),\s*reload\)/.test(src)).toBe(false);
  });

  it('тип клиента больше не any — иначе поля нечем нарисовать', () => {
    const api = stripComments(readRoot(join('apps', 'tma', 'src', 'lib', 'hiring', 'api.ts')));
    expect(api.includes('SelfShareRevocation')).toBe(true);
    expect(/revoke: \(shareId: string\) =>\s*apiPost<any>/.test(api)).toBe(false);
  });

  it('обратная проба: при полностью пройденной цепочке лишней тревоги нет', () => {
    const text = revocationAlsoDone({ sharesRevoked: 2, copiesRevoked: 1, depthExhausted: false });
    expect(text.includes('закрыто 2')).toBe(true);
    expect(text.includes('длиннее')).toBe(false);
  });
});

describe('[loading-never-ended] отказ загрузки не рисуется как «Загрузка…»', () => {
  const src = stripComments(readRoot(join('apps', 'admin', 'src', 'app', 'domains', 'page.tsx')));

  it('у очередей медиа есть своё состояние отказа, и оно показывается', () => {
    expect(src.includes('mediaError')).toBe(true);
    expect(/\{mediaError && <p role="alert"/.test(src)).toBe(true);
  });

  it('«Загрузка…» больше не вечна: она исключена при отказе', () => {
    expect(/\{!media && !mediaError && <p className="muted">Загрузка…<\/p>\}/.test(src)).toBe(true);
  });

  it('молчание значением убрано', () => {
    expect(src.includes('.catch(() => undefined)')).toBe(false);
  });

  it('обратная проба: отказ доменных итогов остался отдельным — падение одного запроса не прячет другой', () => {
    expect(src.includes('setError(')).toBe(true);
    expect(src.includes('setMediaError(')).toBe(true);
  });
});
