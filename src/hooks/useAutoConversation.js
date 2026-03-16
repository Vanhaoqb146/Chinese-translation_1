'use client';
import { useState, useRef, useCallback, useEffect } from 'react';

const SILENCE_THRESHOLD = 0.01; // Hạ xuống 0.01 dư sức bắt trọn vẹn phụ âm mềm của Tiếng Việt
const SILENCE_DURATION = 1100; // [BALANCED] 1100ms — cân bằng giữa tốc độ và độ ổn định
const MIN_RECORD_DURATION = 600; // Hạ xuống 0.6s để bắt được các câu ngắn hơn
const MAX_RECORD_DURATION = 10000;
const PRE_ROLL_MS = 800; // [FIX] Tăng bộ đệm lên 0.8s để không bị mất đầu câu

const WHISPER_LANG_MAP = { chinese: 'zh', mandarin: 'zh', vietnamese: 'vi', english: 'en', japanese: 'ja', korean: 'ko' };

// Nhà máy đóng gói sóng âm PCM thành file WAV chuẩn xác 100%
const exportWAV = (preRollBuffers, recordingBuffers, sampleRate) => {
  const totalLen = preRollBuffers.reduce((acc, b) => acc + b.length, 0) + recordingBuffers.reduce((acc, b) => acc + b.length, 0);
  const samples = new Float32Array(totalLen);
  let offset = 0;
  for (let b of preRollBuffers) { samples.set(b, offset); offset += b.length; }
  for (let b of recordingBuffers) { samples.set(b, offset); offset += b.length; }

  const buffer = new ArrayBuffer(44 + samples.length * 2);
  const view = new DataView(buffer);
  const writeString = (view, offset, string) => { for (let i = 0; i < string.length; i++) view.setUint8(offset + i, string.charCodeAt(i)); };

  writeString(view, 0, 'RIFF'); view.setUint32(4, 36 + samples.length * 2, true);
  writeString(view, 8, 'WAVE'); writeString(view, 12, 'fmt ');
  view.setUint32(16, 16, true); view.setUint16(20, 1, true); view.setUint16(22, 1, true);
  view.setUint32(24, sampleRate, true); view.setUint32(28, sampleRate * 2, true);
  view.setUint16(32, 2, true); view.setUint16(34, 16, true);
  writeString(view, 36, 'data'); view.setUint32(40, samples.length * 2, true);

  let p = 44;
  for (let i = 0; i < samples.length; i++) {
    let s = Math.max(-1, Math.min(1, samples[i]));
    view.setInt16(p, s < 0 ? s * 0x8000 : s * 0x7FFF, true);
    p += 2;
  }
  return new Blob([view], { type: 'audio/wav' });
};

