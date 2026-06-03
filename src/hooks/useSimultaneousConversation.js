'use client';
import { useState, useRef, useCallback, useEffect } from 'react';

/**
 * useSimultaneousConversation — Continuous, Non-Blocking Translation Queue Hook
 * Supports:
 *   - Azure Speech SDK (STT)
 *   - ElevenLabs Scribe v2 (STT via WebSocket)
 *
 * How it works:
 *   - The speech recognizer (STT) stays open continuously.
 *   - When silence is detected, the current text is grabbed, cleared immediately from the buffer (so the mic can record the next sentence), and queued as a task.
 *   - A sequential background queue processor handles the translation (network call) and TTS playback one-by-one.
 *   - Supports `overlapListening` to allow simultaneous speaking and listening when using headphones.
 */

const VIET_DIACRITICS = /[àáảãạăắằẳẵặâấầẩẫậèéẻẽẹêếềểễệìíỉĩịòóỏõọôốồổỗộơớờởỡợùúủũụưứừửữựỳýỷỹỵđĐ]/;
const CJK_CHARS = /[\u4e00-\u9fff\u3400-\u4dbf\uf900-\ufaff]/;
const HANGUL_CHARS = /[\uac00-\ud7af\u1100-\u11ff]/;
const KANA_CHARS = /[\u3040-\u309f\u30a0-\u30ff]/;

function detectLangFromText(text, srcLang = 'zh', tgtLang = 'vi') {
  if (!text) return null;
  const hasViet = VIET_DIACRITICS.test(text);
  const hasCJK = CJK_CHARS.test(text);
  const hasKorean = HANGUL_CHARS.test(text);
  const hasJapanese = KANA_CHARS.test(text);

  if (hasViet) return 'vi';
  if (hasCJK) return 'zh';
  if (hasJapanese) return 'ja';
  if (hasKorean) return 'ko';

  // Context-aware Latin detection:
  if (/[a-zA-Z]/.test(text)) {
    if (srcLang === 'vi' || tgtLang === 'vi') return 'vi';
    return 'en';
  }
  return null;
}

