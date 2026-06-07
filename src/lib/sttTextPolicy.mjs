const VIETNAMESE_MARKS = /[àáảãạăắằẳẵặâấầẩẫậèéẻẽẹêếềểễệìíỉĩịòóỏõọôốồổỗộơớờởỡợùúủũụưứừửữựỳýỷỹỵđĐ]/;
const CJK_CHARS = /[\u3400-\u9fff]/;
const KANA_CHARS = /[\u3040-\u30ff]/;
const HANGUL_CHARS = /[\uac00-\ud7af]/;
const LATIN_CHARS = /[a-zA-Z]/;

const STRONG_HALLUCINATION_PHRASES = [
  'thanks for watching',
  'thank you for watching',
  'please subscribe',
  'like and subscribe',
  'don\'t forget to subscribe',
  'hit the bell',
  'share this video',
  'cảm ơn các bạn đã xem video',
  'cảm ơn các bạn đã theo dõi video',
  'đừng quên đăng ký',
  'đừng quên đăng kí',
  'đăng ký kênh',
  'đăng kí kênh',
  'đăng kí cho kênh',
  'nhấn like',
  'video tiếp theo',
  'kênh lalaschool',
  'không bỏ lỡ video',
  '谢谢观看',
  '感谢收看',
  '以上就是本期视频',
  '本期视频的全部内容',
  '謝謝觀看',
  '感謝收看',
  '以上就是本期視頻',
  '本期視頻的全部內容',
];

const EXACT_HALLUCINATIONS = new Set([
  'amara',
  'manuval',
  'điểm điểm',
  'minh kính',
  'phẩy',
  'chấm',
  '点赞',
  '订阅',
  '轉發',
  '字幕',
]);

export function normalizeSttLanguage(language) {
  if (!language || typeof language !== 'string') return null;
  const value = language.split('-')[0].trim().toLowerCase();
  if (['zh', 'cmn', 'yue', 'chinese', 'mandarin'].includes(value)) return 'zh';
  if (['vi', 'vie', 'vietnamese'].includes(value)) return 'vi';
  if (['en', 'eng', 'english'].includes(value)) return 'en';
  if (['ja', 'jpn', 'jp', 'japanese'].includes(value)) return 'ja';
  if (['ko', 'kor', 'kr', 'korean'].includes(value)) return 'ko';
  return null;
}

function normalizeText(text) {
  return (text || '')
    .toLowerCase()
    .replace(/[.,!?;:，。！？；：、'"“”‘’()[\]{}]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

export function detectSttTextLanguage(text, allowedLanguages = []) {
  const value = (text || '').trim();
  if (!value) return null;

  const allowed = new Set(
    allowedLanguages
      .map(normalizeSttLanguage)
      .filter(Boolean)
  );

  if (VIETNAMESE_MARKS.test(value) && allowed.has('vi')) return 'vi';
  if (CJK_CHARS.test(value) && allowed.has('zh')) return 'zh';
  if (KANA_CHARS.test(value) && allowed.has('ja')) return 'ja';
  if (HANGUL_CHARS.test(value) && allowed.has('ko')) return 'ko';

  if (LATIN_CHARS.test(value)) {
    if (allowed.has('vi')) return 'vi';
    if (allowed.has('en')) return 'en';
  }

  return null;
}

export function findWhisperHallucination(text) {
  const normalized = normalizeText(text);
  if (!normalized) return null;

  const exactMatch = EXACT_HALLUCINATIONS.has(normalized);
  if (exactMatch) return normalized;

  return STRONG_HALLUCINATION_PHRASES.find((phrase) => normalized.includes(phrase)) || null;
}
