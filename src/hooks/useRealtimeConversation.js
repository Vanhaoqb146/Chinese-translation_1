'use client';
import { useState, useRef, useCallback, useEffect } from 'react';

/**
 * useRealtimeConversation — Multi-provider STT + GPT-5.x + TTS
 *
 * Supports:
 *   - Azure Speech SDK (STT)
 *   - ElevenLabs Scribe v2 (STT via WebSocket)
 *
 * start(inputLang) → STT (continuous)
 * BƯỚC 1: STT → interim/final text + auto language detection
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

// ====== [DEDUP] Phát hiện và loại bỏ đoạn text bị lặp lại liên tiếp ======
// Xử lý trường hợp Azure SDK fire trùng recognized events khi WebSocket reconnect
function removeDuplicateSegments(text) {
  if (!text || text.length < 40) return text;

  // Tách thành các câu theo dấu câu (hỗ trợ cả CJK 。！？)
  const sentences = text.split(/(?<=[.。!！?？])\ */);
  if (sentences.length <= 1) return text;

  const kept = [];
  const seenNorm = [];

  for (const raw of sentences) {
    const s = raw.trim();
    if (!s) continue;
    const norm = s.toLowerCase();

    // Trùng exact → bỏ
    if (seenNorm.includes(norm)) {
      console.warn(`🔄 [TextDedup] Bỏ câu trùng exact: "${s.slice(0, 60)}..."`);
      continue;
    }

    // Trùng gần đúng: câu mới là substring dài (>80%) của một câu đã seen
    let isDup = false;
    for (const prev of seenNorm) {
      if (prev.length > 20 && norm.length > 20) {
        if (prev.includes(norm) && norm.length / prev.length > 0.8) {
          isDup = true;
          break;
        }
        if (norm.includes(prev) && prev.length / norm.length > 0.8) {
          isDup = true;
          break;
        }
      }
    }
    if (isDup) {
      console.warn(`🔄 [TextDedup] Bỏ câu tương tự: "${s.slice(0, 60)}..."`);
      continue;
    }

    seenNorm.push(norm);
    kept.push(s);
  }

  const result = kept.join(' ');
  if (result.length < text.length) {
    console.log(`🔄 [TextDedup] Đã loại bỏ ${text.length - result.length} ký tự trùng lặp`);
  }
  return result;
}

