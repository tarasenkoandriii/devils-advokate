// Сверка 2026-09-05 — «участник» и «владелец» различались только на
// экране.
//
// НАЙДЕННОЕ ИЗМЕРЕНИЕМ. `RecruitingTeamRole` знает OWNER и MEMBER, экран
// команды показывает «владелец» и «участник» — вид двух уровней доступа.
// В коде роль проверяется РОВНО В ОДНОМ месте: `assertOwner` внутри
// сервиса самой команды (пригласить, отозвать приглашение, посмотреть
// список приглашений). Везде остальном — а это доступ ко всему домену
// пула — стоит проверка ЧЛЕНСТВА, без учёта роли:
//
//   if (project.ownerId === userId) return project;
//   if (project.recruitingTeamId) { …membership… return project; }
//
// То есть человек, вошедший по 72-часовой ссылке, может всё, что может
// владелец пула: заводить и вести кандидатов, передавать профили наружу
// по ссылке, отозвать передачу, отправить наружу весь пул разом. И
// приглашающий об этом нигде не предупреждался: он видел слово
// «участник» и нажимал «Ссылка-приглашение».
//
// ЧЕГО СВЕРКА НЕ ДЕЛАЕТ, и это решение, а не забывчивость. Она не
// вводит систему прав. Кто в команде рекрутеров что может — вопрос
// продукта, а не честности: у агентства участники и должны работать с
// пулом ежедневно. Изъян был не в том, что права равны, а в том, что
// продукт показывал иерархию, которой нет. Исправлено то, что было
// неправдой: теперь сказано до нажатия.
//
// НАЗВАНО И НЕ ЗАКРЫТО: пакетная отправка всего пула наружу
// (`shareAllInPool`) доступна участнику так же, как владельцу. Из всех
// действий у неё самая большая асимметрия — один клик отправляет наружу
// всех. Ограничить её владельцем было бы разумно, но это изменение
// продукта, и принимать его за владельца проекта сверка не будет.

import { readFileSync, readdirSync } from 'fs';
import { join } from 'path';

const API_SRC = join(__dirname, '..');
const TMA_SRC = join(__dirname, '../../../tma/src');

function code(root: string, rel: string): string {
  return readFileSync(join(root, rel), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/.*$/gm, '$1');
}

/** Все места, где роль в команде вообще что-то решает. */
function roleEnforcementSites(): string[] {
  const found: string[] = [];
  (function walk(dir: string, rel: string) {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.name === '__tests__' || entry.name === 'node_modules') continue;
      const full = join(dir, entry.name);
      const r = rel ? `${rel}/${entry.name}` : entry.name;
      if (entry.isDirectory()) walk(full, r);
      else if (entry.name.endsWith('.ts')) {
        const src = code(API_SRC, r);
        if (/role !== RecruitingTeamRole\.OWNER|role === RecruitingTeamRole\.OWNER/.test(src)) found.push(r);
      }
    }
  })(API_SRC, '');
  return found;
}

describe('Команда: права участника названы такими, какие они есть', () => {
  it('КЛЮЧЕВОЙ ТЕСТ: роль решает ровно в одном месте — управлении командой', () => {
    // Число зафиксировано, чтобы следующая сверка начинала с факта. Если
    // однажды роль начнёт что-то ограничивать по-настоящему — проверка
    // упадёт, и текст на экране придётся переписать вместе с ней. Это и
    // есть связка между кодом и обещанием.
    const sites = roleEnforcementSites();
    expect(sites).toEqual(['interview-pool/interview-pool-team.service.ts']);
  });

  it('КЛЮЧЕВОЙ ТЕСТ: доступ к домену пула даётся по ЧЛЕНСТВУ, без учёта роли', () => {
    // Это и есть причина, по которой «участник» на экране был обещанием
    // иерархии, которой нет.
    const src = code(API_SRC, 'interview-pool/interview-pool-access.ts');
    expect(src).toMatch(/recruitingTeamMember\.findUnique/);
    expect(src).not.toMatch(/RecruitingTeamRole/);
  });

  it('КЛЮЧЕВОЙ ТЕСТ: экран говорит о правах участника ДО того, как выдана ссылка', () => {
    const src = code(TMA_SRC, 'components/domains/InterviewPoolWorkspace.tsx');
    const beforeInvite = src.slice(0, src.indexOf('invite-link'));
    expect(beforeInvite).toMatch(/те же права на пул/);
    expect(beforeInvite).toMatch(/передавать их профили\s+наружу по ссылке|передавать их профили наружу по ссылке/);
    // И единственное настоящее отличие названо, а не подразумевается.
    expect(beforeInvite).toMatch(/не может приглашать других/);
  });

  it('КЛЮЧЕВОЙ ТЕСТ: и в списке команд слово «участник» больше не обещает меньших прав', () => {
    const src = code(TMA_SRC, 'components/domains/InterviewPoolWorkspace.tsx');
    expect(src).toMatch(/'участник \(те же права на пул\)'/);
  });

  it('КЛЮЧЕВОЙ ТЕСТ: отзыв приглашения не выводит уже вступившего — и об этом сказано', () => {
    // Иначе «отозвать» читается как «убрать человека из команды».
    const service = code(API_SRC, 'interview-pool/interview-pool-team.service.ts');
    expect(service).toMatch(/revokeInvite/);
    const ui = code(TMA_SRC, 'components/domains/InterviewPoolWorkspace.tsx');
    expect(ui).toMatch(/уже вступившего участника это не выведет/);
  });

  it('ИЗМЕРЕНИЕ: передача наружу остаётся именной — действие пишется в журнал', () => {
    // Права равны, но след остаётся: если участник отправил профиль
    // наружу, в журнале стоит его id. Это не заменяет разграничение прав
    // и не выдаётся за него — просто то, что в продукте есть.
    const src = code(API_SRC, 'interview-pool/interview-pool-candidate.service.ts');
    expect(src).toMatch(/auditShipmentSafely\(userId/);
    expect(src).toMatch(/candidate_share\.created/);
  });
});