export default function useAutoConversation({ apiKey, engine, srcLangCode, tgtLangCode, onTranscribed, onResult, onTranslating, onError, onLangDetected }) {
  const [isListening, setIsListening] = useState(false);
  const [elapsed, setElapsed] = useState(0);

  const streamRef = useRef(null);
  const audioContextRef = useRef(null);
  const processorRef = useRef(null);

  const silenceTimerRef = useRef(null);
  const maxTimerRef = useRef(null);
  const elapsedTimerRef = useRef(null);
  const startTimeRef = useRef(0);

  const isRecordingChunkRef = useRef(false);
  const recordStartTimeRef = useRef(0);
  const wantListeningRef = useRef(false);
  const isPausedRef = useRef(false);
  const isProcessingRef = useRef(false);

  // Kho chứa sóng âm thô
  const preRollBufferRef = useRef([]);
  const recordingBufferRef = useRef([]);
  const sampleRateRef = useRef(44100);
  const conversationHistoryRef = useRef([]);

  const processAudioChunk = useCallback(async (audioBlob) => {
    isProcessingRef.current = true;
    if (onTranslating) onTranslating(true);
    console.log('⏳ Gửi file WAV Studio (đã ghép 0.5s) lên Whisper...');

    try {
      const formData = new FormData();
      formData.append('audio', audioBlob, 'audio.wav');
      formData.append('apiKey', apiKey);
      // [FIX] Conversation mode: KHÔNG ép ngôn ngữ — để Whisper tự phát hiện
      // vì trong hội thoại cả 2 bên đều có thể nói ngôn ngữ khác nhau
      formData.append('mode', 'conversation');
      formData.append('srcLang', srcLangCode);
      formData.append('tgtLang', tgtLangCode);

      const whisperRes = await fetch('/api/whisper', { method: 'POST', body: formData });
      const whisperData = await whisperRes.json();
      console.log("✅ Whisper trả về:", whisperData);

      if (!whisperRes.ok) throw new Error(whisperData.error || whisperData.detail || 'Whisper API failed');
      if (!whisperData.text || whisperData.text.trim().length === 0) return;

      const text = whisperData.text.trim();
      const detectedLang = whisperData.language ? whisperData.language.toLowerCase() : null;
      const langCode = detectedLang ? (WHISPER_LANG_MAP[detectedLang] || detectedLang) : null;

      if (onLangDetected) onLangDetected(langCode);

      // [FIX] Generic language routing — không hardcode Vietnamese
      // Nếu Whisper phát hiện đúng ngôn ngữ nguồn → dịch sang đích, và ngược lại
      let fromLang, toLang;
      if (langCode === srcLangCode) {
        fromLang = srcLangCode;
        toLang = tgtLangCode;
      } else if (langCode === tgtLangCode) {
        fromLang = tgtLangCode;
        toLang = srcLangCode;
      } else {
        // Whisper trả về ngôn ngữ không khớp → fallback: dùng srcLang
        fromLang = srcLangCode;
        toLang = tgtLangCode;
      }

      const recordId = Date.now();
      if (onTranscribed) onTranscribed({ originalText: text, detectedLang: langCode, fromLang, toLang, id: recordId });

      const translateRes = await fetch('/api/translate', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text, sourceLang: fromLang, targetLang: toLang, apiKey, engine: engine || 'openai', history: conversationHistoryRef.current }),
      });

      const translateData = await translateRes.json();
      const translated = translateData.translation || text;

      conversationHistoryRef.current.push({ role: 'user', content: text });
      conversationHistoryRef.current.push({ role: 'assistant', content: translated });
      if (conversationHistoryRef.current.length > 6) conversationHistoryRef.current = conversationHistoryRef.current.slice(-6);

      if (onResult) await onResult({ originalText: text, translatedText: translated, detectedLang: langCode, fromLang, toLang, id: recordId });
    } catch (err) {
      if (onError) onError('Lỗi: ' + err.message);
    } finally {
      isProcessingRef.current = false;
      if (onTranslating) onTranslating(false);
    }
  }, [apiKey, engine, srcLangCode, tgtLangCode, onTranscribed, onResult, onTranslating, onError, onLangDetected]);

  const stopRecordingChunk = useCallback(() => {
    clearTimeout(maxTimerRef.current);
    if (!isRecordingChunkRef.current) return;

    isRecordingChunkRef.current = false;
    console.log('🛑 Cắt câu nói!');

    const duration = Date.now() - recordStartTimeRef.current;
    if (duration >= MIN_RECORD_DURATION && recordingBufferRef.current.length > 0) {
      // Đóng gói mẻ sóng âm thành file WAV
      const blob = exportWAV(preRollBufferRef.current, recordingBufferRef.current, sampleRateRef.current);
      processAudioChunk(blob);
    }

    // Dọn dẹp kho
    recordingBufferRef.current = [];
    preRollBufferRef.current = [];
  }, [processAudioChunk]);

  const startRecordingChunk = useCallback(() => {
    isRecordingChunkRef.current = true;
    recordStartTimeRef.current = Date.now();
    recordingBufferRef.current = [];
    console.log('🎙️ Bắt đầu ghi âm (Đã ôm trọn 0.5s quá khứ)!');

    maxTimerRef.current = setTimeout(() => {
      if (isRecordingChunkRef.current) stopRecordingChunk();
    }, MAX_RECORD_DURATION);
  }, [stopRecordingChunk]);

  const start = useCallback(async () => {
    try {
      conversationHistoryRef.current = [];
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: { 
          echoCancellation: true, 
          noiseSuppression: false, // [TẮT] Chống ồn mặc định của Chrome làm nghẹt/mất phụ âm Tiếng Việt
          autoGainControl: false   // [TẮT] Tự động tăng giảm âm lượng gây biến dạng sóng âm PCM
        }
      });
      streamRef.current = stream;

      const audioCtx = new (window.AudioContext || window.webkitAudioContext)();
      audioContextRef.current = audioCtx;
      sampleRateRef.current = audioCtx.sampleRate;

      const source = audioCtx.createMediaStreamSource(stream);

      // Khởi tạo bộ thu sóng âm nguyên bản (4096 samples/khung hình)
      const processor = audioCtx.createScriptProcessor(4096, 1, 1);
      processorRef.current = processor;

      // Chống nhiễu (Workaround cho Chrome)
      const dummyGain = audioCtx.createGain();
      dummyGain.gain.value = 0;
      processor.connect(dummyGain);
      dummyGain.connect(audioCtx.destination);
      source.connect(processor);

      const PRE_ROLL_SAMPLES = Math.floor(sampleRateRef.current * (PRE_ROLL_MS / 1000));

      processor.onaudioprocess = (e) => {
        if (!wantListeningRef.current || isPausedRef.current) return;

        const inputData = e.inputBuffer.getChannelData(0);
        const pcm = new Float32Array(inputData);

        // 1. Máy quét cường độ âm thanh (VAD) tích hợp siêu tốc
        let sum = 0;
        for (let i = 0; i < pcm.length; i++) sum += pcm[i] * pcm[i];
        const rms = Math.sqrt(sum / pcm.length);

        // [FIX] Khi đang xử lý API → vẫn thu pre-roll, chỉ không bắt đầu recording mới
        // Trước đây isProcessingRef chặn TOÀN BỘ audio → mất trọn câu tiếp theo
        if (rms > SILENCE_THRESHOLD && !isProcessingRef.current) {
          clearTimeout(silenceTimerRef.current);
          if (!isRecordingChunkRef.current) startRecordingChunk();

          silenceTimerRef.current = setTimeout(() => {
            if (isRecordingChunkRef.current) stopRecordingChunk();
          }, SILENCE_DURATION);
        }

        // 2. Chuyển hàng vào kho đệm hoặc kho chính
        if (isRecordingChunkRef.current && !isProcessingRef.current) {
          recordingBufferRef.current.push(pcm);
        } else {
          // [FIX] Tiếp tục thu pre-roll ngay cả khi đang xử lý API
          // → Khi API xong, câu tiếp theo đã có sẵn 800ms đệm đầu
          preRollBufferRef.current.push(pcm);
          let totalSamples = preRollBufferRef.current.reduce((acc, val) => acc + val.length, 0);
          while (totalSamples > PRE_ROLL_SAMPLES && preRollBufferRef.current.length > 1) {
            totalSamples -= preRollBufferRef.current[0].length;
            preRollBufferRef.current.shift();
          }
        }
      };

      wantListeningRef.current = true;
      isPausedRef.current = false;
      isProcessingRef.current = false;
      setIsListening(true);
      setElapsed(0);
      startTimeRef.current = Date.now();

      elapsedTimerRef.current = setInterval(() => setElapsed(Math.floor((Date.now() - startTimeRef.current) / 1000)), 1000);
    } catch (err) {
      if (onError) onError('Không thể truy cập microphone');
    }
  }, [onError, startRecordingChunk, stopRecordingChunk]);

  const stop = useCallback(() => {
    wantListeningRef.current = false;
    setIsListening(false);
    clearInterval(elapsedTimerRef.current);
    clearTimeout(silenceTimerRef.current);
    clearTimeout(maxTimerRef.current);
    if (processorRef.current) processorRef.current.disconnect();
    if (streamRef.current) streamRef.current.getTracks().forEach(t => t.stop());
    if (audioContextRef.current && audioContextRef.current.state !== 'closed') audioContextRef.current.close();
  }, []);

  const pause = useCallback(() => {
    isPausedRef.current = true;
    clearTimeout(silenceTimerRef.current);
    clearTimeout(maxTimerRef.current);
    if (isRecordingChunkRef.current) stopRecordingChunk();
  }, [stopRecordingChunk]);

  const resume = useCallback(() => {
    isPausedRef.current = false;
    isRecordingChunkRef.current = false;
    recordingBufferRef.current = [];
    preRollBufferRef.current = [];
  }, []);

  useEffect(() => { return () => { stop(); }; }, [stop]);

  return { isListening, elapsed, start, stop, pause, resume };
}