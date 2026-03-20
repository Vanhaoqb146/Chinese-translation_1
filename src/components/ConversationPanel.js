'use client';
import { useState, useRef, useCallback } from 'react';
import useRealtimeConversation from '@/hooks/useRealtimeConversation';

// Voice options per language — Azure AI Speech (sorted best quality first)
const VOICE_OPTIONS = {
  vi: [
    { id: 'vi-VN-HoaiMyNeural', label: '⭐ Nữ miền Bắc (HoaiMy)' },
    { id: 'vi-VN-NamMinhNeural', label: '⭐ Nam miền Bắc (NamMinh)' },
    { id: 'vi-VN-ThuDuongNeural', label: 'Nữ miền Nam (ThuDuong)' },
    { id: 'vi-VN-QuangNeural', label: 'Nam miền Nam (Quang)' },
  ],
  zh: [
    { id: 'zh-CN-XiaoxiaoMultilingualNeural', label: '⭐ Nữ Đa ngữ (Xiaoxiao)' },
    { id: 'zh-CN-YunyiMultilingualNeural', label: '⭐ Nam Đa ngữ (Yunyi)' },
    { id: 'zh-CN-XiaoxiaoNeural', label: 'Nữ Phổ thông (Xiaoxiao)' },
    { id: 'zh-CN-YunjianNeural', label: 'Nam Phổ thông (Yunjian)' },
    { id: 'zh-CN-XiaochenNeural', label: 'Nữ Tự nhiên (Xiaochen)' },
    { id: 'zh-CN-YunxiNeural', label: 'Nam Thanh niên (Yunxi)' },
    { id: 'zh-CN-XiaoyiNeural', label: 'Nữ Thanh niên (Xiaoyi)' },
    { id: 'zh-CN-YunyangNeural', label: 'Nam MC tin tức (Yunyang)' },
    { id: 'zh-CN-XiaochenMultilingualNeural', label: 'Nữ Đa ngữ (Xiaochen)' },
    { id: 'zh-CN-liaoning-XiaobeiNeural', label: 'Nữ Đông Bắc' },
    { id: 'zh-CN-shaanxi-XiaoniNeural', label: 'Nữ Thiểm Tây' },
    { id: 'zh-HK-HiuGaaiNeural', label: 'Nữ Quảng Đông' },
    { id: 'zh-HK-WanLungNeural', label: 'Nam Quảng Đông' },
    { id: 'zh-TW-HsiaoChenNeural', label: 'Nữ Đài Loan' },
    { id: 'zh-TW-YunJheNeural', label: 'Nam Đài Loan' },
  ],
  en: [
    { id: 'en-US-JennyMultilingualNeural', label: '⭐ Nữ Đa ngữ (Jenny)' },
    { id: 'en-US-RyanMultilingualNeural', label: '⭐ Nam Đa ngữ (Ryan)' },
    { id: 'en-US-AriaNeural', label: 'Nữ Aria' },
    { id: 'en-US-GuyNeural', label: 'Nam Guy' },
    { id: 'en-US-BrianNeural', label: 'Nam Brian' },
  ],
  ja: [
    { id: 'ja-JP-NanamiNeural', label: 'Nữ Nhật (Nanami)' },
    { id: 'ja-JP-KeitaNeural', label: 'Nam Nhật (Keita)' },
  ],
  ko: [
    { id: 'ko-KR-SunHiNeural', label: 'Nữ Hàn (SunHi)' },
    { id: 'ko-KR-InJoonNeural', label: 'Nam Hàn (InJoon)' },
  ],
};

/**
 * ConversationPanel — 2 Mic Buttons (Tiếng Việt / 中文)
 *
 * Mỗi nút bấm → start(lang) → Deepgram nhận diện ngôn ngữ đó
 * 4s im → REST translate → TTS → resume
 */
