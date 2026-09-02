// Docker dev-запуск (DOCKER.md) — сид ТОЛЬКО для локального стенда.
// Отдельный файл, а не флаг внутри seed.ts, по одной причине: seed.ts
// содержит справочные данные, без которых приложение не работает в
// принципе (реестр AI-провайдеров/моделей, активный промпт, классы
// хранения), и его в теории можно запускать против staging. Здесь же
// создаётся пользователь с полными правами оператора — то, что не
// должно иметь ни малейшего шанса уехать куда-то за пределы localhost.
// Смешивать это в один файл — значит однажды запустить не тот сид.
//
// Запускается контейнером api-init (docker-compose.dev.yml) после
// основного сида, либо руками: `npm run prisma:seed:dev --workspace=apps/api`.

import { PrismaClient, ConsentType } from '@prisma/client';
// Префикс "dev-" — одно соглашение на три места (guard TMA, dev-вход в
// админку, этот сид). Импортируется, а не копируется: комментарий в
// самом dev-login.ts предупреждает, что копии таких констант — ровно
// тот способ, которым они потом разъезжаются.
import { devTelegramId } from '../src/admin-auth/dev-login';

// ── Предохранители ───────────────────────────────────────────────────
// Их ДВА, по тому же принципу, что у admin-auth/dev-login.ts: этот сид
// раздаёт права оператора, то есть по последствиям равен dev-входу в
// админку, и одной ошибки конфигурации не должно хватать.
//
// Проверять один NODE_ENV здесь было бы самообманом: при запуске
// `npm run prisma:seed:dev` с ноутбука NODE_ENV не выставлен вообще, а
// DATABASE_URL в этот момент берётся из apps/api/.env — и вполне может
// указывать на Supabase. То есть единственная реальная опасность
// («сид уехал в прод») именно этой проверкой и не ловилась. Поэтому
// главный предохранитель — не режим, а ЦЕЛЬ: хост базы данных.
const LOCAL_DB_HOSTS = new Set(['localhost', '127.0.0.1', '::1', 'postgres', 'db', 'host.docker.internal']);

function assertLocalDatabase(): void {
  const url = process.env.DATABASE_URL;
  if (!url) {
    throw new Error('DATABASE_URL не задан — seed-dev.ts не может проверить, что база локальная, и отказывается работать вслепую.');
  }

  let host: string;
  try {
    // Хост из postgresql://user:pass@host:port/db. new URL() справляется
    // с этой схемой; скобки IPv6 снимаем — new URL('...@[::1]:5432').hostname
    // возвращает "[::1]" вместе с ними.
    host = new URL(url).hostname.replace(/^\[|\]$/g, '').toLowerCase();
  } catch {
    throw new Error('DATABASE_URL не разбирается как URL — отказываюсь запускать dev-сид, не убедившись, что база локальная.');
  }

  if (!LOCAL_DB_HOSTS.has(host)) {
    throw new Error(
      `seed-dev.ts создаёт пользователя с полными правами оператора и запускается только против локальной базы. ` +
        `DATABASE_URL указывает на "${host}" — это не localhost/контейнер. Если это действительно локальная база под другим именем, ` +
        `добавьте её хост в LOCAL_DB_HOSTS осознанно, а не обходите проверку переменной окружения.`,
    );
  }
}

const prisma = new PrismaClient();

// Тот же id, что у NEXT_PUBLIC_DEV_USER_ID в apps/tma и apps/admin —
// одно значение по умолчанию во всех трёх местах, иначе dev-вход в
// админку и dev-вход в TMA дадут двух разных пользователей и сквозной
// сценарий «создал в TMA → увидел в админке» молча не сойдётся.
const DEV_USER_ID = process.env.DEV_USER_ID ?? '123';
const DEV_TELEGRAM_ID = devTelegramId(DEV_USER_ID);

