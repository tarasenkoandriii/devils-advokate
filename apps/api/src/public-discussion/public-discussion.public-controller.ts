import { Body, Controller, Delete, Get, Param, Post, Query, UseInterceptors } from '@nestjs/common';
import { IsIn, IsOptional, IsString, MaxLength, MinLength } from 'class-validator';
import { ApiResponseInterceptor } from '../common/api-response.interceptor';
import { PublicDiscussionService } from './public-discussion.service';

// Пункт [outside-input] 2026-09-04. Эти четыре DTO не имели НИ ОДНОГО
// декоратора — при том, что за ними стоят маршруты записи, доступные
// кому угодно без аутентификации. Пункт [validation] 2026-09-01, вводя
// ValidationPipe, прямо назвал приоритет: «декораторы добавляются
// точечно, начиная с высокорисковых (лимиты длины текста в AI/TTS, URL,
// ПУБЛИЧНЫЕ POST)» — и публичные POST в тот заход как раз не
// разметились. Правило было названо и не выполнено ровно там, где
// названо первым.
//
// Что это означало на практике: `text!: string` — тип TypeScript, он
// исчезает при компиляции; в базу уходил текст любой длины от любого,
// кто знает ссылку. `stance!: 'PRO' | 'CON'` — то же самое: в рантайме
// не проверялось ничем.
//
// Потолки взяты по уже сложившимся в проекте: комментарий — 2000
// (vacancy-posting), развёрнутый ответ человека — 4000 (hiring-extras,
// PreAnswerDto). Имя — 100: это подпись под репликой, а не текст.
export class JoinDto {
  @IsOptional() @IsString() @MaxLength(100) displayName?: string;
}

export class SubmitArgumentDto {
  @IsString() @MinLength(1) @MaxLength(4000) text!: string;
  @IsIn(['PRO', 'CON']) stance!: 'PRO' | 'CON';
  @IsOptional() @IsString() @MaxLength(100) participantId?: string;
}

export class VoteDto {
  @IsIn(['up', 'down']) direction!: 'up' | 'down';
}

export class AddCommentDto {
  @IsString() @MinLength(1) @MaxLength(2000) text!: string;
  @IsOptional() @IsString() @MaxLength(100) participantId?: string;
}

// НАМЕРЕННО БЕЗ @UseGuards(TelegramAuthGuard) — один из ТРЁХ
// контроллеров проекта без Telegram-аутентификации (остальные два —
// публичная библиотека и витрина заведений; полный список с причинами
// собран в common/public-surfaces.ts и держится тестом). Знание
// publicShareToken в URL и есть "доступ" — см. подробное обоснование
// в public-discussion.service.ts, шапка файла.
//
// Пункт [outside-input] 2026-09-04: раньше здесь стояло «единственный
// контроллер за весь проект». Их было три и на момент написания той
// фразы — и все три названы `*.public-controller.ts`, а не
// `*.controller.ts`, из-за чего не попадали ни в одну сверку,
// перебиравшую контроллеры по имени файла. Утверждение о
// единственности ничем не проверялось — поэтому никто и не заметил,
// что оно неверно.
class WithdrawDto {
  // Пункт [outside-input]: публичный маршрут записи — DTO размечается
  // валидаторами, как и остальные шесть. Сверка поверхностей поймала это
  // сразу, как и задумано.
  //
  // Пункт [badge-was-the-key] 2026-09-24: поле было `participantId` —
  // тот самый идентификатор, который публичная страница печатала всем.
  // Теперь секрет, выданный один раз при входе.
  @IsString()
  @MinLength(1)
  @MaxLength(200)
  withdrawToken!: string;
}

@Controller('public/:token')
@UseInterceptors(ApiResponseInterceptor)
export class PublicDiscussionPublicController {
  constructor(private readonly publicDiscussion: PublicDiscussionService) {}

  /** Пункт [badge-was-the-key] 2026-09-24: `participantId` в строке
   * запроса — это НЕ удостоверение, а только «чьи записи отметить как
   * свои». Удостоверение (`withdrawToken`) приходит телом и в списки не
   * попадает; ровно поэтому идентификатор здесь можно передавать так,
   * как раньше было нельзя. */
  @Get()
  async view(@Param('token') token: string, @Query('participantId') participantId?: string) {
    return this.publicDiscussion.publicView(token, participantId);
  }

  @Post('participants')
  async join(@Param('token') token: string, @Body() dto: JoinDto) {
    return this.publicDiscussion.joinAsParticipant(token, dto?.displayName);
  }

  @Post('submissions')
  async submit(@Param('token') token: string, @Body() dto: SubmitArgumentDto) {
    return this.publicDiscussion.submitArgument(token, dto.text, dto.stance, dto.participantId);
  }

  @Post('submissions/:submissionId/vote')
  async vote(
    @Param('token') token: string,
    @Param('submissionId') submissionId: string,
    @Body() dto: VoteDto,
  ) {
    return this.publicDiscussion.vote(token, submissionId, dto.direction);
  }

  @Post('comments')
  async comment(@Param('token') token: string, @Body() dto: AddCommentDto) {
    return this.publicDiscussion.addComment(token, dto.text, dto.participantId);
  }

  /** Пункт [public-name] 2026-09-05 — забрать своё.
   *
   * DELETE с телом: участник опознаётся по своему же `participantId`,
   * другого удостоверения у него нет. Тело, а не путь — идентификатор не
   * должен оседать в логах прокси и в истории браузера рядом с тем, что
   * он открывает.
   *
   * ПОПРАВКА, Пункт [badge-was-the-key] 2026-09-24. Осторожность была
   * верной, а предмет её — нет: тот же идентификатор печатался в ответе
   * публичной страницы для каждого участника. Берегли от логов то, что
   * показывали на экране. Теперь телом передаётся `withdrawToken` —
   * секрет, выданный один раз и не попадающий ни в один список. */
  @Delete('comments/:commentId')
  async withdrawComment(
    @Param('token') token: string,
    @Param('commentId') commentId: string,
    @Body() dto: WithdrawDto,
  ) {
    return this.publicDiscussion.withdrawComment(token, commentId, dto.withdrawToken);
  }

  @Delete('submissions/:submissionId')
  async withdrawSubmission(
    @Param('token') token: string,
    @Param('submissionId') submissionId: string,
    @Body() dto: WithdrawDto,
  ) {
    return this.publicDiscussion.withdrawSubmission(token, submissionId, dto.withdrawToken);
  }
}
