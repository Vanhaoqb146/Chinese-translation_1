export const MOBILE_AUTO_DETECT_SOURCE_LANG = 'zh';
export const MOBILE_AUTO_DETECT_TARGET_LANG = 'vi';
export const MOBILE_AUTO_DETECT_LANGS = [
  MOBILE_AUTO_DETECT_SOURCE_LANG,
  MOBILE_AUTO_DETECT_TARGET_LANG,
];

const SUPPORTED_MOBILE_AUTO_DETECT_LANGS = ['zh', 'vi', 'en', 'ja', 'ko'];

const CJK_CHARS = /[\u3400-\u9fff]/;
const KANA_CHARS = /[\u3040-\u30ff]/;
const HANGUL_CHARS = /[\uac00-\ud7af]/;
const LATIN_CHARS = /[a-zA-Z]/;
const VIET_D = /[đĐ]/;

export function normalizeMobileAutoDetectLanguage(language) {
  if (!language || typeof language !== 'string') return null;

  const normalized = language.split('-')[0].trim().toLowerCase();
  if (['zh', 'cmn', 'yue', 'chinese', 'mandarin'].includes(normalized)) return 'zh';
  if (['vi', 'vie', 'vietnamese'].includes(normalized)) return 'vi';
  if (['en', 'eng', 'english'].includes(normalized)) return 'en';
  if (['ja', 'jpn', 'jp', 'japanese'].includes(normalized)) return 'ja';
  if (['ko', 'kor', 'kr', 'korean'].includes(normalized)) return 'ko';
  return null;
}

function normalizeAllowedLanguages(languages) {
  return [...new Set((languages || [])
    .map(normalizeMobileAutoDetectLanguage)
    .filter((lang) => SUPPORTED_MOBILE_AUTO_DETECT_LANGS.includes(lang)))];
}

export function getMobileAutoDetectLanguages(srcLang, tgtLang) {
  return normalizeAllowedLanguages([srcLang, tgtLang]);
}

export function isMobileAutoDetectLanguage(language, allowedLangs = MOBILE_AUTO_DETECT_LANGS) {
  const normalized = normalizeMobileAutoDetectLanguage(language);
  if (!normalized) return false;
  const allowed = normalizeAllowedLanguages(allowedLangs);
  return allowed.length ? allowed.includes(normalized) : false;
}

export function detectMobileTextLanguage(text, allowedLangs = SUPPORTED_MOBILE_AUTO_DETECT_LANGS) {
  const value = (text || '').trim();
  if (!value) return null;

  const allowed = normalizeAllowedLanguages(allowedLangs);
  const hasCjk = CJK_CHARS.test(value);
  const hasKana = KANA_CHARS.test(value);
  const hasHangul = HANGUL_CHARS.test(value);
  const decomposed = value.normalize('NFD');
  const hasVietnamese = /[\u0300-\u036f]/.test(decomposed) || VIET_D.test(value);
  const hasLatin = LATIN_CHARS.test(value);

  // Match the web app: Vietnamese diacritics are the strongest signal when
  // a real Vietnamese reply is mixed with Chinese speaker echo.
  if (hasVietnamese && allowed.includes('vi')) return 'vi';
  if (hasCjk && allowed.includes('zh')) return 'zh';
  if (hasKana && allowed.includes('ja')) return 'ja';
  if (hasHangul && allowed.includes('ko')) return 'ko';

  if (hasLatin) {
    if (allowed.includes('en') && !allowed.includes('vi')) return 'en';
    if (allowed.includes('vi')) return 'vi';
    if (allowed.includes('en')) return 'en';
  }

  return null;
}

export function isTextLikelyLanguage(text, lang) {
  const normalizedLang = normalizeMobileAutoDetectLanguage(lang);
  const value = (text || '').trim();
  if (!normalizedLang || !value) return false;

  const hasCjk = CJK_CHARS.test(value);
  const hasKana = KANA_CHARS.test(value);
  const hasHangul = HANGUL_CHARS.test(value);
  const decomposed = value.normalize('NFD');
  const hasVietnamese = /[\u0300-\u036f]/.test(decomposed) || VIET_D.test(value);

  if (normalizedLang === 'zh') return hasCjk;
  if (normalizedLang === 'ja') return hasKana || hasCjk;
  if (normalizedLang === 'ko') return hasHangul;
  if (normalizedLang === 'vi') {
    return hasVietnamese || (!hasCjk && !hasKana && !hasHangul);
  }
  if (normalizedLang === 'en') return LATIN_CHARS.test(value) && !hasCjk && !hasKana && !hasHangul;
  return false;
}
