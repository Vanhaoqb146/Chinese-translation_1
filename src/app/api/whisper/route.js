import { NextResponse } from 'next/server';

// =============================================
// [LƯỚI LỌC THÉP] — Aggressive Hallucination Filter
// =============================================

const ALLOWED_LANGS = ['vietnamese', 'chinese', 'mandarin', 'vi', 'zh', 'english', 'en', 'japanese', 'ja', 'korean', 'ko'];

const BAD_PHRASES = [
  'thanks for watching', 'thank you for watching', 'please subscribe',
  'like and subscribe', 'see you next time', 'bye bye', 'goodbye',
  'see you later', 'thank you', 'you', 'bye',
  'please like', 'don\'t forget to subscribe', 'hit the bell',
  'leave a comment', 'share this video', 'follow me',
  'welcome back', 'hello everyone', 'hey guys',
  // Vietnamese hallucination
  'đăng ký', 'đăng kí', 'theo dõi', 'tạm biệt', 'hẹn gặp lại',
  'cảm ơn các bạn', 'chào mừng các bạn', 'video tiếp theo',
  'nhấn like', 'chia sẻ', 'bình luận',
  'chào mừng bạn', 'kênh lalaschool', 'lalaschool',
  'không bỏ lỡ', 'video hấp dẫn', 'đăng kí cho kênh',
  // Simplified Chinese hallucination
  '点赞', '订阅', '转发', '打赏', '明镜', '字幕',
  '谢谢观看', '谢谢大家', '再见', '感谢收看',
  '欢迎', '关注', '以上就是本期视频', '本期视频的全部内容',
  // Traditional Chinese hallucination (Whisper thường trả về phồn thể)
  '謝謝觀看', '謝謝大家', '感謝收看', '訂閱', '點讚',
  '歡迎', '關注', '以上就是本期視頻', '本期視頻的全部內容',
  '字幕', '轉發',
  // Common mixed
  'amara', 'manuval', 'प्रस्तुत्र',
  'http', 'www', '.com', '.org', '.net',
  'điểm điểm', 'minh kính', 'phẩy.', 'chấm.',
];

// Bản đồ mã ngôn ngữ app → mã ISO 639-1 cho Whisper
const LANG_TO_ISO = { vi: 'vi', zh: 'zh', en: 'en', ja: 'ja', ko: 'ko' };

export async function POST(request) {
  try {
    const formData = await request.formData();
    const audioFile = formData.get('audio');
    const apiKey = formData.get('apiKey') || process.env.OPENAI_API_KEY || '';
    const srcLang = formData.get('srcLang') || '';
    const tgtLang = formData.get('tgtLang') || '';
    // mode: 'standard' = ép ngôn ngữ src; 'conversation' = tự phát hiện ngôn ngữ
    const mode = formData.get('mode') || 'standard';

    if (!audioFile) return NextResponse.json({ error: 'No audio file' }, { status: 400 });
    if (!apiKey) return NextResponse.json({ error: 'No API key.' }, { status: 400 });

    const whisperForm = new FormData();
    const originalName = audioFile.name || 'audio.webm';
    const ext = originalName.split('.').pop() || 'webm';
    whisperForm.append('file', audioFile, `audio.${ext}`);
    whisperForm.append('model', 'whisper-1');
    whisperForm.append('temperature', '0.0');

    if (mode === 'conversation') {
      // [CONVERSATION MODE] Không ép ngôn ngữ — để Whisper tự phát hiện
      // Dùng verbose_json để nhận lại trường "language" trong response
      whisperForm.append('response_format', 'verbose_json');
    } else {
      // [STANDARD MODE] Ép ngôn ngữ nguồn để tăng chính xác
      if (srcLang && LANG_TO_ISO[srcLang]) {
        whisperForm.append('language', LANG_TO_ISO[srcLang]);
      }
    }

    const res = await fetch('https://api.openai.com/v1/audio/transcriptions', {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${apiKey}` },
      body: whisperForm,
      signal: AbortSignal.timeout(60000), // 60s timeout cho file WAV lớn (~5MB)
    });

    if (!res.ok) {
      const err = await res.text();
      return NextResponse.json({ error: 'Whisper API failed', detail: err }, { status: res.status });
    }

    const data = await res.json();
    let text = (data.text || '').trim();
    const detectedLang = data.language ? data.language.toLowerCase() : '';

    // ========== BỘ LỌC 1: KHÓA NGÔN NGỮ ==========
    if (detectedLang && !ALLOWED_LANGS.includes(detectedLang)) {
      console.log(`🚫 [Whisper Filter] Blocked language: "${detectedLang}" — text: "${text}"`);
      return NextResponse.json({ text: '', language: null });
    }

    // ========== BỘ LỌC 2: CHẶN TỪ MA (Hallucination) ==========
    const lowerText = text.toLowerCase();
    if (BAD_PHRASES.some(phrase => lowerText.includes(phrase))) {
      console.log(`🚫 [Whisper Filter] Blocked hallucination: "${text}"`);
      return NextResponse.json({ text: '', language: null });
    }

    // ========== BỘ LỌC 3: VĂN BẢN QUÁ NGẮN (≤ 2 ký tự) ==========
    if (text.length <= 2) {
      console.log(`🚫 [Whisper Filter] Blocked too-short text: "${text}"`);
      return NextResponse.json({ text: '', language: null });
    }

    // ========== BỘ LỌC 4: VĂN BẢN RỖNG ==========
    if (!text) {
      return NextResponse.json({ text: '', language: null });
    }

    return NextResponse.json({ text, language: data.language || null });
  } catch (err) {
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}