export default function useRealtimeConversation({
  srcLangCode,
  tgtLangCode,
  engine = 'openai',
  silenceMs = 4000,
  autoDetect = false,
  micMode = 'click', // 'click' | 'continuous' | 'hold'
  autoTTS = true,
  provider = 'azure', // 'azure' | 'elevenlabs' | 'web-speech'
  ttsProvider = 'azure', // 'azure' | 'elevenlabs'
  speed = 1.0,        // Tốc độ phát giọng nói
  onInterimText,
  onFinalResult,
  onStatusChange,
  onError,
  getVoiceForLang,
  context = '',
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
  const currentAudioRef = useRef(null);
  const currentAudioUrlRef = useRef(null);

  // ElevenLabs-specific refs
  const elWsRef = useRef(null);       // WebSocket instance
  const elMediaRef = useRef(null);    // MediaRecorder
  const elStreamRef = useRef(null);   // MediaStream (mic)

  // WebSpeech-specific refs
  const webSpeechRecRef = useRef(null);
  const isWebSpeechFinalFiredRef = useRef(false);
  const webSpeechPendingResolveRef = useRef(null);
  const isMicRunningRef = useRef(false);

  const accumulatedTextRef = useRef('');
  const currentInterimRef = useRef('');
  const prevSessionsTextRef = useRef('');
  const silenceTimeoutRef = useRef(null);
  const stoppingRef = useRef(false); // Cờ chặn tin nhắn WebSocket muộn khi bấm dừng
  const lastRecognizedSegmentsRef = useRef([]); // [DEDUP] Lưu các segment đã recognized để phát hiện trùng

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
  const speedRef = useRef(speed);
  const contextRef = useRef(context);

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
  speedRef.current = speed;
  contextRef.current = context;

  // Reuse one HTMLAudioElement to avoid iOS Safari blocking autoplay on new audio elements.
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

      // Khởi tạo SpeechConfig từ Universal v2 endpoint chuyên dụng cho LID
      const endpoint = `wss://${tokenData.region}.stt.speech.microsoft.com/speech/universal/v2`;
      const v2Config = sdk.SpeechConfig.fromEndpoint(new URL(endpoint), "");
      v2Config.authorizationToken = tokenData.token;
      v2Config.setProperty('Speech_SegmentationSilenceTimeoutMs', '2000');
      v2Config.setProperty('SpeechServiceConnection_LanguageIdMode', 'Continuous');

      const autoDetectConfig = sdk.AutoDetectSourceLanguageConfig.fromLanguages(candidates);
      audioConfig = sdk.AudioConfig.fromDefaultMicrophoneInput();
      recognizer = sdk.SpeechRecognizer.FromConfig(v2Config, autoDetectConfig, audioConfig);
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

      // ===== [DEDUP] Phát hiện Azure fire trùng recognized event =====
      const trimmedSeg = transcript.trim();
      const prevSegs = lastRecognizedSegmentsRef.current;

      // Check 1: Trùng EXACT với segment cuối → bỏ qua
      if (prevSegs.length > 0 && prevSegs[prevSegs.length - 1] === trimmedSeg) {
        console.warn(`🔄 [Dedup] Bỏ recognized trùng exact: "${trimmedSeg.slice(0, 60)}..."`);
        resetSilenceTimer();
        return;
      }

      // Check 2: Segment mới đã nằm trọn trong accumulated text → bỏ qua
      if (accumulatedTextRef.current && trimmedSeg.length > 10 &&
          accumulatedTextRef.current.includes(trimmedSeg)) {
        console.warn(`🔄 [Dedup] Bỏ recognized đã có trong accumulated: "${trimmedSeg.slice(0, 60)}..."`);
        resetSilenceTimer();
        return;
      }

      // Check 3: Overlap lớn giữa đuôi accumulated và đầu segment mới (>70%)
      if (accumulatedTextRef.current && trimmedSeg.length > 20) {
        const accLower = accumulatedTextRef.current.toLowerCase();
        const segLower = trimmedSeg.toLowerCase();
        const maxCheck = Math.min(accLower.length, segLower.length);
        let overlapLen = 0;
        for (let len = maxCheck; len >= 10; len--) {
          if (accLower.endsWith(segLower.substring(0, len))) {
            overlapLen = len;
            break;
          }
        }
        if (overlapLen > 0 && overlapLen / segLower.length > 0.7) {
          const newPart = trimmedSeg.substring(overlapLen).trim();
          console.warn(`🔄 [Dedup] Overlap ${Math.round(overlapLen / segLower.length * 100)}% — chỉ giữ phần mới: "${(newPart || '(trống)').slice(0, 50)}"`);
          if (newPart) {
            accumulatedTextRef.current += ' ' + newPart;
          }
          prevSegs.push(trimmedSeg);
          if (prevSegs.length > 10) prevSegs.shift();
          currentInterimRef.current = '';
          if (onInterimTextRef.current) onInterimTextRef.current(accumulatedTextRef.current);
          resetSilenceTimer();
          return;
        }
      }

      // Segment hợp lệ — ghi nhận và append bình thường
      prevSegs.push(trimmedSeg);
      if (prevSegs.length > 10) prevSegs.shift();

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

  // ====== Setup ElevenLabs Scribe v2 STT (WebSocket) ======
  const setupElevenLabsSTT = useCallback(async (inputLang) => {
    // Cleanup any previous ElevenLabs resources
    if (elWsRef.current) {
      try { elWsRef.current.close(); } catch (e) { /* ignore */ }
      elWsRef.current = null;
    }
    if (elMediaRef.current) {
      try { elMediaRef.current.stop(); } catch (e) { /* ignore */ }
      elMediaRef.current = null;
    }
    if (elStreamRef.current) {
      try { elStreamRef.current.getTracks().forEach(t => t.stop()); } catch (e) { /* ignore */ }
      elStreamRef.current = null;
    }

    // Get token from our backend
    const tokenRes = await fetch('/api/elevenlabs');
    const tokenData = await tokenRes.json();
    if (!tokenData.token) throw new Error('No ElevenLabs token');

    console.log(`\u{1F511} [ElevenLabs STT] Token received`);

    // Language code mapping
    const langMap = { zh: 'zh', vi: 'vi', en: 'en', ja: 'ja', ko: 'ko' };
    const elLang = langMap[inputLang] || inputLang;

    // Get mic permission BEFORE opening WebSocket
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: { sampleRate: { ideal: 16000 }, channelCount: 1, echoCancellation: true, noiseSuppression: true }
    });
    elStreamRef.current = stream;

    // Open WebSocket — ElevenLabs single-use token authentication via query parameter "token"
    const wsUrl = `wss://api.elevenlabs.io/v1/speech-to-text/realtime?model_id=scribe_v2_realtime&language_code=${encodeURIComponent(elLang)}&audio_format=pcm_16000&commit_strategy=vad&token=${encodeURIComponent(tokenData.token)}`;
    const ws = new WebSocket(wsUrl);
    elWsRef.current = ws;

    ws.onopen = () => {
      console.log('\u{1F7E2} [ElevenLabs STT] WebSocket connected & authenticated');

      // Start microphone streaming
      try {

        // Use AudioContext to downsample to 16kHz PCM
        const audioContext = new AudioContext({ sampleRate: 16000 });
        const source = audioContext.createMediaStreamSource(stream);
        const processor = audioContext.createScriptProcessor(4096, 1, 1);

        source.connect(processor);
        processor.connect(audioContext.destination);

        processor.onaudioprocess = (e) => {
          if (!elWsRef.current || elWsRef.current.readyState !== WebSocket.OPEN) return;
          if (isSpeakingRef.current) return;

          const pcmData = e.inputBuffer.getChannelData(0);
          // Convert Float32 to Int16
          const int16 = new Int16Array(pcmData.length);
          for (let i = 0; i < pcmData.length; i++) {
            int16[i] = Math.max(-32768, Math.min(32767, Math.floor(pcmData[i] * 32768)));
          }

          // Send as base64 — chunked to avoid call stack overflow
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
          } catch (sendErr) {
            // WebSocket might have closed
          }
        };

        // Store processor ref for cleanup
        elMediaRef.current = { processor, source, audioContext };

        if (onStatusChangeRef.current) onStatusChangeRef.current('listening');
        console.log('\u{1F3A4} [ElevenLabs STT] Microphone streaming...');
      } catch (micErr) {
        console.error('\u274C [ElevenLabs STT] Mic error:', micErr);
        if (onErrorRef.current) onErrorRef.current('Mic: ' + micErr.message);
      }
    };

    ws.onmessage = (event) => {
      if (isSpeakingRef.current) return;
      if (stoppingRef.current) return; // Bỏ qua tin nhắn đến sau khi user bấm dừng
      try {
        const data = JSON.parse(event.data);
        const messageType = data.message_type || data.type;
        console.log('\u{1F4E9} [EL WS]', messageType, JSON.stringify(data).slice(0, 200));

        if (messageType === 'partial_transcript') {
          const transcript = data.text || '';
          if (!transcript) return;

          console.log(`\u{1F4DD} [EL] interim: "${transcript}"`);
          currentInterimRef.current = transcript;
          const display = accumulatedTextRef.current + (accumulatedTextRef.current ? ' ' : '') + transcript;
          if (onInterimTextRef.current) onInterimTextRef.current(display);
          resetSilenceTimer();
          return;
        }

        // Ignore timestamps echo event to avoid duplicate append.
        if (messageType === 'committed_transcript_with_timestamps') return;

        if (messageType === 'committed_transcript') {
          const transcript = data.text || '';
          if (!transcript) return;

          console.log(`\u{1F4DD} [EL] FINAL: "${transcript}"`);
          accumulatedTextRef.current += (accumulatedTextRef.current ? ' ' : '') + transcript;
          currentInterimRef.current = '';
          if (onInterimTextRef.current) onInterimTextRef.current(accumulatedTextRef.current);
          resetSilenceTimer();
          return;
        }

        if (messageType && (data.error || messageType === 'error' || messageType.endsWith('error'))) {
          const errMsg = data.error || data.message || 'Unknown ElevenLabs STT error';
          console.error(`\u274C [ElevenLabs STT] ${messageType}: ${errMsg}`);
          if (onErrorRef.current) onErrorRef.current(`ElevenLabs STT: ${errMsg}`);
        }
      } catch (e) {
        console.warn('\u26A0\uFE0F [ElevenLabs STT] Parse error:', e);
      }
    };

    ws.onerror = (err) => {
      console.error('\u274C [ElevenLabs STT] WebSocket error:', err);
      if (onErrorRef.current) onErrorRef.current('ElevenLabs STT WebSocket error');
    };

    ws.onclose = (e) => {
      console.log(`\u{1F534} [ElevenLabs STT] WebSocket closed: code=${e.code}, reason="${e.reason}"`);
    };

    return ws;
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
  }, []);

  // ====== Silence Timer ======
  const resetSilenceTimer = useCallback(() => {
    clearTimeout(silenceTimeoutRef.current);
    if (isSpeakingRef.current) return;
    // Hold mode: không dùng silence timer — chỉ dịch khi user thả tay
    if (micModeRef.current === 'hold') return;

    const timeout = silenceMsRef.current || 4000;
    silenceTimeoutRef.current = setTimeout(() => {
      console.log(`⏰ [Silence] ${timeout / 1000}s timer fired!`);
      triggerTranslation();
    }, timeout);
  }, []);

  // ====== PIPELINE: Dịch + TTS (dùng chung cho silence timer & manual stop) ======
  const triggerTranslation = useCallback(async () => {
    let text = accumulatedTextRef.current.trim();
    const interim = currentInterimRef.current.trim();
    if (interim) {
      text = text ? text + ' ' + interim : interim;
    }
    if (!text) return;

    // [DEDUP] Loại bỏ các câu bị lặp trong accumulated text trước khi dịch
    text = removeDuplicateSegments(text);

    // Lọc bỏ từ ừm, à, ờ dư thừa ở cuối hoặc đứng độc lập do tiếng thở/nhiễu
    text = text.replace(/(?<=^|\s|[.,!?])(ừm|ờ|à|ơi|ơ)(?=\s|[.,!?]|$)/gi, '');
    text = text.replace(/\b(uh|um|er|erm)\b/gi, '');
    text = text.replace(/\s+/g, ' ').trim();
    if (!text) return;

    // [FIX] Lọc nhiễu — Azure STT hay bắt được 'phẩy', 'chấm' khi mic ngắt vội
    const noiseWords = ['phẩy.', 'chấm.', 'phẩy', 'chấm', 'hỏi.', 'hỏi', 'comma', 'period', 'dot',
      'the first', 'the', 'first', 'thank you', 'thanks', 'bye', 'okay', 'ok',
      'yes', 'no', 'hello', 'hi', 'hey', 'so', 'and', 'but', 'or',
      'one', 'two', 'three', 'i', 'you', 'it', 'a', 'is', 'this', 'that',
      'right', 'well', 'just', 'like', 'good', 'not', 'what', 'do', 'can',
      'please', 'sorry', 'see', 'go', 'get', 'let', 'here', 'there',
      'my', 'your', 'we', 'they', 'he', 'she', 'me', 'us', 'them',
    ];
    const cleanLower = text.replace(/[.,!?;:]+$/g, '').trim().toLowerCase();

    // [FIX] Bộ lọc nhiễu ngôn ngữ: nếu đang nói tiếng Trung/Việt/Nhật/Hàn
    // mà text chỉ toàn chữ Latin ngắn (≤4 từ) → chắc chắn là nhiễu micro
    const isPureEnglish = /^[a-zA-Z0-9\s.,!?'"\-:;()]+$/.test(text.trim());
    const wordCount = text.trim().split(/\s+/).length;
    const wasNotSpeakingEnglish = inputLangRef.current !== 'en';
    if (isPureEnglish && wordCount <= 4 && wasNotSpeakingEnglish) {
      console.log(`🚫 [Noise] English noise while speaking ${inputLangRef.current}: "${text}"`);
      accumulatedTextRef.current = '';
      currentInterimRef.current = '';
      if (onInterimTextRef.current) onInterimTextRef.current('');
      if (micModeRef.current === 'hold') {
        wantListeningRef.current = false;
        clearInterval(elapsedTimerRef.current);
        setIsListening(false);
        setActiveLang(null);
        if (onStatusChangeRef.current) onStatusChangeRef.current('idle');
      }
      return;
    }

    if (noiseWords.includes(cleanLower) || /^[.,!?;:\s]+$/.test(text)) {
      console.log(`🚫 [Noise] Bỏ qua text nhiễu: "${text}"`);
      accumulatedTextRef.current = '';
      currentInterimRef.current = '';
      if (onInterimTextRef.current) onInterimTextRef.current('');
      if (micModeRef.current === 'hold') {
        wantListeningRef.current = false;
        clearInterval(elapsedTimerRef.current);
        setIsListening(false);
        setActiveLang(null);
        if (onStatusChangeRef.current) onStatusChangeRef.current('idle');
      }
      return;
    }

    // [FIX] Xác định ngôn ngữ từ NỘI DUNG text — đáng tin hơn Azure auto-detect
    if (autoDetectRef.current) {
      const textLang = detectLangFromText(text, srcLangCodeRef.current, tgtLangCodeRef.current);
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

    // Đóng recognizer/WebSocket cũ hoàn toàn
    if (providerRef.current === 'web-speech') {
      if (webSpeechRecRef.current) {
        try {
          webSpeechRecRef.current.onstart = null;
          webSpeechRecRef.current.onresult = null;
          webSpeechRecRef.current.onerror = null;
          webSpeechRecRef.current.onend = null;
          webSpeechRecRef.current.abort();
        } catch (e) { /* ignore */ }
        webSpeechRecRef.current = null;
        isMicRunningRef.current = false;
      }
    } else if (providerRef.current === 'elevenlabs') {
      // Cleanup ElevenLabs
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
      // Cleanup Azure
      if (recognizerRef.current) {
        try {
          await recognizerRef.current.stopContinuousRecognitionAsync();
          recognizerRef.current.close();
          console.log('\u{1F507} [Mic] Đã đóng recognizer cũ');
        } catch (e) { console.warn('\u26A0\uFE0F [Stop recognizer]', e); }
        recognizerRef.current = null;
      }
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
          context: contextRef.current || '',
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

      // ====== TTS (chỉ phát nếu autoTTS bật) ======
      if (autoTTSRef.current) {
        const voiceId = getVoiceForLangRef.current ? getVoiceForLangRef.current(toLang) : null;

        // Kiểm tra mute: nếu voiceId === '__MUTED__' → bỏ qua TTS cho ngôn ngữ này
        if (voiceId === '__MUTED__') {
          console.log(`🔇 [TTS] Bỏ qua — ngôn ngữ ${toLang} đang bị tắt loa`);
        } else {
          if (onStatusChangeRef.current) onStatusChangeRef.current('speaking');

          const ttsRes = await fetch('/api/tts', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ text: translatedText, lang: toLang, voice: voiceId, provider: ttsProviderRef.current }),
            signal: AbortSignal.timeout(30000),
          });

          if (ttsRes.ok) {
            const blob = await ttsRes.blob();
            console.log(`🔊 [TTS] ${blob.size} bytes`);

            if (blob.size > 0) {
              const url = URL.createObjectURL(blob);
              const audio = getOrCreateTtsAudio();
              if (!audio) {
                URL.revokeObjectURL(url);
              } else {
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
                  // Khởi tạo thời gian chờ an toàn tĩnh cực dài (5 phút) và không ngắt âm thanh khi kích hoạt
                  const safetyTimeout = setTimeout(() => {
                    console.warn('⚠️ [TTS] Timeout — force resolve (5 phút)');
                    done(); // Giải phóng trạng thái giao diện nhưng không gọi audio.pause() để cho phép âm thanh tiếp tục phát đến hết
                  }, 300000);

                  audio.onloadedmetadata = () => {
                    if (!resolved && audio.duration && isFinite(audio.duration)) {
                      clearTimeout(safetyTimeout);
                      durationTimeout = setTimeout(() => {
                        if (!resolved) {
                          console.warn(`⚠️ [TTS] Duration timeout (${audio.duration.toFixed(1)}s + 3s)`);
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

                  audio.play().catch((err) => {
                    console.warn('⚠️ [TTS] audio.play() blocked:', err);
                    done();
                  });
                });
              }
            }
          }
        } // end mute else
      } else {
        console.log('🔇 [TTS] Bỏ qua — autoTTS tắt');
      }
    } catch (err) {
      console.error('❌ [Pipeline]', err);
      if (onErrorRef.current) onErrorRef.current(err.message);
    }

    // Dọn dẹp + tạo recognizer MỚI để resume
    accumulatedTextRef.current = '';
    currentInterimRef.current = '';
    lastRecognizedSegmentsRef.current = []; // [DEDUP] Reset dedup state
    isSpeakingRef.current = false;
    if (onInterimTextRef.current) onInterimTextRef.current('');

    // === QUYẾT ĐỊNH SAU TTS: mở mic lại hay dừng ===
    const shouldResume =
      wantListeningRef.current && (
        autoDetectRef.current || // 1-mic tự nhận dạng → luôn resume
        micModeRef.current === 'continuous' // 2-mic liên tục → resume
      );

    if (micModeRef.current === 'hold') {
      // Hold mode: luôn tắt mic sau TTS — user phải nhấn giữ lại
      console.log('🛑 [Hold mode] TTS xong → tắt mic, chờ user nhấn giữ lần nữa');
      wantListeningRef.current = false;
      clearInterval(elapsedTimerRef.current);
      setIsListening(false);
      setActiveLang(null);
      if (onStatusChangeRef.current) onStatusChangeRef.current('idle');
    } else if (shouldResume) {
      try {
        console.log('\u{1F504} [Resume] Tạo STT mới...');
        if (providerRef.current === 'web-speech') {
          if (!isMicRunningRef.current) {
            await setupWebSpeechRecognizer(inputLangRef.current);
          }
        } else if (providerRef.current === 'elevenlabs') {
          await setupElevenLabsSTT(inputLangRef.current);
        } else {
          await setupRecognizer(inputLangRef.current);
        }
        console.log('\u2705 [Resume] STT mới đã sẵn sàng!');
      } catch (err) {
        console.error('❌ [Resume] Không thể tạo recognizer mới:', err);
        if (onErrorRef.current) onErrorRef.current('Không thể bật lại mic: ' + err.message);
        if (onStatusChangeRef.current) onStatusChangeRef.current('idle');
      }
    } else {
      // Click mode (2 mic): dừng hẳn sau mỗi câu
      console.log('🛑 [Click] TTS xong → tắt mic');
      wantListeningRef.current = false;
      clearInterval(elapsedTimerRef.current);
      setIsListening(false);
      setActiveLang(null);
      if (onStatusChangeRef.current) onStatusChangeRef.current('idle');
    }
  }, [setupRecognizer, setupElevenLabsSTT, setupWebSpeechRecognizer, getOrCreateTtsAudio, releaseCurrentAudioUrl]);

  // ====== Start(inputLang) — entry point ======
  const start = useCallback(async (inputLang) => {
    try {
      accumulatedTextRef.current = '';
      currentInterimRef.current = '';
      prevSessionsTextRef.current = '';
      lastRecognizedSegmentsRef.current = []; // [DEDUP] Reset dedup state
      isSpeakingRef.current = false;
      stoppingRef.current = false; // Reset cờ dừng khi bắt đầu phiên mới
      inputLangRef.current = inputLang;
      conversationHistoryRef.current = [];
      msgIdRef.current = Date.now();

      console.log(`🔑 [Start] inputLang=${inputLang}`);

      // Initialize and reuse one audio element for the whole session (iOS Safari autoplay stability).
      getOrCreateTtsAudio();

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

      // Tạo STT (dùng hàm tương ứng với provider)
      if (providerRef.current === 'web-speech') {
        await setupWebSpeechRecognizer(inputLang);
      } else if (providerRef.current === 'elevenlabs') {
        await setupElevenLabsSTT(inputLang);
      } else {
        await setupRecognizer(inputLang);
      }
      console.log('\u23F3 [STT] Started, waiting for session...');

    } catch (err) {
      console.error('❌ [Start]', err);
      if (onErrorRef.current) onErrorRef.current(err.message);
      wantListeningRef.current = false;
      setIsListening(false);
    }
  }, [setupRecognizer, setupElevenLabsSTT, setupWebSpeechRecognizer, getOrCreateTtsAudio]);

  // ====== Stop ======
  const stop = useCallback(async () => {
    console.log('🛑 Stop');
    stoppingRef.current = true; // Đánh dấu đang dừng → chặn tin nhắn WebSocket muộn
    wantListeningRef.current = false;
    clearTimeout(silenceTimeoutRef.current);
    clearInterval(elapsedTimerRef.current);

    // Stop + close STT
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
        } catch (e) { console.warn('\u26A0\uFE0F [Stop close]', e); }
        recognizerRef.current = null;
      }
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

    // Đặt trạng thái nghe là false ngay lập tức để UI phản hồi nhạy bén
    setIsListening(false);

    // Trì hoãn đóng mic 600ms để thu trọn vẹn từ cuối cùng của mọi STT engine
    await new Promise(resolve => setTimeout(resolve, 600));

    // Đóng STT ngay
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
        } catch (e) { console.warn('\u26A0\uFE0F [StopHold close]', e); }
        recognizerRef.current = null;
      }
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

  // ====== StopSpeaking — dừng TTS ngay → pipeline cleanup tự xử lý resume/idle ======
  const stopSpeaking = useCallback(async () => {
    console.log('🔇 [StopSpeaking] User tắt loa');
    if (currentAudioRef.current) {
      const audio = currentAudioRef.current;
      try { audio.pause(); audio.currentTime = 0; } catch (e) { /* ignore */ }
      // [KEY] Dispatch 'ended' event → triggerTranslation promise resolves
      // → cleanup code chạy bình thường (resume mic hoặc idle tùy mode)
      try { audio.dispatchEvent(new Event('ended')); } catch (e) { /* ignore */ }
    }
    // Không cần set state ở đây — triggerTranslation cleanup sẽ xử lý tất cả
  }, []);

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
        try { recognizerRef.current.close(); } catch (e) { console.warn('\u26A0\uFE0F [Cleanup]', e); }
        recognizerRef.current = null;
      }
      // Cleanup ElevenLabs
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

  return { isListening, elapsed, activeLang, start, stop, stopHold, stopSpeaking, isSpeaking: isSpeakingRef };
}
