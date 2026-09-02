// Пункт [router-lanes] 2026-09-02 (ревью того же дня) — один критерий
// «этому провайдеру есть чем платить» на две точки: подбор модели в
// роутере и список движков в селекторе. Копия проверки в двух местах —
// ровно тот способ разъехаться, который этот проход и чинил в других
// местах; заводить его новым проходом было бы странно.
import { SecretsService } from '../secrets/secrets.service';

export async function providerHasUsableKey(
  secrets: Pick<SecretsService, 'resolve'>,
  provider: { apiEndpoint: string | null; credentialRef: string | null },
): Promise<boolean> {
  if (!provider.apiEndpoint || !provider.credentialRef) return false;
  try {
    await secrets.resolve(provider.credentialRef);
    return true;
  } catch {
    return false;
  }
}
