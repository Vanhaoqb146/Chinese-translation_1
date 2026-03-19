'use client';
import { useState, useRef, useCallback, useEffect } from 'react';

/**
 * useRealtimeConversation — Azure Speech STT + GPT-4o + Azure TTS
 *
 * start(inputLang) → Azure SpeechRecognizer (continuous)
 * BƯỚC 1: Azure STT → interim/final text + auto language detection
 * BƯỚC 2: Silence timer → trigger translation
 * BƯỚC 3: Khóa mic → REST translate → hiện dịch → TTS
 * BƯỚC 4: TTS xong → tạo recognizer MỚI → resume recognition
 */

// ====== Phát hiện ngôn ngữ từ nội dung text (fallback cho Azure auto-detect) ======
// Rất đáng tin vì Vietnamese dùng Latin+dấu, Chinese dùng CJK — không lẫn nhau
const VIET_DIACRITICS = /[àáảãạăắằẳẵặâấầẩẫậèéẻẽẹêếềểễệìíỉĩịòóỏõọôốồổỗộơớờởỡợùúủũụưứừửữựỳýỷỹỵđĐ]/;
const CJK_CHARS = /[\u4e00-\u9fff\u3400-\u4dbf\uf900-\ufaff]/;
const HANGUL_CHARS = /[\uac00-\ud7af\u1100-\u11ff]/;
const KANA_CHARS = /[\u3040-\u309f\u30a0-\u30ff]/;