// Согласия НЕ выдаются по умолчанию осознанно: consent-гейты (§7.2 ТЗ) —
// часть продукта, которую разработчик обязан видеть и проверять, а не
// обходить. Тихо проставленные из сида согласия сделали бы локальный
// стенд непохожим на реальное первое использование именно в том месте,
// где ошибиться дороже всего. Кому нужен «сразу рабочий» стенд для
// отладки не-consent сценариев — SEED_DEV_CONSENTS=true, явным решением.
const SEED_CONSENTS = process.env.SEED_DEV_CONSENTS === 'true';

async function main() {
  if (process.env.NODE_ENV === 'production') {
    throw new Error(
      'seed-dev.ts запущен с NODE_ENV=production — этот сид создаёт пользователя с полными правами оператора и не должен выполняться нигде, кроме локального стенда.',
    );
  }
  assertLocalDatabase();

  const user = await prisma.user.upsert({
    where: { telegramId: DEV_TELEGRAM_ID },
    update: {
      isOperator: true,
      isLibraryModerator: true,
      isVenueModerator: true,
      // Тоже в update, не только в create: пользователя мог создать
      // раньше dev-bypass TMA (без дисклеймера) — иначе повторный
      // прогон сида оставлял бы модалку висеть.
      launchDisclaimerAcknowledgedAt: new Date(),
      launchDisclaimerVersion: 'dev-seed',
    },
    create: {
      telegramId: DEV_TELEGRAM_ID,
      isOperator: true,
      isLibraryModerator: true,
      isVenueModerator: true,
      // Дисклеймер запуска — уже подтверждён, чтобы на стенде не
      // упираться в модальное окно на каждом чистом томе БД. Это UX-
      // заглушка, а не согласие на обработку данных (те — ниже, под
      // отдельным флагом), поэтому здесь без опции.
      launchDisclaimerAcknowledgedAt: new Date(),
      launchDisclaimerVersion: 'dev-seed',
    },
  });


  console.log(`[seed-dev] Пользователь ${DEV_TELEGRAM_ID} (id=${user.id}) — оператор + оба модератора.`);

  if (SEED_CONSENTS) {
    // Глобальные (projectId=null) согласия — ConsentService трактует их
    // как действующие для любого проекта (см. hasActiveConsent).
    const types: ConsentType[] = [
      ConsentType.EXTERNAL_AI,
      ConsentType.RECORDING,
      ConsentType.EPHEMERAL_SERVER,
      // Повторный аудит 2026-09-01: без него POST /tts отвечает 403, и
      // озвучка на dev-стенде невоспроизводима — выглядит как отказ
      // ElevenLabs. В TMA согласие теперь спрашивает SpeakButton.
      ConsentType.VOICE_PROCESSING,
    ];
    for (const consentType of types) {
      const existing = await prisma.consentRecord.findFirst({
        where: { userId: user.id, consentType, projectId: null, granted: true, revokedAt: null },
      });
      if (existing) continue;
      await prisma.consentRecord.create({
        data: {
          userId: user.id,
          consentType,
          version: 'dev-seed',
          source: 'seed-dev',
          granted: true,
          grantedAt: new Date(),
          purposes: [],
        },
      });
    }

    console.log(`[seed-dev] SEED_DEV_CONSENTS=true — выданы согласия: ${types.join(', ')}.`);
  } else {

    console.log(
      '[seed-dev] Согласия НЕ выданы (по умолчанию) — пройдите consent-гейты в TMA как обычный пользователь. SEED_DEV_CONSENTS=true, если нужно пропустить.',
    );
  }

  const projectCount = await prisma.project.count({ where: { ownerId: user.id } });
  if (projectCount === 0) {
    const project = await prisma.project.create({
      data: {
        ownerId: user.id,
        question: 'Стоит ли принимать оффер от компании X?',
        goal: 'Принять решение до конца недели, не потеряв текущие отношения с командой.',
      },
    });

    console.log(`[seed-dev] Демо-проект создан: ${project.id}.`);
  } else {

    console.log(`[seed-dev] У пользователя уже есть проекты (${projectCount}) — демо-проект не создаётся.`);
  }
}

main()
  .catch((e) => {

    console.error(e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
