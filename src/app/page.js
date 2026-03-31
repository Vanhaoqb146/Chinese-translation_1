'use client';
import { useState, useEffect, useRef, useCallback } from 'react';
import useSpeechRecognition from '@/hooks/useSpeechRecognition';
import useTranslation from '@/hooks/useTranslation';
import ConversationPanel from '@/components/ConversationPanel';
import LoginForm from '@/components/LoginForm';
import ChangePasswordModal from '@/components/ChangePasswordModal';

const LANGUAGES = [
  { flag: '🇨🇳', name: '中文', sttCode: 'zh-CN', translateCode: 'zh', ttsCode: 'zh-CN' },
  { flag: '🇻🇳', name: 'Tiếng Việt', sttCode: 'vi-VN', translateCode: 'vi', ttsCode: 'vi-VN' },
  { flag: '🇺🇸', name: 'English', sttCode: 'en-US', translateCode: 'en', ttsCode: 'en-US' },
  { flag: '🇯🇵', name: '日本語', sttCode: 'ja-JP', translateCode: 'ja', ttsCode: 'ja-JP' },
  { flag: '🇰🇷', name: '한국어', sttCode: 'ko-KR', translateCode: 'ko', ttsCode: 'ko-KR' },
];


// Default voices for standard mode — Azure AI Speech (best female voices)
const DEFAULT_VOICES = {
  zh: 'zh-CN-XiaoxiaoMultilingualNeural',
  vi: 'vi-VN-HoaiMyNeural',
  en: 'en-US-JennyMultilingualNeural',
  ja: 'ja-JP-NanamiNeural',
  ko: 'ko-KR-SunHiNeural',
};