function detectLangFromText(text) {
  if (!text) return null;
  const hasViet = VIET_DIACRITICS.test(text);
  const hasCJK = CJK_CHARS.test(text);
  const hasKorean = HANGUL_CHARS.test(text);
  const hasJapanese = KANA_CHARS.test(text);

  if (hasViet && !hasCJK) return 'vi';
  if (hasCJK && !hasViet && !hasJapanese && !hasKorean) return 'zh';
  if (hasJapanese) return 'ja';
  if (hasKorean) return 'ko';
  // Latin without diacritics → likely English
  if (/^[a-zA-Z0-9\s.,!?'"\-:;()]+$/.test(text.trim())) return 'en';
  return null;
}

export default function useRealtimeConversation({
  srcLangCode,
  tgtLangCode,
  engine = 'openai',
  silenceMs = 4000,
  autoDetect = false,
  holdMode = false,
  onInterimText,
  onFinalResult,
  onStatusChange,
  onError,
  getVoiceForLang,
}) {
  const [isListening, setIsListening] = useState(false);
  const [elapsed, setElapsed] = useState(0);
  const [activeLang, setActiveLang] = useState(null);

  const recognizerRef = useRef(null);
  const startTimeRef = useRef(0);
  const elapsedTimerRef = useRef(null);

  const isSpeakingRef = useRef(false);
  const wantListeningRef = useRef(false);
  const inputLangRef = useRef(null);

  const accumulatedTextRef = useRef('');
  const currentInterimRef = useRef('');
  const silenceTimeoutRef = useRef(null);

  const conversationHistoryRef = useRef([]);
  const msgIdRef = useRef(Date.now());

  // Stable refs
  const srcLangCodeRef = useRef(srcLangCode);
  const tgtLangCodeRef = useRef(tgtLangCode);
  const onFinalResultRef = useRef(onFinalResult);
  const onStatusChangeRef = useRef(onStatusChange);
  const onErrorRef = useRef(onError);
  const onInterimTextRef = useRef(onInterimText);
  const engineRef = useRef(engine);
  const silenceMsRef = useRef(silenceMs);
  const getVoiceForLangRef = useRef(getVoiceForLang);
  const autoDetectRef = useRef(autoDetect);
  const holdModeRef = useRef(holdMode);

  useEffect(() => {
    srcLangCodeRef.current = srcLangCode;
    tgtLangCodeRef.current = tgtLangCode;
    onFinalResultRef.current = onFinalResult;
    onStatusChangeRef.current = onStatusChange;
    onErrorRef.current = onError;
    onInterimTextRef.current = onInterimText;
    engineRef.current = engine;
    silenceMsRef.current = silenceMs;
    getVoiceForLangRef.current = getVoiceForLang;
    autoDetectRef.current = autoDetect;
    holdModeRef.current = holdMode;
  });

  // ====== Tạo recognizer mới (có thể gọi lại nhiều lần) ======
  const setupRecognizer = useCallback(async (inputLang) => {
    // Đóng recognizer cũ nếu còn
    if (recognizerRef.current) {
      try { recognizerRef.current.close(); } catch (e) { console.warn('⚠️ [Close old recognizer]', e); }
      recognizerRef.current = null;
    }

    // Lấy Azure auth token MỚI mỗi lần
    const tokenRes = await fetch('/api/azure/token');
    const tokenData = await tokenRes.json();
    if (!tokenData.token) throw new Error('No Azure Speech token');

    console.log(`🔑 [setupRecognizer] Token mới, region=${tokenData.region}, lang=${inputLang}`);

    // Dynamic import — Azure Speech SDK
    const sdk = await import('microsoft-cognitiveservices-speech-sdk');

    // Tạo speech config mới từ token mới
    const speechConfig = sdk.SpeechConfig.fromAuthorizationToken(tokenData.token, tokenData.region);

    // Tăng ngưỡng im lặng trước khi Azure ngắt câu (mặc định ~1s → 2s)
    speechConfig.setProperty('Speech_SegmentationSilenceTimeoutMs', '2000');

    const langMap = { zh: 'zh-CN', vi: 'vi-VN', en: 'en-US', ja: 'ja-JP', ko: 'ko-KR' };
    const primaryLang = langMap[inputLang] || `${inputLang}-${inputLang.toUpperCase()}`;

    let audioConfig;
    let recognizer;

    if (autoDetectRef.current) {
      const srcLocale = langMap[srcLangCodeRef.current] || 'zh-CN';
      const tgtLocale = langMap[tgtLangCodeRef.current] || 'vi-VN';
      const candidates = [...new Set([srcLocale, tgtLocale])];
      console.log(`🌐 [Azure STT] Auto-detect candidates: ${candidates.join(', ')}`);

      const autoDetectConfig = sdk.AutoDetectSourceLanguageConfig.fromLanguages(candidates);
      audioConfig = sdk.AudioConfig.fromDefaultMicrophoneInput();
      recognizer = sdk.SpeechRecognizer.FromConfig(speechConfig, autoDetectConfig, audioConfig);
    } else {
      speechConfig.speechRecognitionLanguage = primaryLang;
      console.log(`🌐 [Azure STT] language=${primaryLang}`);
      audioConfig = sdk.AudioConfig.fromDefaultMicrophoneInput();
      recognizer = new sdk.SpeechRecognizer(speechConfig, audioConfig);
    }

    recognizerRef.current = recognizer;

    // === EVENT: Recognizing (interim results) ===
    recognizer.recognizing = (s, e) => {
      if (isSpeakingRef.current) return;
      const transcript = e.result.text;
      if (!transcript) return;

      // Detect language from result if auto-detect
      // [FIX] Đọc trực tiếp từ properties — tránh crash AutoDetectSourceLanguageResult.fromResult()
      if (autoDetectRef.current) {
        try {
          const detectedLocale = e.result.properties?.getProperty?.(
            sdk.PropertyId.SpeechServiceConnection_AutoDetectSourceLanguageResult
          );
          if (detectedLocale && detectedLocale !== 'Unknown') {
            const baseLang = detectedLocale.split('-')[0];
            if (baseLang !== inputLangRef.current) {
              console.log(`🌐 [Auto-detect interim] ${inputLangRef.current} → ${baseLang} (locale=${detectedLocale})`);
              inputLangRef.current = baseLang;
              setActiveLang(baseLang);
            }
          }
        } catch (e) { console.warn('⚠️ [Auto-detect interim]', e); }
      }

      console.log(`📝 interim: "${transcript}" (${(e.result.duration / 10000000).toFixed(1)}s)`);
      currentInterimRef.current = transcript;
      const display = accumulatedTextRef.current +
        (accumulatedTextRef.current ? ' ' : '') + transcript;
      if (onInterimTextRef.current) onInterimTextRef.current(display);
      resetSilenceTimer();
    };

    // === EVENT: Recognized (final results) ===
    recognizer.recognized = (s, e) => {
      if (isSpeakingRef.current) return;
      if (e.result.reason === sdk.ResultReason.NoMatch) return;

      const transcript = e.result.text;
      if (!transcript) return;

      // Detect language
      // [FIX] Đọc trực tiếp từ properties — tránh crash khi thiếu languageDetectionConfidence
      if (autoDetectRef.current) {
        try {
          const detectedLocale = e.result.properties?.getProperty?.(
            sdk.PropertyId.SpeechServiceConnection_AutoDetectSourceLanguageResult
          );
          if (detectedLocale && detectedLocale !== 'Unknown') {
            const baseLang = detectedLocale.split('-')[0];
            if (baseLang !== inputLangRef.current) {
              console.log(`🌐 [Auto-detect FINAL] ${inputLangRef.current} → ${baseLang} (locale=${detectedLocale})`);
              inputLangRef.current = baseLang;
              setActiveLang(baseLang);
            }
          }
        } catch (e) { console.warn('⚠️ [Auto-detect final]', e); }
      }

      console.log(`📝 FINAL: "${transcript}"`);
      accumulatedTextRef.current += (accumulatedTextRef.current ? ' ' : '') + transcript;
      currentInterimRef.current = '';
      if (onInterimTextRef.current) onInterimTextRef.current(accumulatedTextRef.current);
      resetSilenceTimer();
    };

    // === EVENT: Canceled ===
    recognizer.canceled = (s, e) => {
      if (e.reason === sdk.CancellationReason.Error) {
        console.error(`❌ [Azure STT] Error: ${e.errorDetails}`);
        if (onErrorRef.current) onErrorRef.current(`Azure STT: ${e.errorDetails}`);
      } else {
        console.log(`ℹ️ [Azure STT] Canceled: reason=${e.reason}`);
      }
    };

    // === EVENT: Session started (mic truly ready) ===
    recognizer.sessionStarted = () => {
      console.log('🟢 [Azure STT] Session started — mic ready!');
      if (onStatusChangeRef.current) onStatusChangeRef.current('listening');
    };

    // === EVENT: Session stopped ===
    recognizer.sessionStopped = () => {
      console.log('🔴 [Azure STT] Session stopped');
    };

    // Start continuous recognition
    await recognizer.startContinuousRecognitionAsync();
    console.log('✅ [Azure STT] Recognition started successfully');

    return recognizer;
  }, []);

  // ====== Silence Timer ======
  const resetSilenceTimer = useCallback(() => {
    clearTimeout(silenceTimeoutRef.current);
    if (isSpeakingRef.current) return;
    // Hold mode: không dùng silence timer — chỉ dịch khi user thả tay
    if (holdModeRef.current) return;

    const timeout = silenceMsRef.current || 4000;
    silenceTimeoutRef.current = setTimeout(() => {
      console.log(`⏰ [Silence] ${timeout / 1000}s timer fired!`);
      triggerTranslation();
    }, timeout);
  }, []);

  // ====== PIPELINE: Dịch + TTS (dùng chung cho silence timer & manual stop) ======
  const triggerTranslation = useCallback(async () => {
    let text = accumulatedTextRef.current.trim();
    if (!text && currentInterimRef.current.trim()) {
      text = currentInterimRef.current.trim();
    }
    if (!text) return;

    // [FIX] Xác định ngôn ngữ từ NỘI DUNG text — đáng tin hơn Azure auto-detect
    if (autoDetectRef.current) {
      const textLang = detectLangFromText(text);
      if (textLang && textLang !== inputLangRef.current) {
        console.log(`🔍 [Text-detect] "${text.slice(0, 30)}..." → ${textLang} (was: ${inputLangRef.current})`);
        inputLangRef.current = textLang;
        setActiveLang(textLang);
      }
    }

    // Xác định chiều dịch
    const fromLang = inputLangRef.current;
    const toLang = fromLang === srcLangCodeRef.current
      ? tgtLangCodeRef.current
      : srcLangCodeRef.current;

    console.log(`🔄 [Translate] "${text.slice(0, 80)}" (${fromLang}→${toLang})`);

    // Guard: nếu fromLang === toLang → skip (tránh dịch cùng ngôn ngữ)
    if (fromLang === toLang) {
      console.warn(`⚠️ [Translate] fromLang === toLang (${fromLang}) — bỏ qua`);
      accumulatedTextRef.current = '';
      currentInterimRef.current = '';
      if (onInterimTextRef.current) onInterimTextRef.current('');
      return;
    }

    // Khóa mic → Dịch → TTS
    isSpeakingRef.current = true;
    if (onStatusChangeRef.current) onStatusChangeRef.current('translating');

    // Đóng recognizer cũ hoàn toàn (không chỉ pause — vì session sẽ chết)
    if (recognizerRef.current) {
      try {
        await recognizerRef.current.stopContinuousRecognitionAsync();
        recognizerRef.current.close();
        console.log('🔇 [Mic] Đã đóng recognizer cũ');
      } catch (e) { console.warn('⚠️ [Stop recognizer]', e); }
      recognizerRef.current = null;
    }

    try {
      // ====== STREAMING TRANSLATION ======
      const translateRes = await fetch('/api/translate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          text,
          sourceLang: fromLang,
          targetLang: toLang,
          engine: engineRef.current,
          history: conversationHistoryRef.current,
          stream: true,
        }),
        signal: AbortSignal.timeout(25000),
      });

      if (!translateRes.ok) throw new Error(`Translate error ${translateRes.status}`);

      // Parse SSE stream
      const reader = translateRes.body.getReader();
      const decoder = new TextDecoder();
      let translatedText = '';
      let buffer = '';
      let streamDone = false;

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() || '';

        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed.startsWith('data: ')) continue;
          const data = trimmed.slice(6).trim();
          if (data === '[DONE]') { streamDone = true; break; }
          try {
            const parsed = JSON.parse(data);
            if (parsed.text) translatedText += parsed.text;
          } catch (e) { console.warn('⚠️ [SSE parse]', e); }
        }
        if (streamDone) break;
      }

      // Process remaining buffer
      if (buffer.trim()) {
        const remainingLines = buffer.split('\n');
        for (const line of remainingLines) {
          const trimmed = line.trim();
          if (!trimmed.startsWith('data: ')) continue;
          const data = trimmed.slice(6).trim();
          if (data === '[DONE]') break;
          try {
            const parsed = JSON.parse(data);
            if (parsed.text) translatedText += parsed.text;
          } catch (e) { console.warn('⚠️ [SSE parse remaining]', e); }
        }
      }

      translatedText = translatedText.trim();
      if (!translatedText) throw new Error('Empty translation');

      console.log(`✅ [Translate] "${translatedText.slice(0, 60)}..."`);

      const id = ++msgIdRef.current;
      if (onFinalResultRef.current) {
        onFinalResultRef.current({ id, originalText: text, translatedText, fromLang, toLang });
      }

      conversationHistoryRef.current.push(
        { role: 'user', content: text },
        { role: 'assistant', content: translatedText }
      );
      if (conversationHistoryRef.current.length > 8) {
        conversationHistoryRef.current = conversationHistoryRef.current.slice(-8);
      }

      // ====== TTS ======
      if (onStatusChangeRef.current) onStatusChangeRef.current('speaking');

      const voiceId = getVoiceForLangRef.current ? getVoiceForLangRef.current(toLang) : null;
      const ttsRes = await fetch('/api/tts', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text: translatedText, lang: toLang, voice: voiceId }),
        signal: AbortSignal.timeout(30000),
      });

      if (ttsRes.ok) {
        const blob = await ttsRes.blob();
        console.log(`🔊 [TTS] ${blob.size} bytes`);

        if (blob.size > 0) {
          const url = URL.createObjectURL(blob);
          const audio = new Audio(url);
          audio.preload = 'auto';
          await new Promise(resolve => {
            audio.onended = () => { URL.revokeObjectURL(url); resolve(); };
            audio.onerror = () => { URL.revokeObjectURL(url); resolve(); };
            audio.play().catch(() => resolve());
          });
        }
      }
    } catch (err) {
      console.error('❌ [Pipeline]', err);
      if (onErrorRef.current) onErrorRef.current(err.message);
    }

    // Dọn dẹp + tạo recognizer MỚI để resume
    accumulatedTextRef.current = '';
    currentInterimRef.current = '';
    isSpeakingRef.current = false;
    if (onInterimTextRef.current) onInterimTextRef.current('');

    // Hold mode: luôn tắt mic sau TTS — user phải nhấn giữ lại
    if (holdModeRef.current) {
      console.log('🛑 [Hold mode] TTS xong → tắt mic, chờ user nhấn giữ lần nữa');
      wantListeningRef.current = false;
      clearInterval(elapsedTimerRef.current);
      setIsListening(false);
      setActiveLang(null);
      if (onStatusChangeRef.current) onStatusChangeRef.current('idle');
    }
    // Chế độ tự nhận dạng (1 mic): mở mic lại để nghe tiếp
    // Chế độ thủ công (2 mic): tắt mic sau TTS — user bấm lại để nói tiếp
    else if (autoDetectRef.current && wantListeningRef.current) {
      // Auto-detect: tạo recognizer mới để tiếp tục nghe
      try {
        console.log('🔄 [Auto-detect Resume] Tạo recognizer mới...');
        await setupRecognizer(inputLangRef.current);
        console.log('✅ [Auto-detect Resume] Recognizer mới đã sẵn sàng!');
      } catch (err) {
        console.error('❌ [Resume] Không thể tạo recognizer mới:', err);
        if (onErrorRef.current) onErrorRef.current('Không thể bật lại mic: ' + err.message);
        if (onStatusChangeRef.current) onStatusChangeRef.current('idle');
      }
    } else {
      // Manual mode (2 mic): dừng hẳn sau mỗi câu
      console.log('🛑 [Manual] TTS xong → tắt mic');
      wantListeningRef.current = false;
      clearInterval(elapsedTimerRef.current);
      setIsListening(false);
      setActiveLang(null);
      if (onStatusChangeRef.current) onStatusChangeRef.current('idle');
    }
  }, [setupRecognizer]);

  // ====== Start(inputLang) — entry point ======
  const start = useCallback(async (inputLang) => {
    try {
      accumulatedTextRef.current = '';
      currentInterimRef.current = '';
      isSpeakingRef.current = false;
      inputLangRef.current = inputLang;
      conversationHistoryRef.current = [];
      msgIdRef.current = Date.now();

      console.log(`🔑 [Start] inputLang=${inputLang}`);

      // Set initial state — connecting (not listening yet)
      wantListeningRef.current = true;
      setIsListening(true);
      setActiveLang(inputLang);
      setElapsed(0);
      startTimeRef.current = Date.now();
      elapsedTimerRef.current = setInterval(() => {
        setElapsed(Math.floor((Date.now() - startTimeRef.current) / 1000));
      }, 1000);
      if (onStatusChangeRef.current) onStatusChangeRef.current('connecting');

      // Tạo recognizer (dùng hàm chung)
      await setupRecognizer(inputLang);
      console.log('⏳ [Azure STT] Recognition started, waiting for session...');

    } catch (err) {
      console.error('❌ [Start]', err);
      if (onErrorRef.current) onErrorRef.current(err.message);
      wantListeningRef.current = false;
      setIsListening(false);
    }
  }, [setupRecognizer]);

  // ====== Stop ======
  const stop = useCallback(async () => {
    console.log('🛑 Stop');
    wantListeningRef.current = false;
    clearTimeout(silenceTimeoutRef.current);
    clearInterval(elapsedTimerRef.current);

    // Stop + close Azure recognizer hoàn toàn
    if (recognizerRef.current) {
      try {
        await recognizerRef.current.stopContinuousRecognitionAsync();
        recognizerRef.current.close();
      } catch (e) { console.warn('⚠️ [Stop close]', e); }
      recognizerRef.current = null;
    }

    setIsListening(false);
    setActiveLang(null);

    // Nếu có text tích lũy → dịch ngay (manual stop)
    const hasText = accumulatedTextRef.current.trim() || currentInterimRef.current.trim();
    if (hasText && !isSpeakingRef.current) {
      console.log('🛑 [Stop] Có text → trigger dịch ngay!');
      triggerTranslation();
    } else {
      if (onStatusChangeRef.current) onStatusChangeRef.current('idle');
    }
  }, [triggerTranslation]);

  // ====== StopHold — dành cho chế độ nhấn giữ mic ======
  const stopHold = useCallback(async () => {
    console.log('🛑 [Hold] User thả tay → dừng mic + dịch');
    clearTimeout(silenceTimeoutRef.current);

    // Đóng recognizer ngay
    if (recognizerRef.current) {
      try {
        await recognizerRef.current.stopContinuousRecognitionAsync();
        recognizerRef.current.close();
      } catch (e) { console.warn('⚠️ [StopHold close]', e); }
      recognizerRef.current = null;
    }

    // Nếu có text → dịch ngay
    const hasText = accumulatedTextRef.current.trim() || currentInterimRef.current.trim();
    if (hasText && !isSpeakingRef.current) {
      console.log('🛑 [Hold] Có text → trigger dịch!');
      triggerTranslation();
    } else {
      // Không có text → về idle
      wantListeningRef.current = false;
      clearInterval(elapsedTimerRef.current);
      setIsListening(false);
      setActiveLang(null);
      if (onStatusChangeRef.current) onStatusChangeRef.current('idle');
    }
  }, [triggerTranslation]);

  useEffect(() => {
    return () => {
      wantListeningRef.current = false;
      clearTimeout(silenceTimeoutRef.current);
      clearInterval(elapsedTimerRef.current);
      if (recognizerRef.current) {
        try { recognizerRef.current.close(); } catch (e) { console.warn('⚠️ [Cleanup]', e); }
        recognizerRef.current = null;
      }
    };
  }, []);

  return { isListening, elapsed, activeLang, start, stop, stopHold };
}
