'use client';
import { useState, useRef, useCallback, useEffect } from 'react';

const SILENCE_THRESHOLD = 0.003; // [TUNED] Ngưỡng cho EMA-smoothed RMS (không phải raw)
const SILENCE_DURATION = 4500; // 5s — tự động dịch sau 5s ngừng nói
const MIN_RECORD_DURATION = 600; // Chunk quá ngắn → bỏ qua (không gửi API)
const MIN_CHUNK_MS = 5000; // Chunk phải ghi >= 5s trước khi cho phép cắt
const MAX_RECORD_DURATION = 100000; // 1p40s — giới hạn an toàn cho Whisper
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
  const processingCountRef = useRef(0); // [REFACTOR] Counter thay cho boolean — cho phép xử lý song song

  // Kho chứa sóng âm thô
  const preRollBufferRef = useRef([]);
  const recordingBufferRef = useRef([]);
  const sampleRateRef = useRef(44100);
  const conversationHistoryRef = useRef([]);
  const smoothedRmsRef = useRef(0); // [EMA] San mượt tín hiệu tránh nhiễu frame-by-frame
  const processAudioChunkRef = useRef(null); // [REF] Giữ reference ổn định cho stop()

  const processAudioChunk = useCallback(async (audioBlob) => {
    processingCountRef.current += 1;
    if (onTranslating) onTranslating(true);
    console.log(`⏳ Gửi file WAV lên Whisper... (queue: ${processingCountRef.current})`);

    try {
      const formData = new FormData();
      formData.append('audio', audioBlob, 'audio.wav');
      formData.append('apiKey', apiKey);
      formData.append('mode', 'conversation');
      formData.append('srcLang', srcLangCode);
      formData.append('tgtLang', tgtLangCode);

      const whisperRes = await fetch('/api/whisper', {
        method: 'POST',
        body: formData,
        signal: AbortSignal.timeout(90000), // 90s timeout — file lớn cần thời gian upload + xử lý
      });
      const whisperData = await whisperRes.json();
      console.log("✅ Whisper trả về:", whisperData);

      if (!whisperRes.ok) throw new Error(whisperData.error || whisperData.detail || 'Whisper API failed');
      if (!whisperData.text || whisperData.text.trim().length === 0) return;

      const text = whisperData.text.trim();
      const detectedLang = whisperData.language ? whisperData.language.toLowerCase() : null;
      const langCode = detectedLang ? (WHISPER_LANG_MAP[detectedLang] || detectedLang) : null;

      if (onLangDetected) onLangDetected(langCode);

      let fromLang, toLang;
      if (langCode === srcLangCode) {
        fromLang = srcLangCode;
        toLang = tgtLangCode;
      } else if (langCode === tgtLangCode) {
        fromLang = tgtLangCode;
        toLang = srcLangCode;
      } else {
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
      processingCountRef.current = Math.max(0, processingCountRef.current - 1);
      if (processingCountRef.current === 0 && onTranslating) onTranslating(false);
    }
  }, [apiKey, engine, srcLangCode, tgtLangCode, onTranscribed, onResult, onTranslating, onError, onLangDetected]);

  // Cập nhật ref mỗi khi processAudioChunk thay đổi
  processAudioChunkRef.current = processAudioChunk;

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

        // 1. Máy quét cường độ âm thanh (VAD) với EMA smoothing
        let sum = 0;
        for (let i = 0; i < pcm.length; i++) sum += pcm[i] * pcm[i];
        const rawRms = Math.sqrt(sum / pcm.length);

        // [EMA] Asymmetric Attack/Release — kỹ thuật audio chuẩn (compressor/gate)
        // Attack  α=0.4: raw=0.004 → smooth tăng 0.001→0.002→0.003 trong 2-3 frame
        // Release α=0.05: smooth giảm rất chậm → giữ qua quãng nghỉ thở
        const alpha = rawRms > smoothedRmsRef.current ? 0.4 : 0.05;
        smoothedRmsRef.current = alpha * rawRms + (1 - alpha) * smoothedRmsRef.current;
        const rms = smoothedRmsRef.current;

        // [DEBUG] Log mỗi 2 giây
        if (!window._lastRmsLog || Date.now() - window._lastRmsLog > 2000) {
          console.log(`🎤 raw=${rawRms.toFixed(4)} smooth=${rms.toFixed(4)} | threshold=${SILENCE_THRESHOLD} | recording=${isRecordingChunkRef.current} | queue=${processingCountRef.current}`);
          window._lastRmsLog = Date.now();
        }

        // [REFACTOR] VAD chạy ĐỘC LẬP — dùng smoothed RMS
        if (rms > SILENCE_THRESHOLD) {
          clearTimeout(silenceTimerRef.current);
          if (!isRecordingChunkRef.current) startRecordingChunk();

          silenceTimerRef.current = setTimeout(() => {
            if (!isRecordingChunkRef.current) return;

            // [GUARD] Bảo vệ thời gian tối thiểu — không cắt fragment quá ngắn
            const elapsed = Date.now() - recordStartTimeRef.current;
            if (elapsed < MIN_CHUNK_MS) {
              console.log(`⏳ Chunk mới ${elapsed}ms < ${MIN_CHUNK_MS}ms — chờ thêm...`);
              // Đặt lại timer cho thời gian còn thiếu
              silenceTimerRef.current = setTimeout(() => {
                console.log(`⏱️ Min-chunk guard timer fired — stopping recording chunk`);
                if (isRecordingChunkRef.current) stopRecordingChunk();
              }, MIN_CHUNK_MS - elapsed);
              return;
            }

            console.log(`⏱️ Silence timer fired after ${SILENCE_DURATION}ms (chunk ${elapsed}ms) — stopping`);
            stopRecordingChunk();
          }, SILENCE_DURATION);
        }

        // 2. Chuyển hàng vào kho đệm hoặc kho chính
        if (isRecordingChunkRef.current) {
          recordingBufferRef.current.push(pcm);
        } else {
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
      processingCountRef.current = 0;
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
    clearInterval(elapsedTimerRef.current);
    clearTimeout(silenceTimerRef.current);
    clearTimeout(maxTimerRef.current);

    // [FIX] Xử lý chunk đang ghi trước khi dọn dẹp — dùng ref thay vì dependency
    if (isRecordingChunkRef.current) {
      isRecordingChunkRef.current = false;
      console.log('🛑 Cắt câu nói! (stop)');
      const duration = Date.now() - recordStartTimeRef.current;
      if (duration >= MIN_RECORD_DURATION && recordingBufferRef.current.length > 0) {
        const blob = exportWAV(preRollBufferRef.current, recordingBufferRef.current, sampleRateRef.current);
        if (processAudioChunkRef.current) processAudioChunkRef.current(blob);
      }
      recordingBufferRef.current = [];
      preRollBufferRef.current = [];
    }

    setIsListening(false);
    if (processorRef.current) processorRef.current.disconnect();
    if (streamRef.current) streamRef.current.getTracks().forEach(t => t.stop());
    if (audioContextRef.current && audioContextRef.current.state !== 'closed') audioContextRef.current.close();
  }, []); // [] — không dependency → stable → useEffect cleanup không fire giữa chừng

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