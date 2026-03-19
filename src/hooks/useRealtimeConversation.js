'use client';
import { useState, useRef, useCallback, useEffect } from 'react';

/**
 * useRealtimeConversation — Azure Speech STT + GPT-4o + Azure TTS
 *
 * start(inputLang) → Azure SpeechRecognizer (continuous)
 * BƯỚC 1: Azure STT → interim/final text + auto language detection
 * BƯỚC 2: Silence timer → trigger translation
 * BƯỚC 3: Khóa mic → REST translate → hiện dịch → TTS
 * BƯỚC 4: TTS xong → resume recognition
 */

export default function useRealtimeConversation({
  srcLangCode,
  tgtLangCode,
  engine = 'openai',
  silenceMs = 4000,
  autoDetect = false,
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
  });

  // ====== PIPELINE: Dịch + TTS (dùng chung cho silence timer & manual stop) ======
  const triggerTranslation = useCallback(async () => {
    let text = accumulatedTextRef.current.trim();
    if (!text && currentInterimRef.current.trim()) {
      text = currentInterimRef.current.trim();
    }
    if (!text) return;

    // Xác định chiều dịch từ inputLang
    const fromLang = inputLangRef.current;
    const toLang = fromLang === srcLangCodeRef.current
      ? tgtLangCodeRef.current
      : srcLangCodeRef.current;

    console.log(`🔄 [Translate] "${text.slice(0, 80)}" (${fromLang}→${toLang})`);

    // Khóa mic → Dịch → TTS
    isSpeakingRef.current = true;
    if (onStatusChangeRef.current) onStatusChangeRef.current('translating');

    // Pause recognition while translating/speaking
    if (recognizerRef.current && wantListeningRef.current) {
      try { await recognizerRef.current.stopContinuousRecognitionAsync(); } catch { }
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
          } catch { }
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
          } catch { }
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

    // Dọn dẹp + resume recognition
    accumulatedTextRef.current = '';
    currentInterimRef.current = '';
    isSpeakingRef.current = false;
    if (onInterimTextRef.current) onInterimTextRef.current('');

    // Resume recognition if still wanting to listen
    if (wantListeningRef.current && recognizerRef.current) {
      try {
        await recognizerRef.current.startContinuousRecognitionAsync();
        if (onStatusChangeRef.current) onStatusChangeRef.current('listening');
      } catch {
        if (onStatusChangeRef.current) onStatusChangeRef.current('idle');
      }
    } else {
      if (onStatusChangeRef.current) onStatusChangeRef.current('idle');
    }
  }, []);

  // ====== Silence Timer ======
  const resetSilenceTimer = useCallback(() => {
    clearTimeout(silenceTimeoutRef.current);
    if (isSpeakingRef.current) return;

    const timeout = silenceMsRef.current || 4000;
    silenceTimeoutRef.current = setTimeout(() => {
      console.log(`⏰ [Silence] ${timeout / 1000}s timer fired!`);
      triggerTranslation();
    }, timeout);
  }, [triggerTranslation]);

  // ====== Start(inputLang) — Azure Speech SDK ======
  const start = useCallback(async (inputLang) => {
    try {
      accumulatedTextRef.current = '';
      currentInterimRef.current = '';
      isSpeakingRef.current = false;
      inputLangRef.current = inputLang;
      conversationHistoryRef.current = [];
      msgIdRef.current = Date.now();

      console.log(`🔑 [Start] inputLang=${inputLang}`);

      // Get Azure auth token
      const tokenRes = await fetch('/api/azure/token');
      const tokenData = await tokenRes.json();
      if (!tokenData.token) throw new Error('No Azure Speech token');

      console.log(`🎤 [Azure STT] Token obtained, region=${tokenData.region}`);

      // Dynamic import — Azure Speech SDK (large, only load when needed)
      const sdk = await import('microsoft-cognitiveservices-speech-sdk');

      // Create speech config from auth token
      const speechConfig = sdk.SpeechConfig.fromAuthorizationToken(tokenData.token, tokenData.region);

      // Tăng ngưỡng im lặng trước khi Azure ngắt câu (mặc định ~1s → 2s)
      // Giúp gộp các đoạn nói chậm/ngắt hơi thành 1 câu dài hơn
      speechConfig.setProperty('Speech_SegmentationSilenceTimeoutMs', '2000');

      // Map language codes to Azure locale format
      const langMap = { zh: 'zh-CN', vi: 'vi-VN', en: 'en-US', ja: 'ja-JP', ko: 'ko-KR' };
      const primaryLang = langMap[inputLang] || `${inputLang}-${inputLang.toUpperCase()}`;

      let audioConfig;
      let recognizer;

      if (autoDetectRef.current) {
        // Auto-detect: provide candidate languages
        const srcLocale = langMap[srcLangCodeRef.current] || 'zh-CN';
        const tgtLocale = langMap[tgtLangCodeRef.current] || 'vi-VN';
        const candidates = [...new Set([srcLocale, tgtLocale])]; // deduplicate
        console.log(`🌐 [Azure STT] Auto-detect candidates: ${candidates.join(', ')}`);

        const autoDetectConfig = sdk.AutoDetectSourceLanguageConfig.fromLanguages(candidates);
        audioConfig = sdk.AudioConfig.fromDefaultMicrophoneInput();
        recognizer = sdk.SpeechRecognizer.FromConfig(speechConfig, autoDetectConfig, audioConfig);
      } else {
        // Fixed language
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
        if (autoDetectRef.current) {
          try {
            const langResult = sdk.AutoDetectSourceLanguageResult.fromResult(e.result);
            const detectedLang = langResult?.language;
            if (detectedLang) {
              const baseLang = detectedLang.split('-')[0];
              if (baseLang !== inputLangRef.current) {
                console.log(`🌐 [Auto-detect] ${inputLangRef.current} → ${baseLang}`);
                inputLangRef.current = baseLang;
                setActiveLang(baseLang);
              }
            }
          } catch { }
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
        if (autoDetectRef.current) {
          try {
            const langResult = sdk.AutoDetectSourceLanguageResult.fromResult(e.result);
            const detectedLang = langResult?.language;
            if (detectedLang) {
              const baseLang = detectedLang.split('-')[0];
              if (baseLang !== inputLangRef.current) {
                console.log(`🌐 [Auto-detect] ${inputLangRef.current} → ${baseLang}`);
                inputLangRef.current = baseLang;
                setActiveLang(baseLang);
              }
            }
          } catch { }
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

      // Start continuous recognition
      await recognizer.startContinuousRecognitionAsync();
      console.log('⏳ [Azure STT] Recognition started, waiting for session...');

    } catch (err) {
      console.error('❌ [Start]', err);
      if (onErrorRef.current) onErrorRef.current(err.message);
    }
  }, [resetSilenceTimer]);

  // ====== Stop ======
  const stop = useCallback(async () => {
    console.log('🛑 Stop');
    wantListeningRef.current = false;
    clearTimeout(silenceTimeoutRef.current);
    clearInterval(elapsedTimerRef.current);

    // Stop Azure recognizer
    if (recognizerRef.current) {
      try {
        await recognizerRef.current.stopContinuousRecognitionAsync();
        recognizerRef.current.close();
      } catch { }
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

  useEffect(() => {
    return () => {
      wantListeningRef.current = false;
      clearTimeout(silenceTimeoutRef.current);
      clearInterval(elapsedTimerRef.current);
      if (recognizerRef.current) {
        try { recognizerRef.current.close(); } catch { }
        recognizerRef.current = null;
      }
    };
  }, []);

  return { isListening, elapsed, activeLang, start, stop };
}