export default function ConversationPanel({
  apiKey,
  engine,
  srcLang,
  tgtLang,
  speak,
  findSttCode,
  LANGUAGES,
  history,
  setHistory,
  sessionUser,
}) {
  const [convStatus, setConvStatus] = useState('idle');
  const [interimText, setInterimText] = useState('');
  const [silenceSeconds, setSilenceSeconds] = useState(4);
  const [srcVoice, setSrcVoice] = useState(() => (VOICE_OPTIONS[srcLang.translateCode]?.[0]?.id || ''));
  const [tgtVoice, setTgtVoice] = useState(() => (VOICE_OPTIONS[tgtLang.translateCode]?.[0]?.id || ''));
  const [autoDetect, setAutoDetect] = useState(false);
  const [micMode, setMicMode] = useState('click'); // 'click' | 'continuous' | 'hold'
  const logBodyRef = useRef(null);
  const replayAudioRef = useRef(null); // Audio instance cho replay 🔊
  const [replayingId, setReplayingId] = useState(null); // ID câu đang replay

  const handleInterimText = useCallback((text) => {
    setInterimText(text);
    // Auto-scroll để user thấy text mới nhất
    setTimeout(() => {
      if (logBodyRef.current) logBodyRef.current.scrollTop = logBodyRef.current.scrollHeight;
    }, 30);
  }, []);

  const handleFinalResult = useCallback(({ originalText, translatedText, fromLang, toLang, id }) => {
    setHistory(prev => [{
      source: originalText,
      target: translatedText,
      fromLang, toLang,
      time: new Date().toLocaleTimeString('vi-VN', { hour: '2-digit', minute: '2-digit', second: '2-digit' }),
      id,
    }, ...prev].slice(0, 100));
    setInterimText('');
    setTimeout(() => {
      if (logBodyRef.current) logBodyRef.current.scrollTop = logBodyRef.current.scrollHeight;
    }, 50);

    // Lưu vào DB (fire-and-forget)
    if (sessionUser?.username) {
      fetch('/api/history', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          userId: sessionUser.username,
          source: originalText,
          target: translatedText,
          fromLang, toLang,
        }),
      }).catch(err => console.warn('⚠️ Lưu lịch sử thất bại:', err));
    }
  }, [setHistory, sessionUser?.username]);

  const handleStatusChange = useCallback((status) => setConvStatus(status), []);
  const handleError = useCallback((msg) => {
    setConvStatus('idle');
    console.warn('Conversation Error:', msg);
  }, []);

  // Callback để hook lấy voice theo ngôn ngữ đích
  const srcVoiceRef = useRef(srcVoice);
  const tgtVoiceRef = useRef(tgtVoice);
  srcVoiceRef.current = srcVoice;
  tgtVoiceRef.current = tgtVoice;

  const getVoiceForLang = useCallback((toLang) => {
    if (toLang === srcLang.translateCode) return srcVoiceRef.current;
    if (toLang === tgtLang.translateCode) return tgtVoiceRef.current;
    return null;
  }, [srcLang.translateCode, tgtLang.translateCode]);

  const conv = useRealtimeConversation({
    srcLangCode: srcLang.translateCode,
    tgtLangCode: tgtLang.translateCode,
    engine,
    silenceMs: silenceSeconds * 1000,
    autoDetect,
    micMode,
    onInterimText: handleInterimText,
    onFinalResult: handleFinalResult,
    onStatusChange: handleStatusChange,
    onError: handleError,
    getVoiceForLang,
  });

  // Dừng replay audio nếu đang phát
  const stopReplay = useCallback(() => {
    if (replayAudioRef.current) {
      try { replayAudioRef.current.pause(); replayAudioRef.current.currentTime = 0; } catch (e) { /* ignore */ }
      replayAudioRef.current = null;
    }
    setReplayingId(null);
  }, []);

  // Phát lại (toggle) — bấm lần 1 phát, lần 2 dừng
  const handleReplay = useCallback(async (text, langCode, msgId) => {
    // Toggle: đang phát câu này → dừng
    if (replayingId === msgId) {
      stopReplay();
      return;
    }
    // Dừng replay cũ (nếu có)
    stopReplay();
    setReplayingId(msgId);
    try {
      const baseLang = langCode.split('-')[0].toLowerCase();
      const voice = srcVoice && langCode.includes(srcLang.translateCode)
        ? srcVoice
        : tgtVoice && langCode.includes(tgtLang.translateCode)
          ? tgtVoice : null;
      const res = await fetch('/api/tts', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text, lang: baseLang, voice }),
      });
      if (!res.ok) { setReplayingId(null); return; }
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const audio = new Audio(url);
      replayAudioRef.current = audio;
      audio.onended = () => { URL.revokeObjectURL(url); replayAudioRef.current = null; setReplayingId(null); };
      audio.onerror = () => { URL.revokeObjectURL(url); replayAudioRef.current = null; setReplayingId(null); };
      audio.play().catch(() => { setReplayingId(null); });
    } catch (err) {
      console.warn('Replay error:', err);
      setReplayingId(null);
    }
  }, [replayingId, stopReplay, srcVoice, tgtVoice, srcLang.translateCode, tgtLang.translateCode]);

  // Bấm nút ngôn ngữ → start(lang) (click mode)
  const handleStartLang = useCallback((lang) => {
    stopReplay(); // Tắt replay trước khi mở mic
    if (conv.isListening) {
      conv.stop();
    } else {
      conv.start(lang);
    }
  }, [conv, stopReplay]);

  // Hold mode: nhấn giữ → bắt đầu nghe
  const holdStartTimeRef = useRef(0);

  const handleHoldStart = useCallback((lang, e) => {
    const busy = convStatus === 'translating' || convStatus === 'speaking' || convStatus === 'connecting';
    if (busy || conv.isListening) return;
    // Tắt replay
    if (replayAudioRef.current) {
      try { replayAudioRef.current.pause(); replayAudioRef.current.currentTime = 0; } catch (e) { /* ignore */ }
      replayAudioRef.current = null;
    }
    holdStartTimeRef.current = Date.now();
    // Lock pointer vào button — tránh pointerleave giả khi re-render
    if (e?.target?.setPointerCapture && e?.pointerId != null) {
      try { e.target.setPointerCapture(e.pointerId); } catch (err) { /* ignore */ }
    }
    conv.start(lang);
    setTimeout(() => setReplayingId(null), 0);
  }, [conv, convStatus]);

  // Hold mode: thả tay → dừng + dịch
  const handleHoldEnd = useCallback(() => {
    // Guard: bỏ qua event giả (fire trong < 500ms — do re-render)
    if (Date.now() - holdStartTimeRef.current < 500) {
      console.log('⚠️ [Hold] Bỏ qua — thả tay giả (< 500ms)');
      return;
    }
    if (!conv.isListening) return;
    conv.stopHold();
  }, [conv]);

  // Tắt loa pipeline ngay khi đang phát
  const handleStopSpeaking = useCallback(() => {
    conv.stopSpeaking();
  }, [conv]);

  const handleClearHistory = useCallback(() => {
    setHistory([]);
    setInterimText('');
  }, [setHistory]);

  const formatTime = (s) => {
    const m = Math.floor(s / 60);
    const sec = s % 60;
    return `${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')}`;
  };

  const getFlagForLang = (langCode) => {
    const lang = LANGUAGES.find(l => l.translateCode === langCode);
    return lang ? lang.flag : '🌐';
  };

  const isBusy = convStatus === 'translating' || convStatus === 'speaking' || convStatus === 'connecting';
  const isHoldMode = micMode === 'hold';

  // Helper: tạo pointer event handlers cho hold mode
  const holdProps = (lang) => ({
    onPointerDown: (e) => {
      e.preventDefault();
      handleHoldStart(lang, e);
    },
    onPointerUp: (e) => {
      e.preventDefault();
      handleHoldEnd();
    },
    onPointerLeave: (e) => {
      e.preventDefault();
      handleHoldEnd();
    },
    onContextMenu: (e) => e.preventDefault(),
    style: { touchAction: 'none' }, // Ngăn browser xử lý gesture
  });

  return (
    <div className="conv-auto">
      {/* ===== CHỌN GIỌNG ĐỌC ===== */}
      <div className="voice-selector-row">
        <span className="voice-selector-label">🔊 Giọng đọc:</span>
        <div className="voice-selector-group">
          <span className="voice-selector-lang">{srcLang.flag}</span>
          <select
            value={srcVoice}
            onChange={(e) => setSrcVoice(e.target.value)}
            disabled={conv.isListening}
            className="voice-selector-select"
          >
            {(VOICE_OPTIONS[srcLang.translateCode] || []).map(v => (
              <option key={v.id} value={v.id}>{v.label}</option>
            ))}
          </select>
        </div>
        <div className="voice-selector-group">
          <span className="voice-selector-lang">{tgtLang.flag}</span>
          <select
            value={tgtVoice}
            onChange={(e) => setTgtVoice(e.target.value)}
            disabled={conv.isListening}
            className="voice-selector-select"
          >
            {(VOICE_OPTIONS[tgtLang.translateCode] || []).map(v => (
              <option key={v.id} value={v.id}>{v.label}</option>
            ))}
          </select>
        </div>
      </div>

      {/* ===== LỊCH SỬ HỘI THOẠI (ĐẦU TIÊN) ===== */}
      <div className="conv-log">
        <div className="conv-log-header">
          <span>💬 Cuộc hội thoại</span>
          <div className="panel-actions">
            <button onClick={handleClearHistory} title="Xóa">🗑️</button>
          </div>
        </div>
        <div className="conv-log-body" ref={logBodyRef}>
          {history.length === 0 && (
            <div className="conv-empty">
              <div className="conv-empty-icon">💬</div>
              <div>Nhấn nút micro để bắt đầu</div>
              <div className="conv-empty-sub">
                Chọn {srcLang.flag} {srcLang.name} hoặc {tgtLang.flag} {tgtLang.name}
              </div>
            </div>
          )}
          {history.slice().reverse().map((h, index) => {
            const isSourceSpeaker = h.fromLang === srcLang.translateCode;
            const alignment = isSourceSpeaker ? 'flex-start' : 'flex-end';

            return (
              <div key={`msg-${h.id}-${index}`} style={{ display: 'flex', flexDirection: 'column', alignItems: alignment, marginBottom: '16px', width: '100%' }}>
                {/* Câu gốc */}
                <div style={{
                  background: 'white',
                  color: '#1f2937',
                  padding: '12px 16px',
                  borderRadius: '14px 14px 4px 4px',
                  maxWidth: '92%',
                  boxShadow: '0 2px 8px rgba(0,0,0,0.06)',
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'space-between',
                  gap: '8px',
                  borderLeft: isSourceSpeaker ? '3px solid #0ea5e9' : '3px solid #10b981',
                }}>
                  <span style={{ fontSize: '18px', fontWeight: '600', lineHeight: '1.5' }}>
                    <span style={{ fontSize: '15px', marginRight: '6px' }}>{getFlagForLang(h.fromLang)}</span>
                    {h.source}
                  </span>
                  <button
                    onClick={() => !isBusy && handleReplay(h.source, findSttCode(h.fromLang), `src-${h.id}`)}
                    disabled={isBusy}
                    style={{ background: 'none', border: 'none', cursor: isBusy ? 'not-allowed' : 'pointer', fontSize: '18px', opacity: isBusy ? 0.2 : 0.6, flexShrink: 0 }}
                    title={replayingId === `src-${h.id}` ? 'Dừng' : 'Nghe câu gốc'}
                  >{replayingId === `src-${h.id}` ? '🔇' : '🔊'}</button>
                </div>
                {/* Bản dịch */}
                <div style={{
                  background: isSourceSpeaker ? 'linear-gradient(135deg, #0ea5e9, #06b6d4)' : 'linear-gradient(135deg, #10b981, #059669)',
                  color: 'white',
                  padding: '12px 16px',
                  borderRadius: '4px 4px 14px 14px',
                  maxWidth: '92%',
                  boxShadow: '0 4px 15px rgba(0,0,0,0.08)',
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'space-between',
                  gap: '8px',
                  marginTop: '2px',
                }}>
                  <span style={{ fontSize: '18px', lineHeight: '1.5' }}>
                    <span style={{ fontSize: '15px', marginRight: '6px' }}>{getFlagForLang(h.toLang)}</span>
                    {h.target}
                  </span>
                  <button
                    onClick={() => !isBusy && handleReplay(h.target, findSttCode(h.toLang), `tgt-${h.id}`)}
                    disabled={isBusy}
                    style={{ background: 'none', border: 'none', cursor: isBusy ? 'not-allowed' : 'pointer', fontSize: '18px', opacity: isBusy ? 0.3 : 0.8, color: 'white', flexShrink: 0 }}
                    title={replayingId === `tgt-${h.id}` ? 'Dừng' : 'Nghe bản dịch'}
                  >{replayingId === `tgt-${h.id}` ? '🔇' : '🔊'}</button>
                </div>
                <span style={{ fontSize: '11px', opacity: 0.4, marginTop: '4px', padding: '0 8px' }}>{h.time}</span>
              </div>
            );
          })}
          {/* ===== STT PREVIEW (bên trong conv-log để không đẩy nút mic) ===== */}
          {interimText && (
            <div style={{
              margin: '0 0 8px',
              padding: '12px 16px',
              background: 'rgba(14, 165, 233, 0.05)',
              borderRadius: '12px',
              border: '1px dashed rgba(14, 165, 233, 0.3)',
            }}>
              <div style={{ fontSize: '16px', color: '#4b5563', lineHeight: 1.5 }}>
                <span style={{ fontSize: '11px', opacity: 0.6, marginRight: 6 }}>
                  {conv.activeLang ? getFlagForLang(conv.activeLang) : '🎤'}
                </span>
                {interimText}
                <span style={{ display: 'inline-block', width: 2, height: 16, background: '#0ea5e9', marginLeft: 2, animation: 'blink 1s infinite' }} />
              </div>
            </div>
          )}
        </div>
      </div>

      {/* ===== PHẦN ĐIỀU KHIỂN (DƯỚI CÙNG) ===== */}
      <div className="conv-bottom-controls">
        {/* Cảnh báo */}
        <div style={{ fontSize: '0.65rem', color: '#ff4d4f', textAlign: 'center', lineHeight: 1.4, fontWeight: 600, background: 'rgba(255,77,79,0.08)', borderRadius: 6, padding: '4px 10px', border: '1px solid rgba(255,77,79,0.2)', margin: '0 16px 6px' }}>
          ⚠️ Không nên thu âm quá 3 phút để đảm bảo dịch tốt!
        </div>

        {/* NÚT MIC */}
        <div className="ptt-controls">
          {autoDetect ? (
            /* === CHẾ ĐỘ TỰ NHẬN DẠNG: 1 NÚT MIC === */
            <>
              <div className="ptt-group">
                <button
                  className={`ptt-btn ${conv.isListening ? (isHoldMode ? 'holding' : 'recording') : ''}`}
                  disabled={isHoldMode ? false : isBusy}
                  {...(isHoldMode ? holdProps(srcLang.translateCode) : {
                    onClick: () => handleStartLang(srcLang.translateCode),
                    onContextMenu: (e) => e.preventDefault(),
                  })}
                >
                  <span className="ptt-btn-icon">
                    {convStatus === 'speaking' ? '🔊' :
                      convStatus === 'translating' ? '⏳' :
                        convStatus === 'connecting' ? '⏳' :
                          conv.isListening ? (isHoldMode ? '🎙' : '⏹') : '🎤'}
                  </span>
                  {conv.isListening && convStatus === 'listening' && <span className="pulse-ring" />}
                  {conv.isListening && convStatus === 'listening' && <span className="pulse-ring p2" />}
                </button>
                <div className="ptt-label">
                  {conv.activeLang ? getFlagForLang(conv.activeLang) : '🌐'} Tự nhận dạng
                </div>
              </div>

              {/* Trạng thái */}
              <div className="ptt-hint">
                {convStatus === 'idle' && (isHoldMode ? '👇 Nhấn giữ để nói' : '👆 Bấm để bắt đầu')}
                {convStatus === 'connecting' && '⏳ Đang kết nối...'}
                {convStatus === 'listening' && (
                  <span>{isHoldMode ? '🎙 Đang nghe...' : '🟢 Đang nghe...'} {conv.activeLang ? getFlagForLang(conv.activeLang) : ''}</span>
                )}
                {convStatus === 'translating' && '⏳ Đang dịch...'}
                {convStatus === 'speaking' && (
                  <span style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                    🔊 Đang phát...
                    <button
                      onClick={handleStopSpeaking}
                      style={{
                        background: 'rgba(239,68,68,0.15)', border: '1px solid rgba(239,68,68,0.3)',
                        borderRadius: 6, padding: '2px 8px', cursor: 'pointer',
                        fontSize: '11px', fontWeight: 600, color: '#ef4444',
                      }}
                      title="Tắt loa"
                    >🔇 Tắt</button>
                  </span>
                )}
              </div>
            </>
          ) : (
            /* === CHẾ ĐỘ THỦ CÔNG: 2 NÚT MIC === */
            <>
              {/* Nút ngôn ngữ nguồn */}
              <div className="ptt-group">
                <button
                  className={`ptt-btn ${conv.activeLang === srcLang.translateCode ? (isHoldMode ? 'holding' : 'recording') : ''}`}
                  disabled={isHoldMode ? false : (isBusy || (conv.isListening && conv.activeLang !== srcLang.translateCode))}
                  {...(isHoldMode ? holdProps(srcLang.translateCode) : {
                    onClick: () => handleStartLang(srcLang.translateCode),
                    onContextMenu: (e) => e.preventDefault(),
                  })}
                >
                  <span className="ptt-btn-icon">
                    {conv.activeLang === srcLang.translateCode && convStatus === 'speaking' ? '🔊' :
                      conv.activeLang === srcLang.translateCode && convStatus === 'translating' ? '⏳' :
                        conv.activeLang === srcLang.translateCode ? (isHoldMode ? '🎙' : '⏹') : '🎤'}
                  </span>
                  {conv.activeLang === srcLang.translateCode && convStatus === 'listening' && <span className="pulse-ring" />}
                  {conv.activeLang === srcLang.translateCode && convStatus === 'listening' && <span className="pulse-ring p2" />}
                </button>
                <div className="ptt-label">{srcLang.flag} {srcLang.name}</div>
              </div>

              {/* Trạng thái ở giữa */}
              <div className="ptt-hint">
                {convStatus === 'idle' && (isHoldMode ? '👇 Nhấn giữ để nói' : '👆 Chọn ngôn ngữ')}
                {convStatus === 'connecting' && '⏳ Đang kết nối...'}
                {convStatus === 'listening' && (isHoldMode ? '🎙 Thả tay để dịch...' : '🟢 Đang nghe...')}
                {convStatus === 'translating' && '⏳ Đang dịch...'}
                {convStatus === 'speaking' && (
                  <span style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                    🔊 Đang phát...
                    <button
                      onClick={handleStopSpeaking}
                      style={{
                        background: 'rgba(239,68,68,0.15)', border: '1px solid rgba(239,68,68,0.3)',
                        borderRadius: 6, padding: '2px 8px', cursor: 'pointer',
                        fontSize: '11px', fontWeight: 600, color: '#ef4444',
                      }}
                      title="Tắt loa"
                    >🔇 Tắt</button>
                  </span>
                )}
              </div>

              {/* Nút ngôn ngữ đích */}
              <div className="ptt-group">
                <button
                  className={`ptt-btn ${conv.activeLang === tgtLang.translateCode ? (isHoldMode ? 'holding' : 'recording') : ''}`}
                  disabled={isHoldMode ? false : (isBusy || (conv.isListening && conv.activeLang !== tgtLang.translateCode))}
                  {...(isHoldMode ? holdProps(tgtLang.translateCode) : {
                    onClick: () => handleStartLang(tgtLang.translateCode),
                    onContextMenu: (e) => e.preventDefault(),
                  })}
                >
                  <span className="ptt-btn-icon">
                    {conv.activeLang === tgtLang.translateCode && convStatus === 'speaking' ? '🔊' :
                      conv.activeLang === tgtLang.translateCode && convStatus === 'translating' ? '⏳' :
                        conv.activeLang === tgtLang.translateCode ? (isHoldMode ? '🎙' : '⏹') : '🎤'}
                  </span>
                  {conv.activeLang === tgtLang.translateCode && convStatus === 'listening' && <span className="pulse-ring" />}
                  {conv.activeLang === tgtLang.translateCode && convStatus === 'listening' && <span className="pulse-ring p2" />}
                </button>
                <div className="ptt-label">{tgtLang.flag} {tgtLang.name}</div>
              </div>
            </>
          )}
        </div>

        {/* Timer + Info — luôn render để tránh layout jump */}
        <div style={{
          textAlign: 'center', marginTop: '-2px', marginBottom: '2px', height: '18px',
          visibility: conv.isListening ? 'visible' : 'hidden',
          opacity: conv.isListening ? 1 : 0,
          transition: 'opacity 0.15s',
        }}>
          <div className="ptt-timer">{formatTime(conv.elapsed)}</div>
        </div>

        {/* CÀI ĐẶT */}
        <div style={{
          display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap',
          margin: '0 16px 6px', padding: '6px 12px',
          background: 'rgba(14, 165, 233, 0.05)',
          borderRadius: 8, border: '1px solid rgba(14, 165, 233, 0.15)',
        }}>
          {/* Toggle tự nhận dạng */}
          <label style={{ display: 'flex', alignItems: 'center', gap: 5, cursor: conv.isListening ? 'not-allowed' : 'pointer', fontSize: '12px', color: '#4b5563', fontWeight: 500, whiteSpace: 'nowrap' }}>
            <div
              onClick={() => !conv.isListening && setAutoDetect(!autoDetect)}
              style={{
                width: 36, height: 20, borderRadius: 10,
                background: autoDetect ? '#0ea5e9' : '#d1d5db',
                position: 'relative', transition: 'background 0.2s',
                cursor: conv.isListening ? 'not-allowed' : 'pointer',
                opacity: conv.isListening ? 0.5 : 1,
              }}
            >
              <div style={{
                width: 16, height: 16, borderRadius: '50%',
                background: 'white', position: 'absolute',
                top: 2, left: autoDetect ? 18 : 2,
                transition: 'left 0.2s',
                boxShadow: '0 1px 3px rgba(0,0,0,0.2)',
              }} />
            </div>
            🌐 Auto
          </label>

          {/* Chế độ mic */}
          <>
            <div style={{ width: 1, height: 20, background: 'rgba(14,165,233,0.2)' }} />

            <div style={{ display: 'flex', alignItems: 'center', gap: 3 }}>
              <span style={{ fontSize: '12px', color: '#4b5563', fontWeight: 500, marginRight: 3, whiteSpace: 'nowrap' }}>🎤</span>
              {[
                ...(!autoDetect ? [{ key: 'click', label: 'Bấm', icon: '👆' }] : []),
                { key: 'continuous', label: 'Liên tục', icon: '🔄' },
                { key: 'hold', label: 'Giữ', icon: '✋' },
              ].map(opt => (
                <button
                  key={opt.key}
                  onClick={() => !conv.isListening && setMicMode(opt.key)}
                  disabled={conv.isListening}
                  style={{
                    padding: '3px 8px', fontSize: '11px', fontWeight: 600,
                    borderRadius: 6, cursor: conv.isListening ? 'not-allowed' : 'pointer',
                    border: micMode === opt.key ? '1px solid #0ea5e9' : '1px solid rgba(0,0,0,0.1)',
                    background: micMode === opt.key ? 'rgba(14,165,233,0.15)' : 'rgba(0,0,0,0.03)',
                    color: micMode === opt.key ? '#0ea5e9' : '#6b7280',
                    opacity: conv.isListening ? 0.5 : 1,
                    transition: 'all 0.15s',
                    whiteSpace: 'nowrap',
                  }}
                >
                  {opt.icon} {opt.label}
                </button>
              ))}
            </div>
          </>

          {/* Silence slider — chỉ hiện khi KHÔNG bật hold mode và không bật autoDetect */}
          {micMode !== 'hold' && (
            <>
              <div style={{ width: 1, height: 20, background: 'rgba(14,165,233,0.2)' }} />

              <span style={{ fontSize: '13px', whiteSpace: 'nowrap', color: '#4b5563', fontWeight: 500 }}>
                🕐 Dịch sau
              </span>
              <input
                type="range"
                min={2} max={10} step={1}
                value={silenceSeconds}
                onChange={(e) => setSilenceSeconds(Number(e.target.value))}
                disabled={conv.isListening}
                style={{ flex: 1, minWidth: 60, accentColor: '#0ea5e9', cursor: conv.isListening ? 'not-allowed' : 'pointer' }}
              />
              <span style={{
                fontSize: '13px', fontWeight: 700, color: '#0ea5e9',
                minWidth: 30, textAlign: 'center',
              }}>
                {silenceSeconds}s
              </span>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
