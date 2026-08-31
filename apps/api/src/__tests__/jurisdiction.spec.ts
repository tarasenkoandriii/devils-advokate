// Полный аудит 2026-08-30 — юрисдикция: User.country хранил название,
// resolveJurisdictionBucket() ждал код → все были OTHER. Теперь код из
// Vercel x-vercel-ip-country как fallback, явная страна — приоритет.
import { countryNameToCode, resolveJurisdictionBucket } from '../legal-disclaimer/jurisdiction-bucket';
import { readVercelIpCountry } from '../telegram-auth/telegram-auth.guard';

describe('jurisdiction', () => {
  it('РЕГРЕСІЯ: название страны (как хранил User.country) больше не даёт OTHER', () => {
    expect(resolveJurisdictionBucket('Україна')).toBe('UA');
    expect(resolveJurisdictionBucket(null, 'Ukraine')).toBe('UA');
    expect(resolveJurisdictionBucket('Deutschland')).toBe('EU');
    expect(resolveJurisdictionBucket('United States')).toBe('US');
  });
  it('коды: регистр не важен; неизвестное — OTHER', () => {
    expect(resolveJurisdictionBucket('ua')).toBe('UA');
    expect(resolveJurisdictionBucket('PL')).toBe('EU');
    expect(resolveJurisdictionBucket('BR')).toBe('OTHER');
    expect(resolveJurisdictionBucket(null, 'Атлантида')).toBe('OTHER');
    expect(countryNameToCode('  Польща ')).toBe('PL');
  });
  it('readVercelIpCountry: ISO-2 в верхнем регистре, XX/мусор/пусто → null', () => {
    expect(readVercelIpCountry({ 'x-vercel-ip-country': 'ua' })).toBe('UA');
    expect(readVercelIpCountry({ 'x-vercel-ip-country': ['DE', 'FR'] })).toBe('DE');
    expect(readVercelIpCountry({ 'x-vercel-ip-country': 'XX' })).toBeNull();
    expect(readVercelIpCountry({ 'x-vercel-ip-country': 'USA' })).toBeNull();
    expect(readVercelIpCountry({})).toBeNull();
  });
});
