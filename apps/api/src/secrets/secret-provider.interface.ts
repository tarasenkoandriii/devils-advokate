// Чекпоинт 1, пункт 12: Secrets management (§7.3 ТЗ)
//
// Абстракция над источником секретов. Дисциплина "credentialRef, не
// сырой ключ" уже применена в схеме с пункта 6 (AIProvider.credentialRef);
// этот модуль — то, что фактически резолвит credentialRef в реальное
// значение секрета во время выполнения, никогда не кладя его в БД.

export interface SecretProvider {
  /**
   * Резолвит credentialRef (ссылку на секрет, например имя переменной
   * окружения или путь в Vault/AWS Secrets Manager) в реальное значение.
   * Бросает ошибку, если секрет не найден — вызывающий код не должен
   * получить undefined/пустую строку молча.
   */
  resolve(credentialRef: string): Promise<string>;
}

export const SECRET_PROVIDER = Symbol('SECRET_PROVIDER');