export default function HomePage() {
  const [sessionUser, setSessionUser] = useState(null);
  const [authChecked, setAuthChecked] = useState(false);
  const [showChangePw, setShowChangePw] = useState(false);

  const [viewMode, setViewMode] = useState('standard');
  const [srcIdx, setSrcIdx] = useState(0);
  const [tgtIdx, setTgtIdx] = useState(1);
  const [engine, setEngine] = useState('openai');
  const [apiKey, setApiKey] = useState('');
  const [showSettings, setShowSettings] = useState(false);
  const [sourceBlocks, setSourceBlocks] = useState([]);
  const [targetBlocks, setTargetBlocks] = useState([]);
  const [interimText, setInterimText] = useState('');
  const [activeMic, setActiveMic] = useState(null);
  const activeMicRef = useRef(null);
  const [history, setHistory] = useState([]);
  const [isHeaderHidden, setIsHeaderHidden] = useState(() => {
    if (typeof window !== 'undefined') {
      try { return JSON.parse(sessionStorage.getItem('vt_setting_isHeaderHidden')) || false; }
      catch { return false; }
    }
    return false;
  });

  useEffect(() => {
    try { sessionStorage.setItem('vt_setting_isHeaderHidden', JSON.stringify(isHeaderHidden)); } catch { /* ignore */ }
  }, [isHeaderHidden]);

  const [convHistory, setConvHistory] = useState(() => {
    if (typeof window !== 'undefined') {
      try {
        const saved = sessionStorage.getItem('vt_conv_history');
        return saved ? JSON.parse(saved) : [];
      } catch { return []; }
    }
    return [];
  });

  useEffect(() => { activeMicRef.current = activeMic; }, [activeMic]);
  const [toast, setToast] = useState('');

  const sourceRef = useRef(null);
  const targetRef = useRef(null);
  const ttsAbortRef = useRef(null);

  const [mounted, setMounted] = useState(false);
  const [playingId, setPlayingId] = useState(null); // ID của câu đang phát TTS

  useEffect(() => {
    setMounted(true);
    const savedUser = localStorage.getItem('vt_user');
    if (savedUser) setSessionUser(JSON.parse(savedUser));
    setAuthChecked(true);
  }, []);

  // Sync convHistory → sessionStorage
  useEffect(() => {
    try { sessionStorage.setItem('vt_conv_history', JSON.stringify(convHistory)); } catch { /* ignore */ }
  }, [convHistory]);

  const handleLogin = (user) => {
    setSessionUser(user);
    localStorage.setItem('vt_user', JSON.stringify(user));
  };

  const handleLogout = () => {
    setSessionUser(null);
    localStorage.removeItem('vt_user');
    sessionStorage.removeItem('vt_conv_history');
  };

  // Load voices — removed (using Edge TTS API now)

  const showToast = useCallback((msg) => {
    setToast(msg);
    setTimeout(() => setToast(''), 3000);
  }, []);

  const srcLang = LANGUAGES[srcIdx];
  const tgtLang = LANGUAGES[tgtIdx];

  const findSttCode = (translateCode) => {
    const lang = LANGUAGES.find(l => l.translateCode === translateCode);
    return lang ? lang.ttsCode : translateCode;
  };

  // TTS via Edge TTS API
  const speak = useCallback((text, langCode, blockId) => {
    return new Promise(async (resolve) => {
      if (!text) return resolve();

      // Toggle: nếu đang phát câu này → dừng
      if (blockId && playingId === blockId) {
        if (ttsAbortRef.current) ttsAbortRef.current.abort();
        setPlayingId(null);
        return resolve();
      }

      // Cancel previous TTS if any
      if (ttsAbortRef.current) ttsAbortRef.current.abort();
      const controller = new AbortController();
      ttsAbortRef.current = controller;
      if (blockId) setPlayingId(blockId);

      try {
        const baseLang = langCode.split('-')[0].toLowerCase();
        const voice = DEFAULT_VOICES[baseLang] || DEFAULT_VOICES['en'];

        const res = await fetch('/api/tts', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ text, lang: baseLang, voice }),
          signal: controller.signal,
        });

        if (!res.ok) {
          console.warn('TTS API error:', res.status);
          setPlayingId(null);
          return resolve();
        }

        const blob = await res.blob();
        const url = URL.createObjectURL(blob);
        const audio = new Audio(url);
        audio.onended = () => { URL.revokeObjectURL(url); setPlayingId(null); resolve(); };
        audio.onerror = () => { URL.revokeObjectURL(url); setPlayingId(null); resolve(); };
        audio.play().catch(() => { setPlayingId(null); resolve(); });
      } catch (err) {
        if (err.name !== 'AbortError') console.warn('TTS error:', err);
        setPlayingId(null);
        resolve();
      }
    });
  }, [playingId]);

  // Translation hook (Standard mode)
  const { isTranslating, queueTranslation, flush } = useTranslation();

  const sttSourceRef = useRef(null);

  const handleFinalResult = useCallback((text, panel) => {
    const cleanText = text.trim();
    const lowerText = cleanText.toLowerCase();
    const noiseWords = ['phẩy.', 'chấm.', 'phẩy', 'chấm', ',', '.', '?', '!'];
    if (!cleanText || noiseWords.includes(lowerText)) return;

    // [KEY] Auto-stop mic khi có kết quả cuối cùng
    setActiveMic(null);
    setInterimText('');

    if (panel === 'source') {
      setSourceBlocks(prev => [...prev, { text: cleanText, type: 'final', id: Date.now() }]);
      queueTranslation(cleanText, LANGUAGES[srcIdx].translateCode, LANGUAGES[tgtIdx].translateCode, { apiKey, engine },
        async (origText, translated) => {
          setTargetBlocks(prev => [...prev, { text: translated, type: 'final', id: Date.now() }]);
          // Lưu lịch sử dịch
          setHistory(prev => [{
            source: origText, target: translated, id: Date.now(),
            time: new Date().toLocaleTimeString('vi-VN', { hour: '2-digit', minute: '2-digit', second: '2-digit' }),
          }, ...prev].slice(0, 50));
          await speak(translated, LANGUAGES[tgtIdx].ttsCode);
        });
    } else {
      setTargetBlocks(prev => [...prev, { text: cleanText, type: 'final', id: Date.now() }]);
      queueTranslation(cleanText, LANGUAGES[tgtIdx].translateCode, LANGUAGES[srcIdx].translateCode, { apiKey, engine },
        async (origText, translated) => {
          setSourceBlocks(prev => [...prev, { text: translated, type: 'final', id: Date.now() }]);
          // Lưu lịch sử dịch
          setHistory(prev => [{
            source: origText, target: translated, id: Date.now(),
            time: new Date().toLocaleTimeString('vi-VN', { hour: '2-digit', minute: '2-digit', second: '2-digit' }),
          }, ...prev].slice(0, 50));
          await speak(translated, LANGUAGES[srcIdx].ttsCode);
        });
    }
  }, [srcIdx, tgtIdx, apiKey, engine, queueTranslation]);

  const handleFinalResultSource = useCallback((t) => handleFinalResult(t, 'source'), [handleFinalResult]);

  const handleInterimResult = useCallback((text) => {
    setInterimText(text);
  }, []);

  const handleSttError = useCallback((err) => {
    if (err === 'not-allowed') showToast('❌ Vui lòng cấp quyền truy cập Mic');
    else if (err === 'audio-capture') showToast('❌ Không tìm thấy thiết bị Mic');
    else if (err !== 'no-speech' && err !== 'aborted') console.warn('Lỗi STT: ' + err);
  }, [showToast]);

  const sttSource = useSpeechRecognition({
    lang: LANGUAGES[srcIdx].sttCode,
    onResult: handleFinalResultSource,
    onInterim: handleInterimResult,
    onError: handleSttError
  });

  useEffect(() => { sttSourceRef.current = sttSource; }, [sttSource]);

  // (Auto Conversation đã được thay thế bởi ConversationPanel component)

  const formatTime = (s) => {
    const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = s % 60;
    return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')}`;
  };

  const toggleMic = (panel) => {
    if (viewMode === 'conversation') return;
    if (activeMic === panel) {
      // User bấm dừng thủ công
      if (sttSourceRef.current) sttSourceRef.current.stop();
      setActiveMic(null);
      setInterimText('');
    } else {
      // Bắt đầu nghe - dừng phiên cũ nếu có
      if (activeMic && sttSourceRef.current) sttSourceRef.current.abort();
      if (sttSourceRef.current) sttSourceRef.current.start();
      setActiveMic(panel);
    }
  };



  const swapLangs = () => {
    setSrcIdx(tgtIdx);
    setTgtIdx(srcIdx);

    // Đảo ngược luôn nội dung của 2 khung
    setSourceBlocks(targetBlocks);
    setTargetBlocks(sourceBlocks);

    // Dừng đọc âm thanh hiện tại để tránh đọc lộn ngôn ngữ
    if (ttsAbortRef.current) ttsAbortRef.current.abort();
  };

  if (!mounted || !authChecked) return null;

  if (!sessionUser) {
    return (
      <div className="app">
        <div className="bg-orb bg-orb-1" />
        <div className="bg-orb bg-orb-2" />
        <div className="bg-orb bg-orb-3" />
        <LoginForm onLogin={handleLogin} />
      </div>
    );
  }

  // =============== CONVERSATION MODE ===============
  const conversationView = (
    <ConversationPanel
      apiKey={apiKey}
      engine={engine}
      srcLang={srcLang}
      tgtLang={tgtLang}
      speak={speak}
      findSttCode={findSttCode}
      LANGUAGES={LANGUAGES}
      history={convHistory}
      setHistory={setConvHistory}
      sessionUser={sessionUser}
    />
  );

  return (
    <div className="app">
      <div className="bg-orb bg-orb-1" />
      <div className="bg-orb bg-orb-2" />
      <div className="bg-orb bg-orb-3" />
      <div className={`container ${viewMode === 'conversation' ? 'container-conv' : ''}`}>
        <div style={{ display: 'flex', justifyContent: 'center', padding: isHeaderHidden ? '0 0 10px' : '0 0 5px' }}>
          <button 
             onClick={() => setIsHeaderHidden(!isHeaderHidden)}
             title={isHeaderHidden ? "Hiện thanh Menu" : "Ẩn Menu để tối đa không gian"}
             style={{ background: isHeaderHidden ? 'var(--card)' : 'transparent', border: isHeaderHidden ? '1px solid var(--border)' : 'none', borderRadius: '12px', padding: '2px 16px', fontSize: '13px', cursor: 'pointer', color: 'var(--text2)', boxShadow: isHeaderHidden ? '0 2px 6px rgba(0,0,0,0.06)' : 'none', transition: 'all 0.2s', zIndex: 10 }}>
             {isHeaderHidden ? '🔽 Hiện thanh Menu' : '🔼 Ẩn thanh Menu'}
          </button>
        </div>
        
        {!isHeaderHidden && (
          <>
            <header className="header">
          <div className="logo">
            <span className="logo-icon">🎙</span>
            <h1>VoiceTranslate <sup className="badge">AI</sup></h1>
          </div>
          <div className="mode-switcher">
            <button className={viewMode === 'standard' ? 'active' : ''} onClick={() => setViewMode('standard')}>📋 Dịch thuật</button>
            <button className={viewMode === 'conversation' ? 'active' : ''} onClick={() => setViewMode('conversation')}>💬 Giao tiếp</button>
          </div>
          <div style={{ display: 'flex', gap: '10px', alignItems: 'center' }}>
            {sessionUser && (
              <div
                title={`Đơn vị: ${sessionUser.unit}\nVai trò: ${sessionUser.role}`}
                style={{ display: 'flex', alignItems: 'center', gap: '8px', background: 'rgba(255,255,255,0.05)', padding: '5px 12px', borderRadius: '99px', fontSize: '13px', fontWeight: '500', border: '1px solid rgba(255,255,255,0.1)' }}>

                {/* HIỂN THỊ NÚT VÀO DASHBOARD NẾU LÀ ADMIN */}
                {sessionUser.role === 'admin' && (
                  <button onClick={() => window.location.href = '/admin'} style={{ background: '#d97706', color: '#fff', border: 'none', padding: '4px 10px', borderRadius: '20px', cursor: 'pointer', fontSize: '12px', marginRight: '5px', fontWeight: 'bold' }}>
                    🛡️ Quản trị
                  </button>
                )}

                {/* NÚT XEM LỊCH SỬ */}
                <button onClick={() => window.location.href = '/history'} style={{ background: 'rgba(14,165,233,0.15)', color: '#0ea5e9', border: '1px solid rgba(14,165,233,0.3)', padding: '4px 10px', borderRadius: '20px', cursor: 'pointer', fontSize: '12px', marginRight: '5px', fontWeight: 'bold' }}>
                  📋 Lịch sử
                </button>

                <img src={sessionUser.avatar} alt="avatar" style={{ width: '26px', height: '26px', borderRadius: '50%' }} />
                <span>{sessionUser.name}</span>
                <button onClick={() => setShowChangePw(true)} style={{ background: 'none', border: 'none', color: 'var(--text2)', cursor: 'pointer', marginLeft: '2px', fontSize: '14px', display: 'flex', alignItems: 'center' }} title="Đổi mật khẩu">🔑</button>
                <button onClick={handleLogout} style={{ background: 'none', border: 'none', color: 'var(--danger)', cursor: 'pointer', marginLeft: '2px', fontSize: '14px', display: 'flex', alignItems: 'center' }} title="Đăng xuất">🚪</button>
              </div>
            )}
            <button className="settings-btn" onClick={() => setShowSettings(!showSettings)}>⚙️</button>
          </div>
        </header>

        {showSettings && (
          <div className="settings-panel">
            <div className="setting-row">
              <label>🔑 API Key</label>
              <input type="password" value={apiKey} onChange={(e) => setApiKey(e.target.value)} placeholder="Để trống nếu dùng env var" />
            </div>
            <div className="setting-row">
              <label>🤖 Engine</label>
              <select value={engine} onChange={(e) => setEngine(e.target.value)}>
                <option value="openai">OpenAI GPT-4o-mini</option>
                <option value="deepseek">DeepSeek</option>
              </select>
            </div>
            <div className="setting-row">
              <label>{srcLang.flag} Nguồn</label>
              <select value={srcIdx} onChange={(e) => setSrcIdx(Number(e.target.value))}>
                {LANGUAGES.map((l, i) => <option key={i} value={i}>{l.flag} {l.name}</option>)}
              </select>
            </div>
            <div className="setting-row">
              <label>{tgtLang.flag} Đích</label>
              <select value={tgtIdx} onChange={(e) => setTgtIdx(Number(e.target.value))}>
                {LANGUAGES.map((l, i) => <option key={i} value={i}>{l.flag} {l.name}</option>)}
              </select>
            </div>
          </div>
        )}
          </>
        )}

        {viewMode === 'conversation' ? conversationView : (
          <>
            <div className="lang-bar">
              <span className="lang-chip"><span className="flag">{srcLang.flag}</span>{srcLang.name}</span>
              <button className="swap-btn" onClick={swapLangs}>⇄</button>
              <span className="lang-chip"><span className="flag">{tgtLang.flag}</span>{tgtLang.name}</span>
            </div>

            <div className="panels">
              <div className="panel panel-source">
                <div className="panel-header">
                  <span>{srcLang.flag} {srcLang.name}</span>
                  <div className="panel-actions">
                    <button onClick={() => setSourceBlocks([])} title="Xóa">🗑️</button>
                  </div>
                </div>
                <div className="panel-body" ref={sourceRef}>
                  {sourceBlocks.length === 0 && !interimText && <div className="placeholder">Nhấn micro và nói...</div>}
                  {sourceBlocks.map((b) => (
                    <div key={b.id} className="sentence" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: '10px' }}>
                      <span>{b.text}</span>
                      <button onClick={() => speak(b.text, srcLang.ttsCode, b.id)} style={{ background: 'none', border: 'none', cursor: 'pointer', fontSize: '18px', opacity: 0.7 }} title={playingId === b.id ? 'Dừng' : 'Nghe lại'}>{playingId === b.id ? '🔇' : '🔊'}</button>
                    </div>
                  ))}
                  {interimText && activeMic === 'source' && <div className="sentence interim">{interimText}</div>}
                </div>
                <div className="panel-footer">
                  <button className={`mic-btn ${activeMic === 'source' ? 'recording' : ''}`} onClick={() => toggleMic('source')}>
                    <span className="mic-icon">{activeMic === 'source' ? '⏹' : '🎤'}</span>
                    {activeMic === 'source' ? 'Dừng' : 'Nói'}
                  </button>
                  {activeMic === 'source' && <span className="timer">{formatTime(sttSource.elapsed)}</span>}
                  {isTranslating && <span className="translating-badge">⏳ Đang dịch...</span>}
                </div>
              </div>

              <div className="arrow-divider">→</div>

              <div className="panel panel-target">
                <div className="panel-header">
                  <span>{tgtLang.flag} {tgtLang.name}</span>
                  <div className="panel-actions">
                    <button onClick={() => setTargetBlocks([])} title="Xóa">🗑️</button>
                  </div>
                </div>
                <div className="panel-body" ref={targetRef}>
                  {targetBlocks.length === 0 && <div className="placeholder">Bản dịch sẽ hiện tại đây...</div>}
                  {targetBlocks.map((b) => (
                    <div key={b.id} className="sentence" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: '10px' }}>
                      <span>{b.text}</span>
                      <button onClick={() => speak(b.text, tgtLang.ttsCode, b.id)} style={{ background: 'none', border: 'none', cursor: 'pointer', fontSize: '18px', opacity: 0.7 }} title={playingId === b.id ? 'Dừng' : 'Nghe lại'}>{playingId === b.id ? '🔇' : '🔊'}</button>
                    </div>
                  ))}
                </div>
              </div>
            </div>

            {history.length > 0 && (
              <div className="history">
                <div className="history-header">
                  <h2>📜 Lịch sử</h2>
                  <button onClick={() => setHistory([])}>Xóa</button>
                </div>
                <div className="history-list">
                  {history.slice(0, 10).map((h) => (
                    <div key={h.id} className="history-item">
                      <span className="hi-source">{h.source}</span>
                      <span className="hi-arrow">→</span>
                      <span className="hi-target">{h.target}</span>
                      <span className="hi-time">{h.time}</span>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </>
        )}

        {viewMode !== 'conversation' && <footer className="footer"> Ứng dụng dịch thuật thông minh </footer>}
      </div>

      {toast && <div className="toast">{toast}</div>}
      {showChangePw && <ChangePasswordModal user={sessionUser} onClose={() => setShowChangePw(false)} />}
    </div>
  );
}
