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
}) {
  const [convStatus, setConvStatus] = useState('idle');
  const [interimText, setInterimText] = useState('');
  const [silenceSeconds, setSilenceSeconds] = useState(4);
  const [srcVoice, setSrcVoice] = useState(() => (VOICE_OPTIONS[srcLang.translateCode]?.[0]?.id || ''));
  const [tgtVoice, setTgtVoice] = useState(() => (VOICE_OPTIONS[tgtLang.translateCode]?.[0]?.id || ''));
  const [autoDetect, setAutoDetect] = useState(false);
  const [holdMode, setHoldMode] = useState(false);
  const logBodyRef = useRef(null);

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
  }, [setHistory]);

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
    holdMode,
    onInterimText: handleInterimText,
    onFinalResult: handleFinalResult,
    onStatusChange: handleStatusChange,
    onError: handleError,
    getVoiceForLang,
  });

  // Bấm nút ngôn ngữ → start(lang) (click mode)
  const handleStartLang = useCallback((lang) => {
    if (conv.isListening) {
      conv.stop();
    } else {
      conv.start(lang);
    }
  }, [conv]);

  // Hold mode: nhấn giữ → bắt đầu nghe
  const handleHoldStart = useCallback((lang) => {
    const busy = convStatus === 'translating' || convStatus === 'speaking' || convStatus === 'connecting';
    if (busy || conv.isListening) return;
    conv.start(lang);
  }, [conv, convStatus]);

  // Hold mode: thả tay → dừng + dịch
  const handleHoldEnd = useCallback(() => {
    if (!conv.isListening) return;
    conv.stopHold();
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

  // Helper: tạo pointer event handlers cho hold mode
  const holdProps = (lang) => ({
    onPointerDown: (e) => {
      e.preventDefault();
      handleHoldStart(lang);
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
                  padding: '10px 14px',
                  borderRadius: '14px 14px 4px 4px',
                  maxWidth: '88%',
                  boxShadow: '0 2px 8px rgba(0,0,0,0.06)',
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'space-between',
                  gap: '8px',
                  borderLeft: isSourceSpeaker ? '3px solid #0ea5e9' : '3px solid #10b981',
                }}>
                  <span style={{ fontSize: '15px', fontWeight: '600', lineHeight: '1.5' }}>
                    <span style={{ fontSize: '13px', marginRight: '6px' }}>{getFlagForLang(h.fromLang)}</span>
                    {h.source}
                  </span>
                  <button
                    onClick={() => speak(h.source, findSttCode(h.fromLang))}
                    style={{ background: 'none', border: 'none', cursor: 'pointer', fontSize: '15px', opacity: 0.6, flexShrink: 0 }}
                    title="Nghe câu gốc"
                  >🔊</button>
                </div>
                {/* Bản dịch */}
                <div style={{
                  background: isSourceSpeaker ? 'linear-gradient(135deg, #0ea5e9, #06b6d4)' : 'linear-gradient(135deg, #10b981, #059669)',
                  color: 'white',
                  padding: '10px 14px',
                  borderRadius: '4px 4px 14px 14px',
                  maxWidth: '88%',
                  boxShadow: '0 4px 15px rgba(0,0,0,0.08)',
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'space-between',
                  gap: '8px',
                  marginTop: '2px',
                }}>
                  <span style={{ fontSize: '15px', lineHeight: '1.5' }}>
                    <span style={{ fontSize: '13px', marginRight: '6px' }}>{getFlagForLang(h.toLang)}</span>
                    {h.target}
                  </span>
                  <button
                    onClick={() => speak(h.target, findSttCode(h.toLang))}
                    style={{ background: 'none', border: 'none', cursor: 'pointer', fontSize: '15px', opacity: 0.8, color: 'white', flexShrink: 0 }}
                    title="Nghe bản dịch"
                  >🔊</button>
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
              <div style={{ fontSize: '14px', color: '#4b5563', lineHeight: 1.5 }}>
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
        <div style={{ fontSize: '0.72rem', color: '#ff4d4f', textAlign: 'center', lineHeight: 1.6, fontWeight: 600, background: 'rgba(255,77,79,0.08)', borderRadius: 8, padding: '6px 12px', border: '1px solid rgba(255,77,79,0.2)', margin: '0 16px 8px' }}>
          ⚠️ Không nên thu âm quá 3 phút để dịch chính xác nhất!
        </div>

        {/* NÚT MIC */}
        <div className="ptt-controls">
          {autoDetect ? (
            /* === CHẾ ĐỘ TỰ NHẬN DẠNG: 1 NÚT MIC === */
            <>
              <div className="ptt-group">
                <button
                  className={`ptt-btn ${conv.isListening ? (holdMode ? 'holding' : 'recording') : ''}`}
                  disabled={isBusy}
                  {...(holdMode ? holdProps(srcLang.translateCode) : {
                    onClick: () => handleStartLang(srcLang.translateCode),
                    onContextMenu: (e) => e.preventDefault(),
                  })}
                >
                  <span className="ptt-btn-icon">
                    {convStatus === 'speaking' ? '🔊' :
                     convStatus === 'translating' ? '⏳' :
                     convStatus === 'connecting' ? '⏳' :
                     conv.isListening ? (holdMode ? '🎙' : '⏹') : '🎤'}
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
                {convStatus === 'idle' && (holdMode ? '👇 Nhấn giữ để nói' : '👆 Bấm để bắt đầu')}
                {convStatus === 'connecting' && '⏳ Đang kết nối...'}
                {convStatus === 'listening' && (
                  <span>{holdMode ? '🎙 Đang nghe... thả tay để dịch' : '🟢 Đang nghe...'} {conv.activeLang ? getFlagForLang(conv.activeLang) : ''}</span>
                )}
                {convStatus === 'translating' && '⏳ Đang dịch...'}
                {convStatus === 'speaking' && '🔊 Đang phát...'}
              </div>
            </>
          ) : (
            /* === CHẾ ĐỘ THỦ CÔNG: 2 NÚT MIC === */
            <>
              {/* Nút ngôn ngữ nguồn */}
              <div className="ptt-group">
                <button
                  className={`ptt-btn ${conv.activeLang === srcLang.translateCode ? (holdMode ? 'holding' : 'recording') : ''}`}
                  disabled={isBusy || (conv.isListening && conv.activeLang !== srcLang.translateCode)}
                  {...(holdMode ? holdProps(srcLang.translateCode) : {
                    onClick: () => handleStartLang(srcLang.translateCode),
                    onContextMenu: (e) => e.preventDefault(),
                  })}
                >
                  <span className="ptt-btn-icon">
                    {conv.activeLang === srcLang.translateCode && convStatus === 'speaking' ? '🔊' :
                     conv.activeLang === srcLang.translateCode && convStatus === 'translating' ? '⏳' :
                     conv.activeLang === srcLang.translateCode ? (holdMode ? '🎙' : '⏹') : '🎤'}
                  </span>
                  {conv.activeLang === srcLang.translateCode && convStatus === 'listening' && <span className="pulse-ring" />}
                  {conv.activeLang === srcLang.translateCode && convStatus === 'listening' && <span className="pulse-ring p2" />}
                </button>
                <div className="ptt-label">{srcLang.flag} {srcLang.name}</div>
              </div>

              {/* Trạng thái ở giữa */}
              <div className="ptt-hint">
                {convStatus === 'idle' && (holdMode ? '👇 Nhấn giữ để nói' : '👆 Chọn ngôn ngữ')}
                {convStatus === 'connecting' && '⏳ Đang kết nối...'}
                {convStatus === 'listening' && (holdMode ? '🎙 Thả tay để dịch...' : '🟢 Đang nghe...')}
                {convStatus === 'translating' && '⏳ Đang dịch...'}
                {convStatus === 'speaking' && '🔊 Đang phát...'}
              </div>

              {/* Nút ngôn ngữ đích */}
              <div className="ptt-group">
                <button
                  className={`ptt-btn ${conv.activeLang === tgtLang.translateCode ? (holdMode ? 'holding' : 'recording') : ''}`}
                  disabled={isBusy || (conv.isListening && conv.activeLang !== tgtLang.translateCode)}
                  {...(holdMode ? holdProps(tgtLang.translateCode) : {
                    onClick: () => handleStartLang(tgtLang.translateCode),
                    onContextMenu: (e) => e.preventDefault(),
                  })}
                >
                  <span className="ptt-btn-icon">
                    {conv.activeLang === tgtLang.translateCode && convStatus === 'speaking' ? '🔊' :
                     conv.activeLang === tgtLang.translateCode && convStatus === 'translating' ? '⏳' :
                     conv.activeLang === tgtLang.translateCode ? (holdMode ? '🎙' : '⏹') : '🎤'}
                  </span>
                  {conv.activeLang === tgtLang.translateCode && convStatus === 'listening' && <span className="pulse-ring" />}
                  {conv.activeLang === tgtLang.translateCode && convStatus === 'listening' && <span className="pulse-ring p2" />}
                </button>
                <div className="ptt-label">{tgtLang.flag} {tgtLang.name}</div>
              </div>
            </>
          )}
        </div>

        {/* Timer + Info */}
        {conv.isListening && (
          <div style={{ textAlign: 'center', marginTop: '-4px', marginBottom: '4px' }}>
            <div className="ptt-timer">{formatTime(conv.elapsed)}</div>
          </div>
        )}

        {/* CÀI ĐẶT */}
        <div style={{
          display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap',
          margin: '0 16px 8px', padding: '8px 14px',
          background: 'rgba(14, 165, 233, 0.05)',
          borderRadius: 10, border: '1px solid rgba(14, 165, 233, 0.15)',
        }}>
          {/* Toggle tự nhận dạng */}
          <label style={{ display: 'flex', alignItems: 'center', gap: 6, cursor: conv.isListening ? 'not-allowed' : 'pointer', fontSize: '13px', color: '#4b5563', fontWeight: 500, whiteSpace: 'nowrap' }}>
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
            🌐 Tự nhận dạng
          </label>

          <div style={{ width: 1, height: 20, background: 'rgba(14,165,233,0.2)' }} />

          {/* Toggle nhấn giữ mic */}
          <label style={{ display: 'flex', alignItems: 'center', gap: 6, cursor: conv.isListening ? 'not-allowed' : 'pointer', fontSize: '13px', color: '#4b5563', fontWeight: 500, whiteSpace: 'nowrap' }}>
            <div
              onClick={() => !conv.isListening && setHoldMode(!holdMode)}
              style={{
                width: 36, height: 20, borderRadius: 10,
                background: holdMode ? '#10b981' : '#d1d5db',
                position: 'relative', transition: 'background 0.2s',
                cursor: conv.isListening ? 'not-allowed' : 'pointer',
                opacity: conv.isListening ? 0.5 : 1,
              }}
            >
              <div style={{
                width: 16, height: 16, borderRadius: '50%',
                background: 'white', position: 'absolute',
                top: 2, left: holdMode ? 18 : 2,
                transition: 'left 0.2s',
                boxShadow: '0 1px 3px rgba(0,0,0,0.2)',
              }} />
            </div>
            ✋ Nhấn giữ
          </label>

          {/* Silence slider — chỉ hiện khi KHÔNG bật holdMode */}
          {!holdMode && (
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