function getSimilarityRatio(str1, str2) {
  if (!str1 || !str2) return 0;
  // Chuẩn hóa chuỗi: chuyển thành chữ thường, loại bỏ khoảng trắng và các ký tự đặc biệt
  const s1 = str1.toLowerCase().replace(/[.,\/#!$%\^&\*;:{}=\-_`~()?]/g, "").replace(/\s+/g, "").trim();
  const s2 = str2.toLowerCase().replace(/[.,\/#!$%\^&\*;:{}=\-_`~()?]/g, "").replace(/\s+/g, "").trim();
  if (s1 === s2) return 1.0;

  const len1 = s1.length;
  const len2 = s2.length;
  if (len1 === 0 || len2 === 0) return 0;

  // Thuật toán Levenshtein Distance
  const track = Array(len2 + 1).fill(null).map(() => Array(len1 + 1).fill(null));
  for (let i = 0; i <= len1; i += 1) track[0][i] = i;
  for (let j = 0; j <= len2; j += 1) track[j][0] = j;
  for (let j = 1; j <= len2; j += 1) {
    for (let i = 1; i <= len1; i += 1) {
      const indicator = s1[i - 1] === s2[j - 1] ? 0 : 1;
      track[j][i] = Math.min(
        track[j][i - 1] + 1, // deletion
        track[j - 1][i] + 1, // insertion
        track[j - 1][i - 1] + indicator // substitution
      );
    }
  }
  const distance = track[len2][len1];
  const maxLen = Math.max(len1, len2);
  return (maxLen - distance) / maxLen;
}

export default function useSimultaneousConversation({
  srcLangCode,
  tgtLangCode,
  engine = 'openai',
  silenceMs = 3000,
  autoDetect = false,
  micMode = 'continuous', // 'continuous' | 'hold'
  autoTTS = true,
  provider = 'azure', // 'azure' | 'elevenlabs' | 'web-speech'
  ttsProvider = 'azure', // 'azure' | 'elevenlabs'
  overlapListening = false, // Headphones mode: microphone remains active during TTS playback
  useHeadphones = true,     // Bật chế độ đeo tai nghe khi nghe đè
  speed = 1.0,              // Tốc độ phát giọng nói
  echoCancellationAI = false,
  onInterimText,
  onFinalResult,
  onStatusChange,
  onError,
  getVoiceForLang,
}) {
  const [isListening, setIsListening] = useState(false);
  const [elapsed, setElapsed] = useState(0);
  const [activeLang, setActiveLang] = useState(null);
  const [queueLength, setQueueLength] = useState(0);

  const recognizerRef = useRef(null);
  const startTimeRef = useRef(0);
  const elapsedTimerRef = useRef(null);

  const isSpeakingRef = useRef(false);
  const wantListeningRef = useRef(false);
  const inputLangRef = useRef(null);
  const currentAudioRef = useRef(null);
  const currentAudioUrlRef = useRef(null);

  // ElevenLabs-specific refs
  const elWsRef = useRef(null);
  const elMediaRef = useRef(null);
  const elStreamRef = useRef(null);
  const azureStreamRef = useRef(null);
  const bgStreamRef = useRef(null);

  // WebSpeech-specific refs
  const webSpeechRecRef = useRef(null);
  const isWebSpeechFinalFiredRef = useRef(false);
  const webSpeechPendingResolveRef = useRef(null);
  const lastQueuedTextRef = useRef('');
  const lastRobotSpokenTextRef = useRef('');
  const isMicRunningRef = useRef(false);
  const userSpokeDuringTtsRef = useRef(false);

  const accumulatedTextRef = useRef('');
  const currentInterimRef = useRef('');
  const prevSessionsTextRef = useRef('');
  const activeTtsLangRef = useRef(null);
  const silenceTimeoutRef = useRef(null);
  const stoppingRef = useRef(false);

  // Task Queue for Non-Blocking Translation
  const translationQueueRef = useRef([]);
  const isProcessingQueueRef = useRef(false);

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
  const micModeRef = useRef(micMode);
  const autoTTSRef = useRef(autoTTS);
  const providerRef = useRef(provider);
  const ttsProviderRef = useRef(ttsProvider);
  const overlapListeningRef = useRef(overlapListening);
  const useHeadphonesRef = useRef(useHeadphones);
  const speedRef = useRef(speed);
  const echoCancellationAIRef = useRef(echoCancellationAI);

  // Update refs synchronously during render to completely bypass React scheduling lags
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
  micModeRef.current = micMode;
  autoTTSRef.current = autoTTS;
  providerRef.current = provider;
  ttsProviderRef.current = ttsProvider;
  overlapListeningRef.current = overlapListening;
  useHeadphonesRef.current = useHeadphones;
  speedRef.current = speed;
  echoCancellationAIRef.current = echoCancellationAI;

  const getOrCreateTtsAudio = useCallback(() => {
    if (typeof window === 'undefined') return null;
    if (!currentAudioRef.current) {
      const audio = new Audio();
      audio.preload = 'auto';
      audio.playsInline = true;
      try {
        audio.setAttribute('playsinline', 'true');
        audio.setAttribute('webkit-playsinline', 'true');
      } catch (e) { /* ignore */ }
      currentAudioRef.current = audio;
    }
    return currentAudioRef.current;
  }, []);

  const releaseCurrentAudioUrl = useCallback(() => {
    if (!currentAudioUrlRef.current) return;
    try { URL.revokeObjectURL(currentAudioUrlRef.current); } catch (e) { /* ignore */ }
    currentAudioUrlRef.current = null;
  }, []);

  const duckTtsVolume = useCallback(() => {
    if (currentAudioRef.current && isProcessingQueueRef.current) {
      let targetVolume = 1.0;
      if (overlapListeningRef.current) {
        targetVolume = useHeadphonesRef.current ? 0.80 : 0.50;
      }
      console.log(`🔈 [Audio Ducking] Giảm âm lượng robot phát loa xuống ${targetVolume * 100}% vì phát hiện người dùng đang nói`);
      currentAudioRef.current.volume = targetVolume;
    }
  }, []);

  const restoreTtsVolume = useCallback(() => {
    if (currentAudioRef.current) {
      currentAudioRef.current.volume = 1.0;
    }
  }, []);

  // ====== Setup Speech Recognizers (Azure) ======
  const setupRecognizer = useCallback(async (inputLang) => {
    if (recognizerRef.current) {
      try { recognizerRef.current.close(); } catch (e) { console.warn('⚠️ [Close old recognizer]', e); }
      recognizerRef.current = null;
    }
    if (azureStreamRef.current) {
      try { azureStreamRef.current.getTracks().forEach(t => t.stop()); } catch (e) { /* ignore */ }
      azureStreamRef.current = null;
    }

    const tokenRes = await fetch('/api/azure/token');
    const tokenData = await tokenRes.json();
    if (!tokenData.token) throw new Error('No Azure Speech token');

    console.log(`🔑 [setupRecognizer] Azure token region=${tokenData.region}, lang=${inputLang}`);

    const sdk = await import('microsoft-cognitiveservices-speech-sdk');
    const speechConfig = sdk.SpeechConfig.fromAuthorizationToken(tokenData.token, tokenData.region);
    speechConfig.setProperty('Speech_SegmentationSilenceTimeoutMs', '2000');

    const langMap = { zh: 'zh-CN', vi: 'vi-VN', en: 'en-US', ja: 'ja-JP', ko: 'ko-KR' };
    const primaryLang = langMap[inputLang] || `${inputLang}-${inputLang.toUpperCase()}`;

    // Tạo MediaStream tùy chỉnh chống méo tiếng / triệt tiêu âm của Chrome
    let stream = null;
    try {
      stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true
        }
      });
      azureStreamRef.current = stream;
    } catch (err) {
      console.warn('⚠️ [setupRecognizer] Không thể lấy Custom MediaStream, dùng mic mặc định:', err);
    }

    let audioConfig;
    let recognizer;

    if (autoDetectRef.current) {
      const srcLocale = langMap[srcLangCodeRef.current] || 'zh-CN';
      const tgtLocale = langMap[tgtLangCodeRef.current] || 'vi-VN';
      const candidates = [...new Set([srcLocale, tgtLocale])];
      console.log(`🌐 [Azure STT] Candidates: ${candidates.join(', ')}`);

      const autoDetectConfig = sdk.AutoDetectSourceLanguageConfig.fromLanguages(candidates);
      audioConfig = stream 
        ? sdk.AudioConfig.fromStreamInput(stream)
        : sdk.AudioConfig.fromDefaultMicrophoneInput();
      recognizer = sdk.SpeechRecognizer.FromConfig(speechConfig, autoDetectConfig, audioConfig);
    } else {
      speechConfig.speechRecognitionLanguage = primaryLang;
      audioConfig = stream
        ? sdk.AudioConfig.fromStreamInput(stream)
        : sdk.AudioConfig.fromDefaultMicrophoneInput();
      recognizer = new sdk.SpeechRecognizer(speechConfig, audioConfig);
    }

    recognizerRef.current = recognizer;

    recognizer.recognizing = (s, e) => {
      if (isSpeakingRef.current) return;
      const transcript = e.result.text;
      if (!transcript) return;

      if (isProcessingQueueRef.current) {
        userSpokeDuringTtsRef.current = true;
        duckTtsVolume();
      }

      if (autoDetectRef.current) {
        try {
          const detectedLocale = e.result.properties?.getProperty?.(
            sdk.PropertyId.SpeechServiceConnection_AutoDetectSourceLanguageResult
          );
          if (detectedLocale && detectedLocale !== 'Unknown') {
            const baseLang = detectedLocale.split('-')[0];
            if (activeTtsLangRef.current === baseLang) {
              console.log(`🛡️ [Azure AEC Lang Filter] Bỏ qua đổi ngôn ngữ tự động sang "${baseLang}" vì Robot đang phát loa.`);
            } else if (baseLang !== inputLangRef.current) {
              console.log(`🌐 [Auto-detect interim] ${inputLangRef.current} → ${baseLang}`);
              inputLangRef.current = baseLang;
              setActiveLang(baseLang);
            }
          }
        } catch (e) { console.warn('⚠️ [Auto-detect interim]', e); }
      }

      currentInterimRef.current = transcript;
      const display = accumulatedTextRef.current + (accumulatedTextRef.current ? ' ' : '') + transcript;
      if (onInterimTextRef.current) onInterimTextRef.current(display);
    };

    recognizer.recognized = (s, e) => {
      if (isSpeakingRef.current) return;
      if (e.result.reason === sdk.ResultReason.NoMatch) return;

      const transcript = e.result.text;
      if (!transcript) return;

      if (isProcessingQueueRef.current) {
        userSpokeDuringTtsRef.current = true;
        duckTtsVolume();
      }

      if (autoDetectRef.current) {
        try {
          const detectedLocale = e.result.properties?.getProperty?.(
            sdk.PropertyId.SpeechServiceConnection_AutoDetectSourceLanguageResult
          );
          if (detectedLocale && detectedLocale !== 'Unknown') {
            const baseLang = detectedLocale.split('-')[0];
            if (activeTtsLangRef.current === baseLang) {
              console.log(`🛡️ [Azure AEC Lang Filter] Bỏ qua đổi ngôn ngữ tự động sang "${baseLang}" vì Robot đang phát loa.`);
            } else if (baseLang !== inputLangRef.current) {
              console.log(`🌐 [Auto-detect FINAL] ${inputLangRef.current} → ${baseLang}`);
              inputLangRef.current = baseLang;
              setActiveLang(baseLang);
            }
          }
        } catch (e) { console.warn('⚠️ [Auto-detect final]', e); }
      }

      console.log(`📝 FINAL segment: "${transcript}"`);
      accumulatedTextRef.current += (accumulatedTextRef.current ? ' ' : '') + transcript;
      currentInterimRef.current = '';
      if (onInterimTextRef.current) onInterimTextRef.current(accumulatedTextRef.current);
      resetSilenceTimer();
    };

    recognizer.canceled = (s, e) => {
      if (e.reason === sdk.CancellationReason.Error) {
        console.error(`❌ [Azure STT] Error: ${e.errorDetails}`);
        if (onErrorRef.current) onErrorRef.current(`Azure STT: ${e.errorDetails}`);
      }
    };

    recognizer.sessionStarted = () => {
      console.log('🟢 [Azure STT] Session active');
      if (onStatusChangeRef.current) onStatusChangeRef.current('listening');
    };

    await recognizer.startContinuousRecognitionAsync();
    return recognizer;
  }, []);

  // ====== Setup Speech Recognizers (ElevenLabs) ======
  const setupElevenLabsSTT = useCallback(async (inputLang) => {
    if (elWsRef.current) {
      try { elWsRef.current.close(); } catch (e) { /* ignore */ }
      elWsRef.current = null;
    }
    if (elMediaRef.current) {
      try { elMediaRef.current.processor?.disconnect(); } catch (e) { /* ignore */ }
      elMediaRef.current = null;
    }
    if (elStreamRef.current) {
      try { elStreamRef.current.getTracks().forEach(t => t.stop()); } catch (e) { /* ignore */ }
      elStreamRef.current = null;
    }

    const tokenRes = await fetch('/api/elevenlabs');
    const tokenData = await tokenRes.json();
    if (!tokenData.token) throw new Error('No ElevenLabs token');

    const stream = await navigator.mediaDevices.getUserMedia({
      audio: {
        sampleRate: { ideal: 16000 },
        channelCount: 1,
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true
      }
    });
    elStreamRef.current = stream;

    const wsUrl = `wss://api.elevenlabs.io/v1/speech-to-text/realtime?model_id=scribe_v2_realtime&language_code=${inputLang}&audio_format=pcm_16000&commit_strategy=vad&token=${tokenData.token}`;
    const ws = new WebSocket(wsUrl);
    elWsRef.current = ws;

    ws.onopen = () => {
      console.log('🟢 [ElevenLabs STT] WebSocket connected');
      const audioContext = new AudioContext({ sampleRate: 16000 });
      const source = audioContext.createMediaStreamSource(stream);
      const processor = audioContext.createScriptProcessor(4096, 1, 1);

      source.connect(processor);
      processor.connect(audioContext.destination);

      processor.onaudioprocess = (e) => {
        if (!elWsRef.current || elWsRef.current.readyState !== WebSocket.OPEN) return;
        if (isSpeakingRef.current) return;

        const pcmData = e.inputBuffer.getChannelData(0);
        const int16 = new Int16Array(pcmData.length);
        for (let i = 0; i < pcmData.length; i++) {
          int16[i] = Math.max(-32768, Math.min(32767, Math.floor(pcmData[i] * 32768)));
        }

        const bytes = new Uint8Array(int16.buffer);
        let binary = '';
        for (let i = 0; i < bytes.length; i++) {
          binary += String.fromCharCode(bytes[i]);
        }
        const base64 = btoa(binary);

        try {
          ws.send(JSON.stringify({
            message_type: 'input_audio_chunk',
            audio_base_64: base64,
            sample_rate: 16000,
          }));
        } catch (sendErr) { /* ignore */ }
      };

      elMediaRef.current = { processor, source, audioContext };
      if (onStatusChangeRef.current) onStatusChangeRef.current('listening');
    };

    ws.onmessage = (event) => {
      if (isSpeakingRef.current) return;
      if (stoppingRef.current) return;
      try {
        const data = JSON.parse(event.data);
        const messageType = data.message_type || data.type;

        if (messageType === 'partial_transcript') {
          const transcript = data.text || '';
          if (!transcript) return;

          if (isProcessingQueueRef.current) {
            userSpokeDuringTtsRef.current = true;
            duckTtsVolume();
          }

          currentInterimRef.current = transcript;
          const display = accumulatedTextRef.current + (accumulatedTextRef.current ? ' ' : '') + transcript;
          if (onInterimTextRef.current) onInterimTextRef.current(display);
        }

        if (messageType === 'committed_transcript') {
          const transcript = data.text || '';
          if (!transcript) return;

          if (isProcessingQueueRef.current) {
            userSpokeDuringTtsRef.current = true;
            duckTtsVolume();
          }

          accumulatedTextRef.current += (accumulatedTextRef.current ? ' ' : '') + transcript;
          currentInterimRef.current = '';
          if (onInterimTextRef.current) onInterimTextRef.current(accumulatedTextRef.current);
          resetSilenceTimer();
        }
      } catch (e) { console.warn('⚠️ [ElevenLabs parse error]', e); }
    };

    ws.onerror = () => {
      if (onErrorRef.current) onErrorRef.current('ElevenLabs STT WebSocket error');
    };

    return ws;
  }, []);

  const resetSilenceTimer = useCallback(() => {
    clearTimeout(silenceTimeoutRef.current);
    if (isSpeakingRef.current) return;
    if (micModeRef.current === 'hold') return;

    const timeout = silenceMsRef.current || 3000;
    silenceTimeoutRef.current = setTimeout(() => {
      console.log(`⏰ Silence of ${timeout / 1000}s detected - queueing translation`);
      queueTranslationTask();
    }, timeout);
  }, []);

  // ====== Setup Web Speech API native ======
  const setupWebSpeechRecognizer = useCallback((inputLang) => {
    if (typeof window === 'undefined') return null;
    const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (!SpeechRecognition) {
      throw new Error('Trình duyệt không hỗ trợ Web Speech API.');
    }

    prevSessionsTextRef.current = accumulatedTextRef.current;

    const rec = new SpeechRecognition();
    rec.continuous = true;
    rec.interimResults = true;
    rec.maxAlternatives = 1;

    const langMap = { zh: 'zh-CN', vi: 'vi-VN', en: 'en-US', ja: 'ja-JP', ko: 'ko-KR' };
    rec.lang = langMap[inputLang] || inputLang;

    rec.onstart = () => {
      console.log('🟢 [Web Speech native] Session started');
      isMicRunningRef.current = true;
      if (onStatusChangeRef.current) onStatusChangeRef.current('listening');
    };

    rec.onresult = (e) => {
      if (isSpeakingRef.current) return;
      isWebSpeechFinalFiredRef.current = false;

      // Đánh dấu người dùng đã nói trong lúc dịch/phát âm
      if (isProcessingQueueRef.current) {
        userSpokeDuringTtsRef.current = true;
        duckTtsVolume();
      }

      let sessionFinalText = '';
      let sessionInterimText = '';
      let hasNewFinal = false;

      for (let i = 0; i < e.results.length; i++) {
        const transcript = e.results[i][0].transcript.trim();
        if (e.results[i].isFinal) {
          if (i >= e.resultIndex) {
            hasNewFinal = true;
          }
          if (!sessionFinalText) {
            sessionFinalText = transcript;
          } else {
            const cleanAcc = sessionFinalText.trim().toLowerCase();
            const cleanTrans = transcript.toLowerCase();
            if (cleanTrans.startsWith(cleanAcc)) {
              sessionFinalText = transcript;
            } else {
              sessionFinalText += ' ' + transcript;
            }
          }
        } else {
          if (!sessionInterimText) {
            sessionInterimText = transcript;
          } else {
            const cleanInt = sessionInterimText.trim().toLowerCase();
            const cleanTrans = transcript.toLowerCase();
            if (cleanTrans.startsWith(cleanInt)) {
              sessionInterimText = transcript;
            } else {
              sessionInterimText += ' ' + transcript;
            }
          }
        }
      }

      // Ghép văn bản của phiên hiện tại vào văn bản tích lũy của các phiên trước
      const prev = prevSessionsTextRef.current || '';
      accumulatedTextRef.current = prev + (prev && sessionFinalText ? ' ' : '') + sessionFinalText;
      currentInterimRef.current = sessionInterimText;

      if (hasNewFinal) {
        isWebSpeechFinalFiredRef.current = true;
        
        if (webSpeechPendingResolveRef.current) {
          webSpeechPendingResolveRef.current();
          webSpeechPendingResolveRef.current = null;
        }
      }

      const display = (accumulatedTextRef.current + (accumulatedTextRef.current && currentInterimRef.current ? ' ' : '') + currentInterimRef.current).trim();
      if (onInterimTextRef.current) onInterimTextRef.current(display);

      resetSilenceTimer();
    };

    rec.onerror = (e) => {
      if (e.error === 'no-speech' || e.error === 'aborted') return;
      console.error(`❌ [Web Speech Lỗi]`, e.error);
      if (onErrorRef.current) onErrorRef.current(`Micro: ${e.error}`);
    };

    rec.onend = () => {
      console.log('🔴 [Web Speech native] Session stopped');
      isMicRunningRef.current = false;
      if (wantListeningRef.current && !isSpeakingRef.current && providerRef.current === 'web-speech') {
        setTimeout(() => {
          if (wantListeningRef.current && !isSpeakingRef.current && !isMicRunningRef.current) {
            try {
              setupWebSpeechRecognizer(inputLangRef.current);
              console.log('🔄 [Web Speech native] Restarted safely after 150ms delay');
            } catch (_) { /* ignore */ }
          }
        }, 150);
      }
    };

    webSpeechRecRef.current = rec;
    rec.start();
    return rec;
  }, [resetSilenceTimer]);

  // ====== QUEUE: Đẩy câu nói vào hàng đợi và tiếp tục ghi âm ======
  const queueTranslationTask = useCallback(() => {
    let text = accumulatedTextRef.current.trim();
    const interim = currentInterimRef.current.trim();
    if (interim) {
      text = text ? text + ' ' + interim : interim;
    }
    if (!text) return;

    // Lọc nhiễu & từ rác
    text = text.replace(/(?<=^|\s|[.,!?])(ừm|ờ|à|ơi|ơ)(?=\s|[.,!?]|$)/gi, '');
    text = text.replace(/\b(uh|um|er|erm)\b/gi, '');
    if (!text) return;

    // Bộ lọc chống tạp âm click/nhiễu cực ngắn (Dạ, À, Ừ...) xuất hiện khi loa đang phát âm (TTS)
    if (overlapListeningRef.current && isProcessingQueueRef.current) {
      const cleanWord = text.replace(/[.,\/#!$%\^&\*;:{}=\-_`~()?]/g, "").trim().toLowerCase();
      const shortFillers = ['dạ', 'à', 'ừ', 'ồ', 'ok', 'yes', 'yeah', 'ah', 'oh', 'uh', 'um', 'hả', 'hử', 'nhé', 'thế'];
      if (shortFillers.includes(cleanWord)) {
        console.log(`🛡️ [AEC Noise Filter] Bỏ qua âm nhiễu cực ngắn "${text}" trong lúc máy đang phát loa.`);
        accumulatedTextRef.current = '';
        currentInterimRef.current = '';
        if (onInterimTextRef.current) onInterimTextRef.current('');
        
        userSpokeDuringTtsRef.current = false;
        
        if (providerRef.current === 'web-speech' && webSpeechRecRef.current) {
          try {
            webSpeechRecRef.current.abort();
          } catch (e) { /* ignore */ }
        }
        return;
      }
    }

    // Bộ lọc chống vọng đồng âm xuyên ngôn ngữ (Cross-lingual Homophonic Echo Filter)
    if (overlapListeningRef.current && lastQueuedTextRef.current) {
      const wordsCurrent = text.toLowerCase().replace(/[.,!?;:]/g, '').trim().split(/\s+/).slice(0, 2);
      const wordsPrev = lastQueuedTextRef.current.toLowerCase().replace(/[.,!?;:]/g, '').trim().split(/\s+/).slice(0, 2);
      
      if (wordsCurrent.length > 0 && wordsPrev.length > 0) {
        const stripDiacritics = (str) => {
          return str.normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/đ/g, 'd');
        };
        
        const wCurr0 = stripDiacritics(wordsCurrent[0]);
        const wPrev0 = stripDiacritics(wordsPrev[0]);
        
        // Độ tương đồng không dấu của từ đầu tiên (ví dụ: chú vs chúc)
        const firstWordSimilarity = getSimilarityRatio(wCurr0, wPrev0);
        console.log(`🛡️ [AI Homophone Check] So sánh âm từ đầu: "${wCurr0}" vs "${wPrev0}" (Độ tương đồng: ${(firstWordSimilarity * 100).toFixed(1)}%)`);
        
        if (firstWordSimilarity >= 0.70) {
          console.log(`🚫 [AI Homophone Filter] Phát hiện tiếng vọng đồng âm từ câu trước ("${text.slice(0, 30)}..." vs "${lastQueuedTextRef.current.slice(0, 30)}..."), tự động BỎ QUA.`);
          accumulatedTextRef.current = '';
          currentInterimRef.current = '';
          if (onInterimTextRef.current) onInterimTextRef.current('');
          
          userSpokeDuringTtsRef.current = false;
          
          if (providerRef.current === 'web-speech' && webSpeechRecRef.current) {
            try {
              webSpeechRecRef.current.abort();
            } catch (e) { /* ignore */ }
          }
          return;
        }
      }
    }

    // Bộ lọc chống vọng AI (Thử nghiệm) bằng thuật toán so sánh chuỗi Levenshtein
    if (echoCancellationAIRef.current && lastRobotSpokenTextRef.current) {
      const similarity = getSimilarityRatio(text, lastRobotSpokenTextRef.current);
      console.log(`🛡️ [AI Echo Check] Độ tương đồng với câu loa phát: ${(similarity * 100).toFixed(1)}% ("${text}" vs "${lastRobotSpokenTextRef.current}")`);
      if (similarity > 0.70) {
        console.log(`🚫 [AI Echo Filter] Phát hiện tiếng vọng dội lại từ loa ngoài (trùng ${(similarity * 100).toFixed(1)}%), tự động BỎ QUA.`);
        accumulatedTextRef.current = '';
        currentInterimRef.current = '';
        if (onInterimTextRef.current) onInterimTextRef.current('');
        
        // Ngắt mic Web Speech để làm sạch buffer (đã abort là phải dọn sạch context của Chrome)
        if (providerRef.current === 'web-speech' && webSpeechRecRef.current) {
          try {
            webSpeechRecRef.current.abort();
          } catch (e) { /* ignore */ }
        }
        return;
      }
    }

    // Chống trùng lặp tuyệt đối
    if (lastQueuedTextRef.current === text) {
      console.log(`🚫 [Queue] Bỏ qua câu trùng lặp: "${text}"`);
      accumulatedTextRef.current = '';
      currentInterimRef.current = '';
      if (onInterimTextRef.current) onInterimTextRef.current('');
      return;
    }

    lastQueuedTextRef.current = text;

    const noiseWords = ['phẩy.', 'chấm.', 'phẩy', 'chấm', 'hỏi.', 'hỏi', 'comma', 'period', 'dot'];
    const cleanLower = text.replace(/[.,!?;:]+$/g, '').trim().toLowerCase();
    if (noiseWords.includes(cleanLower) || /^[.,!?;:\s]+$/.test(text)) {
      console.log(`🚫 Bỏ qua nhiễu: "${text}"`);
      accumulatedTextRef.current = '';
      currentInterimRef.current = '';
      if (onInterimTextRef.current) onInterimTextRef.current('');
      return;
    }

    // Tiếng Anh rác ngắn do micro thu sai
    const isPureEnglish = /^[a-zA-Z0-9\s.,!?'"\-:;()]+$/.test(text.trim());
    const wordCount = text.trim().split(/\s+/).length;
    if (isPureEnglish && wordCount <= 4 && inputLangRef.current !== 'en') {
      console.log(`🚫 Bỏ qua nhiễu Latin ngắn: "${text}"`);
      accumulatedTextRef.current = '';
      currentInterimRef.current = '';
      if (onInterimTextRef.current) onInterimTextRef.current('');
      return;
    }

    // Nhận dạng ngôn ngữ từ nội dung
    if (autoDetectRef.current) {
      const textLang = detectLangFromText(text, srcLangCodeRef.current, tgtLangCodeRef.current);
      if (textLang && textLang !== inputLangRef.current) {
        if (activeTtsLangRef.current === textLang) {
          console.log(`🛡️ [Text AEC Lang Filter] Bỏ qua đổi ngôn ngữ tự động sang "${textLang}" vì Robot đang phát loa.`);
        } else {
          console.log(`🔍 [Text-detect simultaneous] "${text.slice(0, 30)}..." → ${textLang} (was: ${inputLangRef.current})`);
          inputLangRef.current = textLang;
          setActiveLang(textLang);
        }
      }
    }

    const fromLang = inputLangRef.current;
    const toLang = fromLang === srcLangCodeRef.current ? tgtLangCodeRef.current : srcLangCodeRef.current;

    if (fromLang === toLang) {
      accumulatedTextRef.current = '';
      currentInterimRef.current = '';
      if (onInterimTextRef.current) onInterimTextRef.current('');
      return;
    }

    // ====== KHÔNG TẮT MIC: Chừa không gian thu âm tiếp theo ======
    const taskText = text;
    accumulatedTextRef.current = '';
    currentInterimRef.current = '';
    if (onInterimTextRef.current) onInterimTextRef.current('');

    // For Web Speech: abort recognition to immediately clean buffer and force split the conversation into a new bubble
    if (providerRef.current === 'web-speech' && webSpeechRecRef.current) {
      try {
        webSpeechRecRef.current.abort();
      } catch (e) { /* ignore */ }
    }

    // For Azure autoDetect: restart recognizer to reset Azure's auto-detect language session memory.
    // This avoids getting "stuck" in a single language acoustic model.
    if (providerRef.current === 'azure' && autoDetectRef.current && recognizerRef.current) {
      console.log('🔄 [Auto-detect Azure] Khởi động lại recognizer để reset bộ nhớ ngôn ngữ...');
      setupRecognizer(inputLangRef.current).catch(err => {
        console.warn('⚠️ Lỗi khởi động lại Azure recognizer:', err);
      });
    }

    const taskId = ++msgIdRef.current;
    console.log(`📦 [Queue] Đẩy tác vụ #${taskId} vào hàng đợi: "${taskText.slice(0, 50)}..."`);
    
    translationQueueRef.current.push({
      id: taskId,
      text: taskText,
      fromLang,
      toLang
    });
    setQueueLength(translationQueueRef.current.length);

    // Kích hoạt xử lý hàng đợi
    processTranslationQueue();
  }, [setupRecognizer]);

  // ====== PROCESS QUEUE: Xử lý các tác vụ dịch tuần tự ======
  const processTranslationQueue = useCallback(async () => {
    if (isProcessingQueueRef.current) return;
    if (translationQueueRef.current.length === 0) {
      setQueueLength(0);
      if (wantListeningRef.current) {
        if (onStatusChangeRef.current) onStatusChangeRef.current('listening');
      } else {
        if (onStatusChangeRef.current) onStatusChangeRef.current('idle');
      }
      return;
    }

    isProcessingQueueRef.current = true;
    setQueueLength(translationQueueRef.current.length);
    const task = translationQueueRef.current[0];
    userSpokeDuringTtsRef.current = false;

    try {
      if (onStatusChangeRef.current) onStatusChangeRef.current('translating');
      console.log(`⏳ [Queue Engine] Đang dịch tác vụ #${task.id}: "${task.text.slice(0, 50)}"`);

      // 1. Dịch thuật (Streaming)
      const translateRes = await fetch('/api/translate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          text: task.text,
          sourceLang: task.fromLang,
          targetLang: task.toLang,
          engine: engineRef.current,
          history: conversationHistoryRef.current,
          stream: true,
        }),
        signal: AbortSignal.timeout(25000),
      });

      if (!translateRes.ok) throw new Error(`Translate error ${translateRes.status}`);

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
          } catch (e) { /* ignore */ }
        }
        if (streamDone) break;
      }

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
          } catch (e) { /* ignore */ }
        }
      }

      translatedText = translatedText.trim();
      if (!translatedText) throw new Error('Empty translation');

      // Lưu lại câu robot sắp đọc để phục vụ bộ lọc chống vọng AI
      lastRobotSpokenTextRef.current = translatedText;

      console.log(`✅ [Queue Engine] Hoàn thành dịch #${task.id} -> "${translatedText.slice(0, 50)}"`);

      if (onFinalResultRef.current) {
        onFinalResultRef.current({ id: task.id, originalText: task.text, translatedText, fromLang: task.fromLang, toLang: task.toLang });
      }

      conversationHistoryRef.current.push(
        { role: 'user', content: task.text },
        { role: 'assistant', content: translatedText }
      );
      if (conversationHistoryRef.current.length > 8) {
        conversationHistoryRef.current = conversationHistoryRef.current.slice(-8);
      }

      // 2. Phát âm (TTS)
      if (autoTTSRef.current) {
        const voiceId = getVoiceForLangRef.current ? getVoiceForLangRef.current(task.toLang) : null;

        if (voiceId === '__MUTED__') {
          console.log(`🔇 [Queue TTS] Loa đang bị tắt cho ngôn ngữ ${task.toLang}, bỏ qua đọc`);
        } else {
          // Kích hoạt mút mic chống rú âm nếu KHÔNG dùng tai nghe đè
          isSpeakingRef.current = !overlapListeningRef.current;
          // Lưu lại ngôn ngữ đang phát để chống dội âm nhận diện tự động
          activeTtsLangRef.current = task.toLang;
          if (onStatusChangeRef.current) onStatusChangeRef.current('speaking');

          const ttsRes = await fetch('/api/tts', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ text: translatedText, lang: task.toLang, voice: voiceId, provider: ttsProviderRef.current }),
            signal: AbortSignal.timeout(30000),
          });

          if (ttsRes.ok) {
            const blob = await ttsRes.blob();
            if (blob.size > 0) {
              const url = URL.createObjectURL(blob);
              const audio = getOrCreateTtsAudio();
              if (audio) {
                releaseCurrentAudioUrl();
                currentAudioUrlRef.current = url;
                audio.src = url;
                audio.currentTime = 0;
                audio.load();

                await new Promise(resolve => {
                  let resolved = false;
                  let durationTimeout = null;

                  const done = () => {
                    if (resolved) return;
                    resolved = true;
                    clearTimeout(safetyTimeout);
                    if (durationTimeout) clearTimeout(durationTimeout);
                    audio.onended = null;
                    audio.onerror = null;
                    audio.onloadedmetadata = null;
                    if (currentAudioUrlRef.current === url) {
                      try { URL.revokeObjectURL(url); } catch (e) { /* ignore */ }
                      currentAudioUrlRef.current = null;
                    }
                    resolve();
                  };

                  audio.onended = done;
                  audio.onerror = done;
                  
                  const safetyTimeout = setTimeout(() => {
                    console.warn('⚠️ [Queue TTS] Timeout an toàn phát âm, bỏ qua để giải phóng hàng đợi');
                    try { audio.pause(); } catch (e) { /* ignore */ }
                    done();
                  }, 15000);

                  audio.onloadedmetadata = () => {
                    if (!resolved && audio.duration && isFinite(audio.duration)) {
                      clearTimeout(safetyTimeout);
                      durationTimeout = setTimeout(() => {
                        if (!resolved) {
                          try { audio.pause(); } catch (e) { /* ignore */ }
                          done();
                        }
                      }, (audio.duration + 3) * 1000);
                    }
                  };

                  // Áp dụng tốc độ phát giọng nói (Speech Rate)
                  try {
                    audio.defaultPlaybackRate = speedRef.current;
                    audio.playbackRate = speedRef.current;
                  } catch (e) {
                    console.warn('⚠️ Gán playbackRate lỗi:', e);
                  }

                  audio.play().catch(() => { done(); });
                });
              } else {
                URL.revokeObjectURL(url);
              }
            }
          }
        }
      }
    } catch (err) {
      console.error(`❌ [Queue Engine Error] #${task.id}:`, err);
      if (onErrorRef.current) onErrorRef.current(err.message);
    } finally {
      // Giải phóng ngôn ngữ TTS đang phát để khôi phục nhận diện tự động
      activeTtsLangRef.current = null;

      // Khôi phục lại âm lượng phát loa cho lượt dịch tiếp theo
      restoreTtsVolume();

      // Giải phóng mic
      isSpeakingRef.current = false;
      
      // Xóa tác vụ hoàn thành khỏi hàng đợi
      translationQueueRef.current.shift();
      isProcessingQueueRef.current = false;
      setQueueLength(translationQueueRef.current.length);

      // Nếu dùng Web Speech, để đảm bảo 100% không bị treo mic sau khi phát loa:
      // Chúng ta sẽ chủ động giữ nguyên mic nếu bật Nghe đè để tránh tạo ra khoảng "điếc" (deaf window) đúng lúc người dùng bắt đầu câu tiếp theo.
      if (wantListeningRef.current && providerRef.current === 'web-speech') {
        if (overlapListeningRef.current) {
          // Khi BẬT Nghe đè: Luôn luôn giữ microphone chạy liên tục để nhạy bén bắt ngay từ đầu tiên của câu tiếp theo.
          console.log('🔄 [Finally Nghe đè] Giữ nguyên Microphone chạy liên tục, tránh khoảng điếc đầu câu');
          if (!isMicRunningRef.current) {
            try {
              setupWebSpeechRecognizer(inputLangRef.current);
            } catch (_) { /* ignore */ }
          }
        } else {
          // Khi TẮT Nghe đè: Chủ động abort mic cũ để giải phóng tài nguyên và khởi tạo lại sạch sẽ.
          if (webSpeechRecRef.current) {
            try {
              webSpeechRecRef.current.abort();
            } catch (e) { /* ignore */ }
          } else if (!isMicRunningRef.current) {
            try {
              setupWebSpeechRecognizer(inputLangRef.current);
            } catch (_) { /* ignore */ }
          }
        }
      }

      // Gọi xử lý phần tử tiếp theo
      processTranslationQueue();
    }
  }, [getOrCreateTtsAudio, releaseCurrentAudioUrl, setupWebSpeechRecognizer]);

  // ====== Start ======
  const start = useCallback(async (inputLang) => {
    try {
      accumulatedTextRef.current = '';
      currentInterimRef.current = '';
      prevSessionsTextRef.current = '';
      isSpeakingRef.current = false;
      stoppingRef.current = false;
      inputLangRef.current = inputLang;
      conversationHistoryRef.current = [];
      translationQueueRef.current = [];
      setQueueLength(0);
      isProcessingQueueRef.current = false;
      msgIdRef.current = Date.now();

      getOrCreateTtsAudio();

      wantListeningRef.current = true;
      setIsListening(true);
      setActiveLang(inputLang);
      setElapsed(0);
      startTimeRef.current = Date.now();
      elapsedTimerRef.current = setInterval(() => {
        setElapsed(Math.floor((Date.now() - startTimeRef.current) / 1000));
      }, 1000);

      if (onStatusChangeRef.current) onStatusChangeRef.current('connecting');

      // [AEC Background Stream] Kích hoạt khử vọng phần cứng toàn cục cho trình duyệt
      if (overlapListeningRef.current) {
        try {
          if (bgStreamRef.current) {
            try { bgStreamRef.current.getTracks().forEach(t => t.stop()); } catch (e) {}
            bgStreamRef.current = null;
          }
          const stream = await navigator.mediaDevices.getUserMedia({
            audio: {
              echoCancellation: true,
              noiseSuppression: true,
              autoGainControl: true
            }
          });
          bgStreamRef.current = stream;
          console.log('🛡️ [AEC Background Stream] Activated native hardware echo cancellation globally');
        } catch (err) {
          console.warn('⚠️ [AEC Background Stream] Không thể kích hoạt stream khử vọng nền:', err);
        }
      }

      if (providerRef.current === 'web-speech') {
        await setupWebSpeechRecognizer(inputLang);
      } else if (providerRef.current === 'elevenlabs') {
        await setupElevenLabsSTT(inputLang);
      } else {
        await setupRecognizer(inputLang);
      }
    } catch (err) {
      console.error('❌ [Simultaneous Start Error]', err);
      if (onErrorRef.current) onErrorRef.current(err.message);
      wantListeningRef.current = false;
      setIsListening(false);
    }
  }, [setupRecognizer, setupElevenLabsSTT, setupWebSpeechRecognizer, getOrCreateTtsAudio]);

  // ====== Stop ======
  const stop = useCallback(async () => {
    console.log('🛑 Stop Simultaneous Mode');
    stoppingRef.current = true;
    wantListeningRef.current = false;
    clearTimeout(silenceTimeoutRef.current);
    clearInterval(elapsedTimerRef.current);

    // Dọn dẹp background AEC stream nếu có
    if (bgStreamRef.current) {
      try {
        bgStreamRef.current.getTracks().forEach(t => t.stop());
      } catch (e) { /* ignore */ }
      bgStreamRef.current = null;
      console.log('🛡️ [AEC Background Stream] Deactivated');
    }

    // Stop STT engines
    if (providerRef.current === 'web-speech') {
      if (webSpeechRecRef.current) {
        try { webSpeechRecRef.current.stop(); } catch (e) { /* ignore */ }
      }

      // Đợi 150ms siêu ngắn để Web Speech trả nốt kết quả isFinal cuối cùng
      await new Promise((resolve) => {
        const timeout = setTimeout(() => {
          resolve();
        }, 150);
        
        if (!currentInterimRef.current.trim()) {
          clearTimeout(timeout);
          resolve();
        } else {
          webSpeechPendingResolveRef.current = () => {
            clearTimeout(timeout);
            resolve();
          };
        }
      });
    } else if (providerRef.current === 'elevenlabs') {
      if (elWsRef.current) {
        try { elWsRef.current.close(); } catch (e) { /* ignore */ }
        elWsRef.current = null;
      }
      if (elMediaRef.current) {
        try {
          elMediaRef.current.processor?.disconnect();
          elMediaRef.current.source?.disconnect();
          elMediaRef.current.audioContext?.close();
        } catch (e) { /* ignore */ }
        elMediaRef.current = null;
      }
      if (elStreamRef.current) {
        try { elStreamRef.current.getTracks().forEach(t => t.stop()); } catch (e) { /* ignore */ }
        elStreamRef.current = null;
      }
    } else {
      if (recognizerRef.current) {
        try {
          await recognizerRef.current.stopContinuousRecognitionAsync();
          recognizerRef.current.close();
        } catch (e) { /* ignore */ }
        recognizerRef.current = null;
      }
      if (azureStreamRef.current) {
        try { azureStreamRef.current.getTracks().forEach(t => t.stop()); } catch (e) { /* ignore */ }
        azureStreamRef.current = null;
      }
    }

    setIsListening(false);
    setActiveLang(null);

    // Nếu còn từ đệm chưa dịch nốt khi bấm dừng
    const hasText = accumulatedTextRef.current.trim() || currentInterimRef.current.trim();
    if (hasText) {
      console.log('🛑 [Stop] Gom từ cuối cùng vào hàng đợi');
      queueTranslationTask();
    } else {
      if (translationQueueRef.current.length === 0) {
        if (onStatusChangeRef.current) onStatusChangeRef.current('idle');
      }
    }
  }, [queueTranslationTask]);

  // ====== StopHold (For hold key in simultaneous mode) ======
  const stopHold = useCallback(async () => {
    console.log('🛑 [Hold] User released key in simultaneous mode');
    clearTimeout(silenceTimeoutRef.current);

    if (providerRef.current === 'web-speech') {
      if (webSpeechRecRef.current) {
        try { webSpeechRecRef.current.stop(); } catch (e) { /* ignore */ }
      }

      // Đợi 150ms siêu ngắn để Web Speech trả nốt kết quả isFinal cuối cùng
      await new Promise((resolve) => {
        const timeout = setTimeout(() => {
          resolve();
        }, 150);
        
        if (!currentInterimRef.current.trim()) {
          clearTimeout(timeout);
          resolve();
        } else {
          webSpeechPendingResolveRef.current = () => {
            clearTimeout(timeout);
            resolve();
          };
        }
      });
    } else if (providerRef.current === 'elevenlabs') {
      if (elWsRef.current) {
        try { elWsRef.current.close(); } catch (e) { /* ignore */ }
        elWsRef.current = null;
      }
      if (elMediaRef.current) {
        try {
          elMediaRef.current.processor?.disconnect();
          elMediaRef.current.source?.disconnect();
          elMediaRef.current.audioContext?.close();
        } catch (e) { /* ignore */ }
        elMediaRef.current = null;
      }
      if (elStreamRef.current) {
        try { elStreamRef.current.getTracks().forEach(t => t.stop()); } catch (e) { /* ignore */ }
        elStreamRef.current = null;
      }
    } else {
      if (recognizerRef.current) {
        try {
          await recognizerRef.current.stopContinuousRecognitionAsync();
          recognizerRef.current.close();
        } catch (e) { /* ignore */ }
        recognizerRef.current = null;
      }
      if (azureStreamRef.current) {
        try { azureStreamRef.current.getTracks().forEach(t => t.stop()); } catch (e) { /* ignore */ }
        azureStreamRef.current = null;
      }
    }

    const hasText = accumulatedTextRef.current.trim() || currentInterimRef.current.trim();
    if (hasText) {
      queueTranslationTask();
    } else {
      wantListeningRef.current = false;
      clearInterval(elapsedTimerRef.current);
      setIsListening(false);
      setActiveLang(null);
      if (translationQueueRef.current.length === 0) {
        if (onStatusChangeRef.current) onStatusChangeRef.current('idle');
      }
    }
  }, [queueTranslationTask]);

  // ====== StopSpeaking ======
  const stopSpeaking = useCallback(async () => {
    console.log('🔇 [StopSpeaking] User muted speaker');
    if (currentAudioRef.current) {
      const audio = currentAudioRef.current;
      try { audio.pause(); audio.currentTime = 0; } catch (e) { /* ignore */ }
      try { audio.dispatchEvent(new Event('ended')); } catch (e) { /* ignore */ }
    }
  }, []);

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      wantListeningRef.current = false;
      clearTimeout(silenceTimeoutRef.current);
      clearInterval(elapsedTimerRef.current);
      if (currentAudioRef.current) {
        try {
          currentAudioRef.current.pause();
          currentAudioRef.current.removeAttribute('src');
          currentAudioRef.current.load();
        } catch (e) { /* ignore */ }
        currentAudioRef.current = null;
      }
      if (currentAudioUrlRef.current) {
        try { URL.revokeObjectURL(currentAudioUrlRef.current); } catch (e) { /* ignore */ }
        currentAudioUrlRef.current = null;
      }
      if (recognizerRef.current) {
        try { recognizerRef.current.close(); } catch (e) { /* ignore */ }
        recognizerRef.current = null;
      }
      if (azureStreamRef.current) {
        try { azureStreamRef.current.getTracks().forEach(t => t.stop()); } catch (e) { /* ignore */ }
        azureStreamRef.current = null;
      }
      if (bgStreamRef.current) {
        try { bgStreamRef.current.getTracks().forEach(t => t.stop()); } catch (e) { /* ignore */ }
        bgStreamRef.current = null;
      }
      if (webSpeechRecRef.current) {
        try {
          webSpeechRecRef.current.onstart = null;
          webSpeechRecRef.current.onresult = null;
          webSpeechRecRef.current.onerror = null;
          webSpeechRecRef.current.onend = null;
          webSpeechRecRef.current.abort();
        } catch (e) { /* ignore */ }
        webSpeechRecRef.current = null;
      }
      if (elWsRef.current) {
        try { elWsRef.current.close(); } catch (e) { /* ignore */ }
        elWsRef.current = null;
      }
      if (elMediaRef.current) {
        try {
          elMediaRef.current.processor?.disconnect();
          elMediaRef.current.source?.disconnect();
          elMediaRef.current.audioContext?.close();
        } catch (e) { /* ignore */ }
        elMediaRef.current = null;
      }
      if (elStreamRef.current) {
        try { elStreamRef.current.getTracks().forEach(t => t.stop()); } catch (e) { /* ignore */ }
        elStreamRef.current = null;
      }
    };
  }, []);

  return { isListening, elapsed, activeLang, queueLength, start, stop, stopHold, stopSpeaking, isSpeaking: isSpeakingRef };
}
