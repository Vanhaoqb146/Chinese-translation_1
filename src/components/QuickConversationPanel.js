'use client';
import { useState, useRef, useCallback, useEffect } from 'react';
import useQuickConversation from '@/hooks/useQuickConversation';

// Voice options per language — Azure AI Speech (sorted best quality first)
const VOICE_OPTIONS_AZURE = {
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

// Voice options — ElevenLabs (eleven_multilingual_v2 — all voices speak all languages)
const VOICE_OPTIONS_ELEVENLABS = [
  { id: 'pFZP5JQG7iQjIQuC4Bku', label: '⭐ Lily (Nữ, ấm áp)' },
  { id: '21m00Tcm4TlvDq8ikWAM', label: '⭐ Rachel (Nữ, chuyên nghiệp)' },
  { id: 'EXAVITQu4vr4xnSDxMaL', label: 'Sarah (Nữ, nhẹ nhàng)' },
  { id: 'nPczCjzI2devNBz1zQrb', label: 'Brian (Nam, trầm)' },
  { id: 'onwK4e9ZLuTAKqWW03F9', label: 'Daniel (Nam, mạnh mẽ)' },
  { id: 'cgSgspJ2msm6clMCkdW9', label: 'Jessica (Nữ, vui vẻ)' },
  { id: 'iP95p4xoKVk53GoZ742B', label: 'Chris (Nam, thân thiện)' },
  { id: 'XrExE9yKIg1WjnnlVkGX', label: 'Matilda (Nữ, từ tốn)' },
];

/**
 * QuickConversationPanel — Giao diện bong bóng chat tinh gọn dành riêng cho tab "Giao tiếp nhanh".
 *
 * Tối ưu hóa phản hồi micro siêu tốc, zero-cold start, nhả ra dịch ngay lập tức.
 */
export default function QuickConversationPanel({
  apiKey,
  model,
  srcLang,
  tgtLang,
  speak,
  findSttCode,
  LANGUAGES,
  history,
  setHistory,
  sessionUser,
}) {
  const getSessionValue = (key, defaultValue) => {
    if (typeof window !== 'undefined') {
      try {
        const saved = sessionStorage.getItem(`vt_quick_setting_${key}`);
        if (saved !== null) return JSON.parse(saved);
      } catch { /* ignore */ }
    }
    return defaultValue;
  };

  const [convStatus, setConvStatus] = useState('idle');
  const [interimText, setInterimText] = useState('');

  const [silenceSeconds, setSilenceSeconds] = useState(() => getSessionValue('silenceSeconds', 1.2));
  const [provider, setProvider] = useState(() => getSessionValue('provider', 'azure'));
  const [speed, setSpeed] = useState(() => getSessionValue('speed', 1.0));
  const [srcVoice, setSrcVoice] = useState(() => getSessionValue('srcVoice', VOICE_OPTIONS_AZURE[srcLang.translateCode]?.[0]?.id || ''));
  const [tgtVoice, setTgtVoice] = useState(() => getSessionValue('tgtVoice', VOICE_OPTIONS_AZURE[tgtLang.translateCode]?.[0]?.id || ''));
  const [micMode, setMicMode] = useState(() => getSessionValue('micMode', 'hold')); // Default Hold cho Giao tiếp nhanh
  const [autoTTS, setAutoTTS] = useState(() => getSessionValue('autoTTS', true));

  const [drawerOpen, setDrawerOpen] = useState(false);
  const [fontSize, setFontSize] = useState(() => getSessionValue('fontSize', 17));
  const [muteSrc, setMuteSrc] = useState(() => getSessionValue('muteSrc', false));
  const [muteTgt, setMuteTgt] = useState(() => getSessionValue('muteTgt', false));

  // Sync settings to sessionStorage
  useEffect(() => {
    try {
      sessionStorage.setItem('vt_quick_setting_provider', JSON.stringify(provider));
      sessionStorage.setItem('vt_quick_setting_speed', JSON.stringify(speed));
      sessionStorage.setItem('vt_quick_setting_silenceSeconds', JSON.stringify(silenceSeconds));
      sessionStorage.setItem('vt_quick_setting_srcVoice', JSON.stringify(srcVoice));
      sessionStorage.setItem('vt_quick_setting_tgtVoice', JSON.stringify(tgtVoice));
      sessionStorage.setItem('vt_quick_setting_micMode', JSON.stringify(micMode));
      sessionStorage.setItem('vt_quick_setting_autoTTS', JSON.stringify(autoTTS));
      sessionStorage.setItem('vt_quick_setting_fontSize', JSON.stringify(fontSize));
      sessionStorage.setItem('vt_quick_setting_muteSrc', JSON.stringify(muteSrc));
      sessionStorage.setItem('vt_quick_setting_muteTgt', JSON.stringify(muteTgt));
    } catch { /* ignore */ }
  }, [provider, speed, silenceSeconds, srcVoice, tgtVoice, micMode, autoTTS, fontSize, muteSrc, muteTgt]);

  // Tự động gán voice phù hợp khi thay đổi provider hoặc ngôn ngữ
  useEffect(() => {
    if (provider === 'elevenlabs') {
      setSrcVoice(VOICE_OPTIONS_ELEVENLABS[0]?.id || '');
      setTgtVoice(VOICE_OPTIONS_ELEVENLABS[0]?.id || '');
    } else {
      setSrcVoice(VOICE_OPTIONS_AZURE[srcLang.translateCode]?.[0]?.id || '');
      setTgtVoice(VOICE_OPTIONS_AZURE[tgtLang.translateCode]?.[0]?.id || '');
    }
  }, [provider, srcLang.translateCode, tgtLang.translateCode]);

  const muteSrcRef = useRef(false);
  const muteTgtRef = useRef(false);
  useEffect(() => { muteSrcRef.current = muteSrc; }, [muteSrc]);
  useEffect(() => { muteTgtRef.current = muteTgt; }, [muteTgt]);

  const logBodyRef = useRef(null);
  const replayAudioRef = useRef(null);
  const [replayingId, setReplayingId] = useState(null);

  // Auto-scroll xuống cuối bong bóng chat
  const autoScrollToBottom = useCallback(() => {
    setTimeout(() => {
      if (logBodyRef.current) {
        logBodyRef.current.scrollTo({
          top: logBodyRef.current.scrollHeight,
          behavior: 'smooth',
        });
      }
    }, 60);
  }, []);

  const handleInterimText = useCallback((text) => {
    setInterimText(text);
    autoScrollToBottom();
  }, [autoScrollToBottom]);

  const handleFinalResult = useCallback(({ originalText, translatedText, fromLang, toLang, id }) => {
    setHistory(prev => [{
      source: originalText,
      target: translatedText,
      fromLang, toLang,
      time: new Date().toLocaleTimeString('vi-VN', { hour: '2-digit', minute: '2-digit', second: '2-digit' }),
      id,
    }, ...prev].slice(0, 100));
    setInterimText('');
    autoScrollToBottom();

    // Lưu vào database lịch sử
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
  }, [setHistory, sessionUser?.username, autoScrollToBottom]);

  const handleStatusChange = useCallback((status) => setConvStatus(status), []);
  const handleError = useCallback((msg) => {
    setConvStatus('idle');
    console.warn('Quick Conversation Error:', msg);
  }, []);

  const srcVoiceRef = useRef(srcVoice);
  const tgtVoiceRef = useRef(tgtVoice);
  srcVoiceRef.current = srcVoice;
  tgtVoiceRef.current = tgtVoice;

  const getVoiceForLang = useCallback((toLang) => {
    if (toLang === srcLang.translateCode && muteSrcRef.current) return '__MUTED__';
    if (toLang === tgtLang.translateCode && muteTgtRef.current) return '__MUTED__';
    if (toLang === srcLang.translateCode) return srcVoiceRef.current;
    if (toLang === tgtLang.translateCode) return tgtVoiceRef.current;
    return null;
  }, [srcLang.translateCode, tgtLang.translateCode]);

  // Gọi Hook useQuickConversation native siêu tốc
  const conv = useQuickConversation({
    srcLangCode: srcLang.translateCode,
    tgtLangCode: tgtLang.translateCode,
    engine: model,
    silenceMs: silenceSeconds * 1000,
    micMode,
    autoTTS,
    provider,
    speed,
    onInterimText: handleInterimText,
    onFinalResult: handleFinalResult,
    onStatusChange: handleStatusChange,
    onError: handleError,
    getVoiceForLang,
  });

  const stopReplay = useCallback(() => {
    if (replayAudioRef.current) {
      try { replayAudioRef.current.pause(); replayAudioRef.current.currentTime = 0; } catch (e) { /* ignore */ }
      replayAudioRef.current = null;
    }
    setReplayingId(null);
  }, []);

  // Phát lại âm thanh khi click nút loa trên bong bóng chat
  const handleReplay = useCallback(async (text, langCode, msgId) => {
    if (replayingId === msgId) { stopReplay(); return; }
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
        body: JSON.stringify({ text, lang: baseLang, voice, provider }),
      });
      if (!res.ok) { setReplayingId(null); return; }
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const audio = new Audio(url);
      audio.preload = 'auto';
      audio.playsInline = true;
      try {
        audio.setAttribute('playsinline', 'true');
        audio.setAttribute('webkit-playsinline', 'true');
      } catch (e) { /* ignore */ }
      replayAudioRef.current = audio;

      // Áp dụng tốc độ phát giọng nói (Speech Rate)
      try {
        audio.defaultPlaybackRate = speed;
        audio.playbackRate = speed;
      } catch (e) {
        console.warn('⚠️ Gán playbackRate lỗi:', e);
      }

      audio.onended = () => { URL.revokeObjectURL(url); replayAudioRef.current = null; setReplayingId(null); };
      audio.onerror = () => { URL.revokeObjectURL(url); replayAudioRef.current = null; setReplayingId(null); };
      audio.play().catch(() => { setReplayingId(null); });
    } catch (err) {
      console.warn('Replay error:', err);
      setReplayingId(null);
    }
  }, [replayingId, stopReplay, srcVoice, tgtVoice, srcLang.translateCode, tgtLang.translateCode, provider, speed]);

  // Xử lý Click-to-Talk (Bấm nói)
  const handleStartLang = useCallback((lang) => {
    stopReplay();
    if (conv.isListening) {
      conv.stop();
    } else {
      conv.start(lang);
    }
  }, [conv, stopReplay]);

  // Xử lý Hold-to-Talk (Nhấn giữ nói)
  const holdStartTimeRef = useRef(0);
  const handleHoldStart = useCallback((lang, e) => {
    const busy = convStatus === 'translating' || convStatus === 'speaking';
    if (busy || conv.isListening) return;
    
    stopReplay();
    holdStartTimeRef.current = Date.now();
    
    // Bắt capture pointer để mượt mà trên di động
    if (e?.currentTarget?.setPointerCapture && e?.pointerId != null) {
      try { e.currentTarget.setPointerCapture(e.pointerId); } catch (err) { /* ignore */ }
    }
    
    conv.start(lang);
    setTimeout(() => setReplayingId(null), 0);
  }, [conv, convStatus, stopReplay]);

  const handleHoldEnd = useCallback(() => {
    if (!conv.isListening) return;
    conv.stop();
  }, [conv]);

  const handleStopSpeaking = useCallback(() => { conv.stopSpeaking(); }, [conv]);

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

  const isBusy = convStatus === 'translating' || convStatus === 'speaking';
  const isHoldMode = micMode === 'hold';

  // Props helper cho nhấn giữ phím
  const holdProps = (lang) => ({
    onPointerDown: (e) => { e.preventDefault(); handleHoldStart(lang, e); },
    onPointerUp: (e) => { e.preventDefault(); handleHoldEnd(); },
    onPointerCancel: (e) => { e.preventDefault(); handleHoldEnd(); },
    onContextMenu: (e) => e.preventDefault(),
    style: { touchAction: 'none' },
  });

  return (
    <div className="conv-auto">
      {/* Cảnh báo trình duyệt hỗ trợ */}
      {!conv.supported && (
        <div style={{
          background: 'rgba(239, 68, 68, 0.15)', color: '#f87171', fontSize: '13px',
          fontWeight: 600, padding: '10px 14px', borderRadius: '12px', border: '1px solid rgba(239, 68, 68, 0.3)',
          textAlign: 'center', marginBottom: '10px'
        }}>
          ⚠️ Web Speech API native chưa được hỗ trợ tốt trên trình duyệt này. Khuyến nghị bạn sử dụng **Google Chrome** hoặc **Safari** để có tốc độ phản hồi mượt mà nhất.
        </div>
      )}

      {/* ============ HEADER BAR — speakers + hamburger ============ */}
      <div className="conv-header-bar">
        {/* Left: Speaker mute buttons */}
        <div className="conv-header-left">
          <button
            className={`speaker-btn ${muteSrc ? 'muted' : ''}`}
            onClick={() => setMuteSrc(!muteSrc)}
            title={muteSrc ? `Bật loa ${srcLang.name}` : `Tắt loa ${srcLang.name}`}
          >
            <span className="speaker-flag">{srcLang.flag}</span>
            <span className="speaker-icon">{muteSrc ? '🔇' : '🔊'}</span>
          </button>
          <button
            className={`speaker-btn ${muteTgt ? 'muted' : ''}`}
            onClick={() => setMuteTgt(!muteTgt)}
            title={muteTgt ? `Bật loa ${tgtLang.name}` : `Tắt loa ${tgtLang.name}`}
          >
            <span className="speaker-flag">{tgtLang.flag}</span>
            <span className="speaker-icon">{muteTgt ? '🔇' : '🔊'}</span>
          </button>
        </div>

        {/* Center: Title */}
        <div className="conv-header-center">
          <span style={{ fontSize: '13px', fontWeight: 700, color: 'var(--accent2)' }}>⚡ Giao tiếp nhanh (STT Native)</span>
        </div>

        {/* Right: clear + settings */}
        <div className="conv-header-right">
          <button
            className="hamburger-btn"
            onClick={handleClearHistory}
            title="Xóa hội thoại"
            style={{ fontSize: '14px' }}
          >🗑️</button>
          <button
            className="hamburger-btn"
            onClick={() => setDrawerOpen(true)}
            title="Cài đặt nhanh"
          >⚙️</button>
        </div>
      </div>

      {/* ============ FULL-SCREEN CHAT LOG ============ */}
      <div className="conv-log fullscreen-chat">
        <div className="conv-log-body" ref={logBodyRef}>
          {history.length === 0 && !interimText && (
            <div className="conv-empty">
              <div className="conv-empty-icon" style={{ animation: 'pulse 2.5s infinite' }}>⚡</div>
              <div style={{ fontWeight: 700, fontSize: '16px', color: 'var(--text)' }}>Chế độ Giao tiếp siêu tốc</div>
              <div className="conv-empty-sub" style={{ marginTop: '5px' }}>
                {isHoldMode ? 'Nhấn và Giữ nút Micro để nói, nhả ra là dịch luôn' : 'Bấm Micro, nói xong im lặng 1s tự dịch'}
              </div>
              
              {/* CHÚ THÍCH CẢNH BÁO CHO KHÁCH HÀNG */}
              <div style={{
                marginTop: '30px', fontSize: '12px', color: 'var(--muted)',
                background: 'rgba(255,255,255,0.03)', borderRadius: '12px',
                padding: '12px 16px', maxWidth: '320px', border: '1px solid var(--border)',
                lineHeight: 1.4, textAlign: 'left'
              }}>
                <strong style={{ color: 'var(--accent2)', display: 'block', marginBottom: '4px' }}>⚠️ Khuyến cáo sử dụng:</strong>
                Để đảm bảo hiệu năng xử lý tốt nhất và không bị gián đoạn, mỗi lượt phát âm thanh hoặc thu âm liên tục **không nên vượt quá 5 phút**.
              </div>
            </div>
          )}

          {/* Chat bubbles — Zalo style */}
          {history.slice().reverse().map((h, index) => {
            const isSource = h.fromLang === srcLang.translateCode;
            const alignment = isSource ? 'align-right' : 'align-left';

            return (
              <div key={`quick-msg-${h.id}-${index}`} className={`chat-bubble-group ${alignment}`}>
                {/* Original text bubble */}
                <div className="chat-bubble bubble-original" style={{ fontSize: `${fontSize}px` }}>
                  <span className="chat-bubble-flag">{getFlagForLang(h.fromLang)}</span>
                  <span className="chat-bubble-text">{h.source}</span>
                  <button
                    className="chat-bubble-speaker"
                    onClick={() => !isBusy && handleReplay(h.source, findSttCode(h.fromLang), `src-${h.id}`)}
                    disabled={isBusy}
                    title={replayingId === `src-${h.id}` ? 'Dừng' : 'Nghe câu gốc'}
                  >{replayingId === `src-${h.id}` ? '🔇' : '🔊'}</button>
                </div>

                {/* Translated text bubble */}
                <div className="chat-bubble bubble-translated" style={{ fontSize: `${fontSize}px` }}>
                  <span className="chat-bubble-flag">{getFlagForLang(h.toLang)}</span>
                  <span className="chat-bubble-text">{h.target}</span>
                  <button
                    className="chat-bubble-speaker"
                    onClick={() => !isBusy && handleReplay(h.target, findSttCode(h.toLang), `tgt-${h.id}`)}
                    disabled={isBusy}
                    title={replayingId === `tgt-${h.id}` ? 'Dừng' : 'Nghe bản dịch'}
                    style={{ color: 'rgba(255,255,255,0.8)' }}
                  >{replayingId === `tgt-${h.id}` ? '🔇' : '🔊'}</button>
                </div>

                <span className="chat-bubble-time">{h.time}</span>
              </div>
            );
          })}

          {/* Interim text preview */}
          {interimText && (
            <div className="chat-bubble-interim" style={{ fontSize: `${fontSize}px` }}>
              <div className="chat-bubble-interim-text">
                <span style={{ fontSize: '12px', opacity: 0.6, marginRight: 6 }}>
                  {conv.activeLang ? getFlagForLang(conv.activeLang) : '⚡'}
                </span>
                {interimText}
                <span className="chat-bubble-interim-cursor" />
              </div>
            </div>
          )}
        </div>
      </div>

      {/* ============ FAB MIC BUTTONS (Floating Bottom) ============ */}
      <div className="fab-mic-container" style={{ paddingBottom: '12px' }}>
        {/* MANUAL: 2 mics riêng biệt cho 2 ngôn ngữ */}
        <>
          {/* Source mic */}
          <div className="fab-mic-group">
            <button
              className={`fab-mic-btn ${conv.activeLang === srcLang.translateCode ? (isHoldMode ? 'holding' : 'recording') : ''}`}
              disabled={isHoldMode ? false : (isBusy || (conv.isListening && conv.activeLang !== srcLang.translateCode))}
              {...(isHoldMode ? holdProps(srcLang.translateCode) : {
                onClick: () => handleStartLang(srcLang.translateCode),
                onContextMenu: (e) => e.preventDefault(),
              })}
              style={{
                background: conv.activeLang === srcLang.translateCode ? 'var(--accent3)' : 'var(--accent1)',
                boxShadow: conv.activeLang === srcLang.translateCode ? '0 0 25px rgba(2,132,199,0.5)' : '0 4px 15px rgba(14,165,233,0.3)',
              }}
            >
              <span className="fab-mic-btn-icon">
                {conv.activeLang === srcLang.translateCode && convStatus === 'speaking' ? '🔊' :
                  conv.activeLang === srcLang.translateCode && convStatus === 'translating' ? '⏳' :
                    conv.activeLang === srcLang.translateCode ? (isHoldMode ? '🎙' : '⏹') : '🎤'}
              </span>
              {conv.activeLang === srcLang.translateCode && conv.isListening && <span className="pulse-ring" />}
              {conv.activeLang === srcLang.translateCode && conv.isListening && <span className="pulse-ring p2" />}
            </button>
            <div className="fab-mic-label">{srcLang.flag} {srcLang.name}</div>
          </div>

          {/* Center status */}
          <div className="fab-status">
            <span className="fab-status-text" style={{ fontSize: '12px', fontWeight: 700 }}>
              {convStatus === 'idle' && (isHoldMode ? '👇 GIỮ ĐỂ NÓI' : '👆 BẤM ĐỂ NÓI')}
              {convStatus === 'connecting' && '⚡ Khởi động...'}
              {convStatus === 'listening' && (isHoldMode ? '🎙 Đang nghe...' : '🟢 Đang nghe...')}
              {convStatus === 'translating' && '⚡ Dịch nhanh...'}
              {convStatus === 'speaking' && (
                <button className="fab-stop-speaking-btn" onClick={handleStopSpeaking}>🔇 Tắt</button>
              )}
            </span>
            {conv.isListening && <span className="fab-timer">{formatTime(conv.elapsed)}</span>}
          </div>

          {/* Target mic */}
          <div className="fab-mic-group">
            <button
              className={`fab-mic-btn ${conv.activeLang === tgtLang.translateCode ? (isHoldMode ? 'holding' : 'recording') : ''}`}
              disabled={isHoldMode ? false : (isBusy || (conv.isListening && conv.activeLang !== tgtLang.translateCode))}
              {...(isHoldMode ? holdProps(tgtLang.translateCode) : {
                onClick: () => handleStartLang(tgtLang.translateCode),
                onContextMenu: (e) => e.preventDefault(),
              })}
              style={{
                background: conv.activeLang === tgtLang.translateCode ? 'var(--accent3)' : 'var(--accent1)',
                boxShadow: conv.activeLang === tgtLang.translateCode ? '0 0 25px rgba(2,132,199,0.5)' : '0 4px 15px rgba(14,165,233,0.3)',
              }}
            >
              <span className="fab-mic-btn-icon">
                {conv.activeLang === tgtLang.translateCode && convStatus === 'speaking' ? '🔊' :
                  conv.activeLang === tgtLang.translateCode && convStatus === 'translating' ? '⏳' :
                    conv.activeLang === tgtLang.translateCode ? (isHoldMode ? '🎙' : '⏹') : '🎤'}
              </span>
              {conv.activeLang === tgtLang.translateCode && conv.isListening && <span className="pulse-ring" />}
              {conv.activeLang === tgtLang.translateCode && conv.isListening && <span className="pulse-ring p2" />}
            </button>
            <div className="fab-mic-label">{tgtLang.flag} {tgtLang.name}</div>
          </div>
        </>
      </div>

      {/* ============ DRAWER MENU (Settings) ============ */}
      {drawerOpen && (
        <>
          <div className="drawer-overlay" onClick={() => setDrawerOpen(false)} />
          <div className="drawer-content">
            <div className="drawer-header">
              <h3>⚙️ Cài đặt Giao tiếp nhanh</h3>
              <button className="drawer-close-btn" onClick={() => setDrawerOpen(false)}>✕</button>
            </div>
            <div className="drawer-body">
              {/* Cỡ chữ */}
              <div className="drawer-section">
                <div className="drawer-section-title">🔠 Cỡ chữ</div>
                <div className="font-size-slider-row">
                  <span style={{ fontSize: '12px', color: 'var(--muted)' }}>A</span>
                  <input
                    type="range"
                    min={12}
                    max={28}
                    step={1}
                    value={fontSize}
                    onChange={(e) => setFontSize(Number(e.target.value))}
                  />
                  <span style={{ fontSize: '20px', color: 'var(--muted)' }}>A</span>
                  <span className="font-size-value">{fontSize}px</span>
                </div>
              </div>

              {/* Giọng đọc */}
              <div className="drawer-section">
                <div className="drawer-section-title">🤖 Speech Provider</div>
                <div className="drawer-row" style={{ gap: 6 }}>
                  <label>API</label>
                  <div style={{ display: 'flex', gap: 4 }}>
                    {[
                      { key: 'azure', label: 'Azure', icon: '☁️' },
                      { key: 'elevenlabs', label: 'ElevenLabs', icon: '🎭' },
                    ].map(opt => (
                      <button
                        key={opt.key}
                        onClick={() => !conv.isListening && setProvider(opt.key)}
                        disabled={conv.isListening}
                        style={{
                          padding: '5px 14px', fontSize: '12px', fontWeight: 600,
                          borderRadius: 8, cursor: conv.isListening ? 'not-allowed' : 'pointer',
                          border: provider === opt.key ? '1.5px solid #8b5cf6' : '1px solid rgba(0,0,0,0.1)',
                          background: provider === opt.key ? 'rgba(139,92,246,0.12)' : 'rgba(0,0,0,0.02)',
                          color: provider === opt.key ? '#8b5cf6' : '#6b7280',
                          opacity: conv.isListening ? 0.5 : 1,
                          transition: 'all 0.15s',
                        }}
                      >{opt.icon} {opt.label}</button>
                    ))}
                  </div>
                </div>
              </div>

              {/* Tốc độ nói */}
              <div className="drawer-section">
                <div className="drawer-section-title">⚡ Tốc độ phát giọng nói</div>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8, margin: '6px 0 0' }}>
                  <span style={{ fontSize: '11px', color: 'var(--muted)', minWidth: 30 }}>Chậm</span>
                  <input
                    type="range"
                    min={0.8}
                    max={2.0}
                    step={0.1}
                    value={speed}
                    onChange={(e) => setSpeed(Number(e.target.value))}
                    disabled={conv.isListening}
                    style={{ flex: 1, accentColor: '#8b5cf6', cursor: conv.isListening ? 'not-allowed' : 'pointer' }}
                  />
                  <span style={{ fontSize: '11px', color: 'var(--muted)', minWidth: 30, textAlign: 'right' }}>Nhanh</span>
                  <span style={{
                    fontSize: '13px', fontWeight: 700, color: '#8b5cf6',
                    minWidth: 45, padding: '2px 6px', background: 'rgba(139,92,246,0.08)',
                    borderRadius: 6, textAlign: 'center'
                  }}>
                    {speed.toFixed(1)}x
                  </span>
                </div>
              </div>

              {/* Lựa chọn Voice */}
              <div className="drawer-section">
                <div className="drawer-section-title">🔊 Giọng đọc {provider === 'elevenlabs' ? '(ElevenLabs)' : '(Azure)'}</div>
                {provider === 'elevenlabs' ? (
                  <>
                    <div className="drawer-row">
                      <label>{srcLang.flag} Giọng {srcLang.name}</label>
                      <select value={srcVoice} onChange={(e) => setSrcVoice(e.target.value)} disabled={conv.isListening} className="drawer-select">
                        {VOICE_OPTIONS_ELEVENLABS.map(v => <option key={v.id} value={v.id}>{v.label}</option>)}
                      </select>
                    </div>
                    <div className="drawer-row">
                      <label>{tgtLang.flag} Giọng {tgtLang.name}</label>
                      <select value={tgtVoice} onChange={(e) => setTgtVoice(e.target.value)} disabled={conv.isListening} className="drawer-select">
                        {VOICE_OPTIONS_ELEVENLABS.map(v => <option key={v.id} value={v.id}>{v.label}</option>)}
                      </select>
                    </div>
                  </>
                ) : (
                  <>
                    <div className="drawer-row">
                      <label>{srcLang.flag} {srcLang.name}</label>
                      <select value={srcVoice} onChange={(e) => setSrcVoice(e.target.value)} disabled={conv.isListening} className="drawer-select">
                        {(VOICE_OPTIONS_AZURE[srcLang.translateCode] || []).map(v => <option key={v.id} value={v.id}>{v.label}</option>)}
                      </select>
                    </div>
                    <div className="drawer-row">
                      <label>{tgtLang.flag} {tgtLang.name}</label>
                      <select value={tgtVoice} onChange={(e) => setTgtVoice(e.target.value)} disabled={conv.isListening} className="drawer-select">
                        {(VOICE_OPTIONS_AZURE[tgtLang.translateCode] || []).map(v => <option key={v.id} value={v.id}>{v.label}</option>)}
                      </select>
                    </div>
                  </>
                )}
              </div>

              {/* Chế độ micro */}
              <div className="drawer-section">
                <div className="drawer-section-title">🎤 Cấu hình Micro</div>

                {/* Auto TTS toggle */}
                <div className="drawer-row">
                  <label>{autoTTS ? '🔊' : '🔇'} Tự động phát âm bản dịch</label>
                  <div
                    className={`toggle-switch ${autoTTS ? 'on' : 'off'} ${conv.isListening ? 'disabled' : ''}`}
                    onClick={() => !conv.isListening && setAutoTTS(!autoTTS)}
                  >
                    <div className="toggle-switch-knob" />
                  </div>
                </div>

                {/* Mic mode buttons */}
                <div className="drawer-row" style={{ flexWrap: 'wrap', gap: 6 }}>
                  <label>Chế độ</label>
                  <div style={{ display: 'flex', gap: 4 }}>
                    {[
                      { key: 'click', label: 'Bấm nói', icon: '👆' },
                      { key: 'hold', label: 'Nhấn giữ', icon: '✋' },
                    ].map(opt => (
                      <button
                        key={opt.key}
                        onClick={() => !conv.isListening && setMicMode(opt.key)}
                        disabled={conv.isListening}
                        style={{
                          padding: '5px 12px', fontSize: '12px', fontWeight: 600,
                          borderRadius: 8, cursor: conv.isListening ? 'not-allowed' : 'pointer',
                          border: micMode === opt.key ? '1.5px solid #0ea5e9' : '1px solid rgba(0,0,0,0.1)',
                          background: micMode === opt.key ? 'rgba(14,165,233,0.12)' : 'rgba(0,0,0,0.02)',
                          color: micMode === opt.key ? '#0ea5e9' : '#6b7280',
                          opacity: conv.isListening ? 0.5 : 1,
                          transition: 'all 0.15s',
                        }}
                      >
                        {opt.icon} {opt.label}
                      </button>
                    ))}
                  </div>
                </div>

                {/* Silence slider */}
                {micMode === 'click' && (
                  <div className="drawer-row" style={{ gap: 8 }}>
                    <label>🕐 Ngắt sau im lặng</label>
                    <input
                      type="range"
                      min={0.8} max={3.0} step={0.2}
                      value={silenceSeconds}
                      onChange={(e) => setSilenceSeconds(Number(e.target.value))}
                      disabled={conv.isListening}
                      style={{ flex: 1, accentColor: '#0ea5e9', cursor: conv.isListening ? 'not-allowed' : 'pointer' }}
                    />
                    <span style={{ fontSize: '13px', fontWeight: 700, color: '#0ea5e9', minWidth: 35, textAlign: 'center' }}>
                      {silenceSeconds}s
                    </span>
                  </div>
                )}
              </div>

              {/* Warning/Notes */}
              <div style={{
                fontSize: '12px', color: '#eab308', textAlign: 'left', lineHeight: 1.4,
                fontWeight: 600, background: 'rgba(234,179,8,0.06)', borderRadius: 8,
                padding: '10px 14px', border: '1px solid rgba(234,179,8,0.15)',
              }}>
                ⚠️ Khuyến cáo: Không nên nghe phát âm hoặc thu âm liên tục quá 5 phút mỗi lần để đạt hiệu suất và tốc độ tốt nhất.
              </div>
            </div>
          </div>
        </>
      )}
    </div>
  );
}
