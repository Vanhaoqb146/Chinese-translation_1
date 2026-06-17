"use client";
import { useState, useRef, useCallback, useEffect } from "react";
import useSimultaneousConversation from "@/hooks/useSimultaneousConversation";

// Voice options per language — Azure AI Speech (sorted best quality first)
const VOICE_OPTIONS_AZURE = {
  vi: [
    { id: "vi-VN-HoaiMyNeural", label: "⭐ Nữ miền Bắc (HoaiMy)" },
    { id: "vi-VN-NamMinhNeural", label: "⭐ Nam miền Bắc (NamMinh)" },
    { id: "vi-VN-ThuDuongNeural", label: "Nữ miền Nam (ThuDuong)" },
    { id: "vi-VN-QuangNeural", label: "Nam miền Nam (Quang)" },
  ],
  zh: [
    {
      id: "zh-CN-XiaoxiaoMultilingualNeural",
      label: "⭐ Nữ Đa ngữ (Xiaoxiao)",
    },
    { id: "zh-CN-YunyiMultilingualNeural", label: "⭐ Nam Đa ngữ (Yunyi)" },
    { id: "zh-CN-XiaoxiaoNeural", label: "Nữ Phổ thông (Xiaoxiao)" },
    { id: "zh-CN-YunjianNeural", label: "Nam Phổ thông (Yunjian)" },
    { id: "zh-CN-XiaochenNeural", label: "Nữ Tự nhiên (Xiaochen)" },
    { id: "zh-CN-YunxiNeural", label: "Nam Thanh niên (Yunxi)" },
    { id: "zh-CN-XiaoyiNeural", label: "Nữ Thanh niên (Xiaoyi)" },
    { id: "zh-CN-YunyangNeural", label: "Nam MC tin tức (Yunyang)" },
    { id: "zh-CN-XiaochenMultilingualNeural", label: "Nữ Đa ngữ (Xiaochen)" },
    { id: "zh-CN-liaoning-XiaobeiNeural", label: "Nữ Đông Bắc" },
    { id: "zh-CN-shaanxi-XiaoniNeural", label: "Nữ Thiểm Tây" },
    { id: "zh-HK-HiuGaaiNeural", label: "Nữ Quảng Đông" },
    { id: "zh-HK-WanLungNeural", label: "Nam Quảng Đông" },
    { id: "zh-TW-HsiaoChenNeural", label: "Nữ Đài Loan" },
    { id: "zh-TW-YunJheNeural", label: "Nam Đài Loan" },
  ],
  en: [
    { id: "en-US-JennyMultilingualNeural", label: "⭐ Nữ Đa ngữ (Jenny)" },
    { id: "en-US-RyanMultilingualNeural", label: "⭐ Nam Đa ngữ (Ryan)" },
    { id: "en-US-AriaNeural", label: "Nữ Aria" },
    { id: "en-US-GuyNeural", label: "Nam Guy" },
    { id: "en-US-BrianNeural", label: "Nam Brian" },
  ],
  ja: [
    { id: "ja-JP-NanamiNeural", label: "Nữ Nhật (Nanami)" },
    { id: "ja-JP-KeitaNeural", label: "Nam Nhật (Keita)" },
  ],
  ko: [
    { id: "ko-KR-SunHiNeural", label: "Nữ Hàn (SunHi)" },
    { id: "ko-KR-InJoonNeural", label: "Nam Hàn (InJoon)" },
  ],
};

// Voice options — ElevenLabs (eleven_multilingual_v2 — all voices speak all languages)
const VOICE_OPTIONS_ELEVENLABS = [
  { id: "pFZP5JQG7iQjIQuC4Bku", label: "⭐ Lily (Nữ, ấm áp)" },
  { id: "21m00Tcm4TlvDq8ikWAM", label: "⭐ Rachel (Nữ, chuyên nghiệp)" },
  { id: "EXAVITQu4vr4xnSDxMaL", label: "Sarah (Nữ, nhẹ nhàng)" },
  { id: "nPczCjzI2devNBz1zQrb", label: "Brian (Nam, trầm)" },
  { id: "onwK4e9ZLuTAKqWW03F9", label: "Daniel (Nam, mạnh mẽ)" },
  { id: "cgSgspJ2msm6clMCkdW9", label: "Jessica (Nữ, vui vẻ)" },
  { id: "iP95p4xoKVk53GoZ742B", label: "Chris (Nam, thân thiện)" },
  { id: "XrExE9yKIg1WjnnlVkGX", label: "Matilda (Nữ, từ tốn)" },
];

export default function SimultaneousPanel({
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
    if (typeof window !== "undefined") {
      try {
        const saved = sessionStorage.getItem(`vt_setting_sim_${key}`);
        if (saved !== null) return JSON.parse(saved);
      } catch {
        /* ignore */
      }
    }
    return defaultValue;
  };

  const [convStatus, setConvStatus] = useState("idle");
  const [interimText, setInterimText] = useState("");

  // Settings optimized specifically for Simultaneous Mode (e.g. shorter silence timer: 3s, minimum 2s)
  const [silenceSeconds, setSilenceSeconds] = useState(() =>
    Math.max(2, getSessionValue("silenceSeconds", 3)),
  );
  const [provider, setProvider] = useState(() =>
    getSessionValue("provider", "azure"),
  );
  const [ttsProvider, setTtsProvider] = useState(() =>
    getSessionValue("ttsProvider", "azure"),
  );
  const [speed, setSpeed] = useState(() => getSessionValue("speed", 1.0));
  const [srcVoice, setSrcVoice] = useState(() =>
    getSessionValue(
      "srcVoice",
      VOICE_OPTIONS_AZURE[srcLang.translateCode]?.[0]?.id || "",
    ),
  );
  const [tgtVoice, setTgtVoice] = useState(() =>
    getSessionValue(
      "tgtVoice",
      VOICE_OPTIONS_AZURE[tgtLang.translateCode]?.[0]?.id || "",
    ),
  );
  const [autoDetect, setAutoDetect] = useState(() =>
    getSessionValue("autoDetect", false),
  );
  const [micMode, setMicMode] = useState(() =>
    getSessionValue("micMode", "continuous"),
  );
  const [autoTTS, setAutoTTS] = useState(() =>
    getSessionValue("autoTTS", true),
  );
  const [overlapListening, setOverlapListening] = useState(() =>
    getSessionValue("overlapListening", false),
  );
  const [useHeadphones, setUseHeadphones] = useState(() =>
    getSessionValue("useHeadphones", true),
  );


  // Enforce: autoDetect is ONLY compatible with 'azure' provider.
  useEffect(() => {
    if (provider !== 'azure' && autoDetect) {
      setAutoDetect(false);
    }
  }, [provider, autoDetect]);

  // ===== activeTtsProvider =====
  const activeTtsProvider = provider === "web-speech" ? ttsProvider : provider;

  // Drawer menu state
  const [drawerOpen, setDrawerOpen] = useState(false);

  // Font size state
  const [fontSize, setFontSize] = useState(() =>
    getSessionValue("fontSize", 17),
  );

  // Mute/Unmute per language
  const [muteSrc, setMuteSrc] = useState(() =>
    getSessionValue("muteSrc", false),
  );
  const [muteTgt, setMuteTgt] = useState(() =>
    getSessionValue("muteTgt", false),
  );

  // Sync settings to sessionStorage with `sim_` prefix
  useEffect(() => {
    try {
      sessionStorage.setItem(
        "vt_setting_sim_provider",
        JSON.stringify(provider),
      );
      sessionStorage.setItem(
        "vt_setting_sim_ttsProvider",
        JSON.stringify(ttsProvider),
      );
      sessionStorage.setItem("vt_setting_sim_speed", JSON.stringify(speed));
      sessionStorage.setItem(
        "vt_setting_sim_silenceSeconds",
        JSON.stringify(silenceSeconds),
      );
      sessionStorage.setItem(
        "vt_setting_sim_srcVoice",
        JSON.stringify(srcVoice),
      );
      sessionStorage.setItem(
        "vt_setting_sim_tgtVoice",
        JSON.stringify(tgtVoice),
      );
      sessionStorage.setItem(
        "vt_setting_sim_autoDetect",
        JSON.stringify(autoDetect),
      );
      sessionStorage.setItem("vt_setting_sim_micMode", JSON.stringify(micMode));
      sessionStorage.setItem("vt_setting_sim_autoTTS", JSON.stringify(autoTTS));
      sessionStorage.setItem(
        "vt_setting_sim_fontSize",
        JSON.stringify(fontSize),
      );
      sessionStorage.setItem("vt_setting_sim_muteSrc", JSON.stringify(muteSrc));
      sessionStorage.setItem("vt_setting_sim_muteTgt", JSON.stringify(muteTgt));
      sessionStorage.setItem(
        "vt_setting_sim_overlapListening",
        JSON.stringify(overlapListening),
      );
      sessionStorage.setItem(
        "vt_setting_sim_useHeadphones",
        JSON.stringify(useHeadphones),
      );
    } catch {
      /* ignore */
    }
  }, [
    provider,
    ttsProvider,
    speed,
    silenceSeconds,
    srcVoice,
    tgtVoice,
    autoDetect,
    micMode,
    autoTTS,
    fontSize,
    muteSrc,
    muteTgt,
    overlapListening,
    useHeadphones,
  ]);

  // Auto reset voices when activeTtsProvider changes
  useEffect(() => {
    if (activeTtsProvider === "elevenlabs") {
      setSrcVoice(VOICE_OPTIONS_ELEVENLABS[0]?.id || "");
      setTgtVoice(VOICE_OPTIONS_ELEVENLABS[0]?.id || "");
    } else {
      setSrcVoice(VOICE_OPTIONS_AZURE[srcLang.translateCode]?.[0]?.id || "");
      setTgtVoice(VOICE_OPTIONS_AZURE[tgtLang.translateCode]?.[0]?.id || "");
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeTtsProvider]);

  const muteSrcRef = useRef(false);
  const muteTgtRef = useRef(false);
  useEffect(() => {
    muteSrcRef.current = muteSrc;
  }, [muteSrc]);
  useEffect(() => {
    muteTgtRef.current = muteTgt;
  }, [muteTgt]);

  const logBodyRef = useRef(null);
  const replayAudioRef = useRef(null);
  const [replayingId, setReplayingId] = useState(null);

  const autoScrollToBottom = useCallback(() => {
    setTimeout(() => {
      if (logBodyRef.current) {
        logBodyRef.current.scrollTo({
          top: logBodyRef.current.scrollHeight,
          behavior: "smooth",
        });
      }
    }, 60);
  }, []);

  const handleInterimText = useCallback(
    (text) => {
      setInterimText(text);
      autoScrollToBottom();
    },
    [autoScrollToBottom],
  );

  const handleFinalResult = useCallback(
    ({ originalText, translatedText, fromLang, toLang, id }) => {
      setHistory((prev) =>
        [
          {
            source: originalText,
            target: translatedText,
            fromLang,
            toLang,
            time: new Date().toLocaleTimeString("vi-VN", {
              hour: "2-digit",
              minute: "2-digit",
              second: "2-digit",
            }),
            id,
          },
          ...prev,
        ].slice(0, 100),
      );
      setInterimText("");
      autoScrollToBottom();

      // Log to PostgreSQL history API
      if (sessionUser?.username) {
        fetch("/api/history", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            userId: sessionUser.username,
            source: originalText,
            target: translatedText,
            fromLang,
            toLang,
          }),
        }).catch((err) => console.warn("⚠️ Log history failed:", err));
      }
    },
    [setHistory, sessionUser?.username, autoScrollToBottom],
  );

  const handleStatusChange = useCallback((status) => setConvStatus(status), []);
  const handleError = useCallback((msg) => {
    setConvStatus("idle");
    console.warn("Simultaneous Conversation Error:", msg);
  }, []);

  const srcVoiceRef = useRef(srcVoice);
  const tgtVoiceRef = useRef(tgtVoice);
  srcVoiceRef.current = srcVoice;
  tgtVoiceRef.current = tgtVoice;

  const getVoiceForLang = useCallback(
    (toLang) => {
      if (toLang === srcLang.translateCode && muteSrcRef.current)
        return "__MUTED__";
      if (toLang === tgtLang.translateCode && muteTgtRef.current)
        return "__MUTED__";
      if (toLang === srcLang.translateCode) return srcVoiceRef.current;
      if (toLang === tgtLang.translateCode) return tgtVoiceRef.current;
      return null;
    },
    [srcLang.translateCode, tgtLang.translateCode],
  );

  // Hook dedicated to simultaneous non-blocking queue
  const conv = useSimultaneousConversation({
    srcLangCode: srcLang.translateCode,
    tgtLangCode: tgtLang.translateCode,
    engine: model,
    silenceMs: silenceSeconds * 1000,
    autoDetect,
    micMode,
    autoTTS,
    provider,
    ttsProvider,
    overlapListening,
    useHeadphones,
    speed,
    echoCancellationAI: overlapListening,
    onInterimText: handleInterimText,
    onFinalResult: handleFinalResult,
    onStatusChange: handleStatusChange,
    onError: handleError,
    getVoiceForLang,
  });

  const stopReplay = useCallback(() => {
    if (replayAudioRef.current) {
      try {
        replayAudioRef.current.pause();
        replayAudioRef.current.currentTime = 0;
      } catch (e) {
        /* ignore */
      }
      replayAudioRef.current = null;
    }
    setReplayingId(null);
  }, []);

  const handleReplay = useCallback(
    async (text, langCode, msgId) => {
      if (replayingId === msgId) {
        stopReplay();
        return;
      }
      stopReplay();
      setReplayingId(msgId);
      try {
        const baseLang = langCode.split("-")[0].toLowerCase();
        const voice =
          srcVoice && langCode.includes(srcLang.translateCode)
            ? srcVoice
            : tgtVoice && langCode.includes(tgtLang.translateCode)
              ? tgtVoice
              : null;
        const res = await fetch("/api/tts", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            text,
            lang: baseLang,
            voice,
            provider: activeTtsProvider,
          }),
        });
        if (!res.ok) {
          setReplayingId(null);
          return;
        }
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
          console.warn("⚠️ Gán playbackRate lỗi:", e);
        }

        audio.onended = () => {
          URL.revokeObjectURL(url);
          replayAudioRef.current = null;
          setReplayingId(null);
        };
        audio.onerror = () => {
          URL.revokeObjectURL(url);
          replayAudioRef.current = null;
          setReplayingId(null);
        };
        audio.play().catch(() => {
          setReplayingId(null);
        });
      } catch (err) {
        console.warn("Replay error:", err);
        setReplayingId(null);
      }
    },
    [
      replayingId,
      stopReplay,
      srcVoice,
      tgtVoice,
      srcLang.translateCode,
      tgtLang.translateCode,
      activeTtsProvider,
      speed,
    ],
  );

  const handleStartLang = useCallback(
    (lang) => {
      stopReplay();
      if (conv.isListening) {
        conv.stop();
      } else {
        conv.start(lang);
      }
    },
    [conv, stopReplay],
  );

  // Hold mode event handlers
  const holdStartTimeRef = useRef(0);
  const handleHoldStart = useCallback(
    (lang, e) => {
      const busy = convStatus === "connecting";
      if (busy || conv.isListening) return;
      if (replayAudioRef.current) {
        try {
          replayAudioRef.current.pause();
          replayAudioRef.current.currentTime = 0;
        } catch (e) {
          /* ignore */
        }
        replayAudioRef.current = null;
      }
      holdStartTimeRef.current = Date.now();
      if (e?.currentTarget?.setPointerCapture && e?.pointerId != null) {
        try {
          e.currentTarget.setPointerCapture(e.pointerId);
        } catch (err) {
          /* ignore */
        }
      }
      conv.start(lang);
      setTimeout(() => setReplayingId(null), 0);
    },
    [conv, convStatus],
  );

  const handleHoldEnd = useCallback(() => {
    if (!conv.isListening) return;
    conv.stopHold();
  }, [conv]);

  const handleStopSpeaking = useCallback(() => {
    conv.stopSpeaking();
  }, [conv]);

  const handleClearHistory = useCallback(() => {
    setHistory([]);
    setInterimText("");
  }, [setHistory]);

  const formatTime = (s) => {
    const m = Math.floor(s / 60);
    const sec = s % 60;
    return `${String(m).padStart(2, "0")}:${String(sec).padStart(2, "0")}`;
  };

  const getFlagForLang = (langCode) => {
    const lang = LANGUAGES.find((l) => l.translateCode === langCode);
    return lang ? lang.flag : "🌐";
  };

  const isBusy = convStatus === "connecting";
  const isHoldMode = micMode === "hold";

  const holdProps = (lang) => ({
    onPointerDown: (e) => {
      e.preventDefault();
      handleHoldStart(lang, e);
    },
    onPointerUp: (e) => {
      e.preventDefault();
      handleHoldEnd();
    },
    onPointerCancel: (e) => {
      e.preventDefault();
      handleHoldEnd();
    },
    onContextMenu: (e) => e.preventDefault(),
    style: { touchAction: "none" },
  });

  return (
    <div className="conv-auto">
      {/* ============ HEADER BAR ============ */}
      <div
        className="conv-header-bar"
        style={{
          background:
            "linear-gradient(90deg, rgba(14,165,233,0.1) 0%, rgba(139,92,246,0.1) 100%)",
          borderBottom: "1px solid rgba(14,165,233,0.2)",
        }}
      >
        {/* Left: Speaker controls */}
        <div className="conv-header-left">
          <button
            className={`speaker-btn ${muteSrc ? "muted" : ""}`}
            onClick={() => setMuteSrc(!muteSrc)}
            title={
              muteSrc ? `Bật loa ${srcLang.name}` : `Tắt loa ${srcLang.name}`
            }
          >
            <span className="speaker-flag">{srcLang.flag}</span>
            <span className="speaker-icon">{muteSrc ? "🔇" : "🔊"}</span>
          </button>
          <button
            className={`speaker-btn ${muteTgt ? "muted" : ""}`}
            onClick={() => setMuteTgt(!muteTgt)}
            title={
              muteTgt ? `Bật loa ${tgtLang.name}` : `Tắt loa ${tgtLang.name}`
            }
          >
            <span className="speaker-flag">{tgtLang.flag}</span>
            <span className="speaker-icon">{muteTgt ? "🔇" : "🔊"}</span>
          </button>
        </div>

        {/* Center: Title + Queue length pill */}
        <div
          className="conv-header-center"
          style={{
            display: "flex",
            flexDirection: "column",
            alignItems: "center",
            gap: "2px",
          }}
        >
          <span
            style={{
              fontSize: "13px",
              fontWeight: 700,
              color: "#0ea5e9",
              letterSpacing: "0.5px",
            }}
          >
            🎙️ GIAO TIẾP SONG SONG
          </span>
          {conv.queueLength > 0 && (
            <span
              style={{
                fontSize: "10px",
                fontWeight: "bold",
                background: "rgba(234,179,8,0.15)",
                color: "#fbbf24",
                border: "1px solid rgba(234,179,8,0.3)",
                padding: "1px 8px",
                borderRadius: "10px",
                animation: "pulse 1.5s infinite",
              }}
            >
              ⚡ Đang xử lý: {conv.queueLength} đoạn...
            </span>
          )}
        </div>

        {/* Right: Reset + Drawer Hamburger */}
        <div className="conv-header-right">
          <button
            className="hamburger-btn"
            onClick={() => handleClearHistory()}
            title="Xóa hội thoại"
            style={{ fontSize: "14px" }}
          >
            🗑️
          </button>
          <button
            className="hamburger-btn"
            onClick={() => setDrawerOpen(true)}
            title="Cài đặt"
          >
            ☰
          </button>
        </div>
      </div>

      {/* ============ CHAT SCREEN LOG ============ */}
      <div className="conv-log fullscreen-chat">
        <div className="conv-log-body" ref={logBodyRef}>
          {history.length === 0 && !interimText && (
            <div className="conv-empty">
              <div
                className="conv-empty-icon"
                style={{
                  textShadow: "0 0 15px rgba(14,165,233,0.4)",
                  color: "#0ea5e9",
                }}
              >
                🎙️
              </div>
              <div style={{ fontWeight: "bold", color: "var(--text1)" }}>
                Chế độ Giao tiếp song song (Simultaneous)
              </div>
              <div
                className="conv-empty-sub"
                style={{
                  maxWidth: "300px",
                  margin: "8px auto",
                  fontSize: "12px",
                  lineHeight: "1.5",
                }}
              >
                Hệ thống thu âm liên tục không dừng. Khi bạn im lặng, câu nói sẽ
                tự động chuyển dịch tuần tự trên màn hình mà không ngắt mic!
              </div>
              <div
                style={{
                  marginTop: "12px",
                  display: "flex",
                  justifyContent: "center",
                }}
              >
                <span
                  style={{
                    fontSize: "11px",
                    background: "rgba(255,255,255,0.05)",
                    border: "1px solid rgba(255,255,255,0.1)",
                    padding: "4px 12px",
                    borderRadius: "8px",
                    color: "var(--text3)",
                  }}
                >
                  {!autoTTS
                    ? "💡 Đã tắt giọng đọc - Micro mở 100% không rú âm!"
                    : "💡 Đeo tai nghe nếu sử dụng chế độ Nghe đè!"}
                </span>
              </div>
            </div>
          )}

          {history
            .slice()
            .reverse()
            .map((h, index) => {
              const isSource = h.fromLang === srcLang.translateCode;
              const alignment = isSource ? "align-right" : "align-left";

              return (
                <div
                  key={`sim-${h.id}-${index}`}
                  className={`chat-bubble-group ${alignment}`}
                >
                  {/* Source utterance */}
                  <div
                    className="chat-bubble bubble-original"
                    style={{
                      fontSize: `${fontSize}px`,
                      borderLeft: isSource ? "none" : "3px solid #8b5cf6",
                    }}
                  >
                    <span className="chat-bubble-flag">
                      {getFlagForLang(h.fromLang)}
                    </span>
                    <span className="chat-bubble-text">{h.source}</span>
                    <button
                      className="chat-bubble-speaker"
                      onClick={() =>
                        handleReplay(
                          h.source,
                          findSttCode(h.fromLang),
                          `src-${h.id}`,
                        )
                      }
                      title={
                        replayingId === `src-${h.id}` ? "Dừng" : "Nghe câu gốc"
                      }
                    >
                      {replayingId === `src-${h.id}` ? "🔇" : "🔊"}
                    </button>
                  </div>

                  {/* Target translation */}
                  <div
                    className="chat-bubble bubble-translated"
                    style={{
                      fontSize: `${fontSize}px`,
                      borderLeft: isSource ? "3px solid #0ea5e9" : "none",
                    }}
                  >
                    <span className="chat-bubble-flag">
                      {getFlagForLang(h.toLang)}
                    </span>
                    <span className="chat-bubble-text">{h.target}</span>
                    <button
                      className="chat-bubble-speaker"
                      onClick={() =>
                        handleReplay(
                          h.target,
                          findSttCode(h.toLang),
                          `tgt-${h.id}`,
                        )
                      }
                      title={
                        replayingId === `tgt-${h.id}` ? "Dừng" : "Nghe bản dịch"
                      }
                      style={{ color: "rgba(255,255,255,0.8)" }}
                    >
                      {replayingId === `tgt-${h.id}` ? "🔇" : "🔊"}
                    </button>
                  </div>

                  <span className="chat-bubble-time">{h.time}</span>
                </div>
              );
            })}

          {/* Interim text stream preview */}
          {interimText && (
            <div
              className="chat-bubble-interim"
              style={{ fontSize: `${fontSize}px` }}
            >
              <div
                className="chat-bubble-interim-text"
                style={{
                  borderLeft: "3px solid rgba(14,165,233,0.5)",
                  background: "rgba(14,165,233,0.05)",
                }}
              >
                <span
                  style={{ fontSize: "12px", opacity: 0.6, marginRight: 6 }}
                >
                  {conv.activeLang ? getFlagForLang(conv.activeLang) : "🎤"}
                </span>
                {interimText}
                <span className="chat-bubble-interim-cursor" />
              </div>
            </div>
          )}
        </div>
      </div>

      {/* ============ FLOATING BOTTOM FAB MICS ============ */}
      <div className="fab-mic-container" style={{ paddingBottom: "20px" }}>
        {autoDetect ? (
          <>
            <div className="fab-mic-group">
              <button
                className={`fab-mic-btn ${conv.isListening ? "recording" : ""}`}
                disabled={isBusy}
                onClick={() => handleStartLang(srcLang.translateCode)}
                style={{
                  background: conv.isListening
                    ? "linear-gradient(135deg, #ef4444 0%, #dc2626 100%)"
                    : "linear-gradient(135deg, #0ea5e9 0%, #8b5cf6 100%)",
                  boxShadow: conv.isListening
                    ? "0 0 20px rgba(239,68,68,0.5)"
                    : "0 0 20px rgba(14,165,233,0.3)",
                }}
              >
                <span className="fab-mic-btn-icon" style={{ fontSize: "24px" }}>
                  {convStatus === "speaking"
                    ? overlapListening
                      ? "⏹"
                      : "🔊"
                    : convStatus === "translating"
                      ? "⏳"
                      : conv.isListening
                        ? "⏹"
                        : "🎤"}
                </span>
                {conv.isListening &&
                  (convStatus === "listening" ||
                    (convStatus === "speaking" && overlapListening)) && (
                    <span
                      className="pulse-ring"
                      style={{ borderColor: "#ef4444" }}
                    />
                  )}
                {conv.isListening &&
                  (convStatus === "listening" ||
                    (convStatus === "speaking" && overlapListening)) && (
                    <span
                      className="pulse-ring p2"
                      style={{ borderColor: "#ef4444" }}
                    />
                  )}
              </button>
              <div className="fab-mic-label" style={{ fontWeight: "bold" }}>
                {conv.activeLang ? getFlagForLang(conv.activeLang) : "🌐"} Live
                Auto
              </div>
            </div>

            <div className="fab-status">
              <span
                className="fab-status-text"
                style={{ fontSize: "13px", fontWeight: "bold" }}
              >
                {convStatus === "idle" && "🎙 Bấm để bắt đầu Dịch đuổi"}
                {convStatus === "connecting" && "⏳ Kết nối mic..."}
                {convStatus === "listening" && "🟢 Micro mở liên tục..."}
                {convStatus === "translating" && "⏳ Đang giao tiếp song song..."}
                {convStatus === "speaking" &&
                  (overlapListening ? (
                    <div
                      style={{
                        display: "flex",
                        alignItems: "center",
                        gap: "8px",
                        justifyContent: "center",
                      }}
                    >
                      <span
                        style={{
                          display: "flex",
                          alignItems: "center",
                          gap: "4px",
                        }}
                      >
                        <span
                          className="pulse-dot"
                          style={{
                            width: "8px",
                            height: "8px",
                            background: "#10b981",
                            borderRadius: "50%",
                            display: "inline-block",
                            animation: "pulse 1s infinite",
                          }}
                        />
                        <span>🟢 Micro mở (Nghe đè)...</span>
                      </span>
                      <button
                        className="fab-stop-speaking-btn"
                        onClick={handleStopSpeaking}
                        style={{ marginLeft: "4px" }}
                      >
                        🔇 Tắt phát âm
                      </button>
                    </div>
                  ) : (
                    <button
                      className="fab-stop-speaking-btn"
                      onClick={handleStopSpeaking}
                    >
                      🔇 Tắt phát âm
                    </button>
                  ))}
              </span>
              {conv.isListening && (
                <span className="fab-timer">{formatTime(conv.elapsed)}</span>
              )}
            </div>
          </>
        ) : (
          <>
            {/* Source language mic */}
            <div className="fab-mic-group">
              <button
                className={`fab-mic-btn ${conv.activeLang === srcLang.translateCode ? "recording" : ""}`}
                disabled={
                  isBusy ||
                  (conv.isListening &&
                    conv.activeLang !== srcLang.translateCode)
                }
                {...(isHoldMode
                  ? holdProps(srcLang.translateCode)
                  : {
                      onClick: () => handleStartLang(srcLang.translateCode),
                    })}
                style={{
                  background:
                    conv.activeLang === srcLang.translateCode
                      ? "linear-gradient(135deg, #ef4444 0%, #dc2626 100%)"
                      : "linear-gradient(135deg, #2563eb 0%, #1d4ed8 100%)",
                  boxShadow:
                    conv.activeLang === srcLang.translateCode
                      ? "0 0 15px rgba(239,68,68,0.4)"
                      : "0 0 15px rgba(37,99,235,0.2)",
                }}
              >
                <span className="fab-mic-btn-icon">
                  {conv.activeLang === srcLang.translateCode &&
                  convStatus === "speaking"
                    ? overlapListening
                      ? "⏹"
                      : "🔊"
                    : conv.activeLang === srcLang.translateCode &&
                        convStatus === "translating"
                      ? "⏳"
                      : conv.activeLang === srcLang.translateCode
                        ? isHoldMode
                          ? "🎙"
                          : "⏹"
                        : "🎤"}
                </span>
                {conv.activeLang === srcLang.translateCode &&
                  (convStatus === "listening" ||
                    (convStatus === "speaking" && overlapListening)) && (
                    <span
                      className="pulse-ring"
                      style={{ borderColor: "#ef4444" }}
                    />
                  )}
                {conv.activeLang === srcLang.translateCode &&
                  (convStatus === "listening" ||
                    (convStatus === "speaking" && overlapListening)) && (
                    <span
                      className="pulse-ring p2"
                      style={{ borderColor: "#ef4444" }}
                    />
                  )}
              </button>
              <div className="fab-mic-label">
                {srcLang.flag} {srcLang.name}
              </div>
            </div>

            {/* Mid status display */}
            <div className="fab-status">
              <span className="fab-status-text">
                {convStatus === "idle" &&
                  (isHoldMode ? "👇 Nhấn giữ" : "👆 Chọn Mic để nói")}
                {convStatus === "connecting" && "⏳..."}
                {convStatus === "listening" && "🟢 Micro đang mở..."}
                {convStatus === "translating" && "⏳ Dịch..."}
                {convStatus === "speaking" &&
                  (overlapListening ? (
                    <div
                      style={{
                        display: "flex",
                        alignItems: "center",
                        gap: "8px",
                        justifyContent: "center",
                      }}
                    >
                      <span
                        style={{
                          display: "flex",
                          alignItems: "center",
                          gap: "4px",
                        }}
                      >
                        <span
                          className="pulse-dot"
                          style={{
                            width: "8px",
                            height: "8px",
                            background: "#10b981",
                            borderRadius: "50%",
                            display: "inline-block",
                            animation: "pulse 1s infinite",
                          }}
                        />
                        <span>🟢 Micro mở (Nghe đè)...</span>
                      </span>
                      <button
                        className="fab-stop-speaking-btn"
                        onClick={handleStopSpeaking}
                        style={{ marginLeft: "4px" }}
                      >
                        🔇 Tắt
                      </button>
                    </div>
                  ) : (
                    <button
                      className="fab-stop-speaking-btn"
                      onClick={handleStopSpeaking}
                    >
                      🔇 Tắt
                    </button>
                  ))}
              </span>
              {conv.isListening && (
                <span className="fab-timer">{formatTime(conv.elapsed)}</span>
              )}
            </div>

            {/* Target language mic */}
            <div className="fab-mic-group">
              <button
                className={`fab-mic-btn ${conv.activeLang === tgtLang.translateCode ? "recording" : ""}`}
                disabled={
                  isBusy ||
                  (conv.isListening &&
                    conv.activeLang !== tgtLang.translateCode)
                }
                {...(isHoldMode
                  ? holdProps(tgtLang.translateCode)
                  : {
                      onClick: () => handleStartLang(tgtLang.translateCode),
                    })}
                style={{
                  background:
                    conv.activeLang === tgtLang.translateCode
                      ? "linear-gradient(135deg, #ef4444 0%, #dc2626 100%)"
                      : "linear-gradient(135deg, #8b5cf6 0%, #7c3aed 100%)",
                  boxShadow:
                    conv.activeLang === tgtLang.translateCode
                      ? "0 0 15px rgba(239,68,68,0.4)"
                      : "0 0 15px rgba(139,92,246,0.2)",
                }}
              >
                <span className="fab-mic-btn-icon">
                  {conv.activeLang === tgtLang.translateCode &&
                  convStatus === "speaking"
                    ? overlapListening
                      ? "⏹"
                      : "🔊"
                    : conv.activeLang === tgtLang.translateCode &&
                        convStatus === "translating"
                      ? "⏳"
                      : conv.activeLang === tgtLang.translateCode
                        ? isHoldMode
                          ? "🎙"
                          : "⏹"
                        : "🎤"}
                </span>
                {conv.activeLang === tgtLang.translateCode &&
                  (convStatus === "listening" ||
                    (convStatus === "speaking" && overlapListening)) && (
                    <span
                      className="pulse-ring"
                      style={{ borderColor: "#ef4444" }}
                    />
                  )}
                {conv.activeLang === tgtLang.translateCode &&
                  (convStatus === "listening" ||
                    (convStatus === "speaking" && overlapListening)) && (
                    <span
                      className="pulse-ring p2"
                      style={{ borderColor: "#ef4444" }}
                    />
                  )}
              </button>
              <div className="fab-mic-label">
                {tgtLang.flag} {tgtLang.name}
              </div>
            </div>
          </>
        )}
      </div>

      {/* ============ DRAWER MENU (Settings) ============ */}
      {drawerOpen && (
        <>
          <div
            className="drawer-overlay"
            onClick={() => setDrawerOpen(false)}
          />
          <div className="drawer-content">
            <div className="drawer-header">
              <h3>⚙️ Thiết lập Giao tiếp song song</h3>
              <button
                className="drawer-close-btn"
                onClick={() => setDrawerOpen(false)}
              >
                ✕
              </button>
            </div>
            <div className="drawer-body">
              {/* Font size */}
              <div className="drawer-section">
                <div className="drawer-section-title">🔠 Cỡ chữ</div>
                <div className="font-size-slider-row">
                  <span style={{ fontSize: "12px", color: "var(--muted)" }}>
                    A
                  </span>
                  <input
                    type="range"
                    min={12}
                    max={28}
                    step={1}
                    value={fontSize}
                    onChange={(e) => setFontSize(Number(e.target.value))}
                  />
                  <span style={{ fontSize: "20px", color: "var(--muted)" }}>
                    A
                  </span>
                  <span className="font-size-value">{fontSize}px</span>
                </div>
              </div>

              {/* Speech Provider */}
              <div className="drawer-section">
                <div className="drawer-section-title">🤖 Speech Provider</div>
                <div className="drawer-row" style={{ gap: 6 }}>
                  <label>API</label>
                  <div style={{ display: "flex", gap: 4, flexWrap: "wrap" }}>
                    {[
                      { key: "azure", label: "Azure", icon: "☁️" },
                      { key: "elevenlabs", label: "ElevenLabs", icon: "🎭" },
                      { key: "web-speech", label: "Web Speech", icon: "🎙️" },
                    ].map((opt) => (
                      <button
                        key={opt.key}
                        onClick={() =>
                          !conv.isListening && setProvider(opt.key)
                        }
                        disabled={conv.isListening}
                        style={{
                          padding: "5px 14px",
                          fontSize: "12px",
                          fontWeight: 600,
                          borderRadius: 8,
                          cursor: conv.isListening ? "not-allowed" : "pointer",
                          border:
                            provider === opt.key
                              ? "1.5px solid #8b5cf6"
                              : "1px solid rgba(0,0,0,0.1)",
                          background:
                            provider === opt.key
                              ? "rgba(139,92,246,0.12)"
                              : "rgba(0,0,0,0.02)",
                          color: provider === opt.key ? "#8b5cf6" : "#6b7280",
                          opacity: conv.isListening ? 0.5 : 1,
                          transition: "all 0.15s",
                        }}
                      >
                        {opt.icon} {opt.label}
                      </button>
                    ))}
                  </div>
                </div>

                {/* Sub-option: TTS Engine choice for Web Speech */}
                {provider === "web-speech" && (
                  <div
                    className="drawer-row"
                    style={{
                      gap: 6,
                      marginTop: 10,
                      borderTop: "1px dashed rgba(255,255,255,0.05)",
                      paddingTop: 10,
                    }}
                  >
                    <label>Bộ phát TTS</label>
                    <div style={{ display: "flex", gap: 4 }}>
                      {[
                        { key: "azure", label: "Azure", icon: "☁️" },
                        { key: "elevenlabs", label: "ElevenLabs", icon: "🎭" },
                      ].map((opt) => (
                        <button
                          key={opt.key}
                          onClick={() =>
                            !conv.isListening && setTtsProvider(opt.key)
                          }
                          disabled={conv.isListening}
                          style={{
                            padding: "4px 10px",
                            fontSize: "11px",
                            fontWeight: 600,
                            borderRadius: 6,
                            cursor: conv.isListening
                              ? "not-allowed"
                              : "pointer",
                            border:
                              ttsProvider === opt.key
                                ? "1.2px solid #8b5cf6"
                                : "1px solid rgba(0,0,0,0.1)",
                            background:
                              ttsProvider === opt.key
                                ? "rgba(139,92,246,0.12)"
                                : "rgba(0,0,0,0.02)",
                            color:
                              ttsProvider === opt.key ? "#8b5cf6" : "#6b7280",
                            opacity: conv.isListening ? 0.5 : 1,
                            transition: "all 0.15s",
                          }}
                        >
                          {opt.icon} {opt.label}
                        </button>
                      ))}
                    </div>
                  </div>
                )}
              </div>

              {/* Tốc độ nói */}
              <div className="drawer-section">
                <div className="drawer-section-title">
                  ⚡ Tốc độ phát giọng nói
                </div>
                <div
                  style={{
                    display: "flex",
                    alignItems: "center",
                    gap: 8,
                    margin: "6px 0 0",
                  }}
                >
                  <span
                    style={{
                      fontSize: "11px",
                      color: "var(--muted)",
                      minWidth: 30,
                    }}
                  >
                    Chậm
                  </span>
                  <input
                    type="range"
                    min={0.8}
                    max={2.0}
                    step={0.1}
                    value={speed}
                    onChange={(e) => setSpeed(Number(e.target.value))}
                    disabled={conv.isListening}
                    style={{
                      flex: 1,
                      accentColor: "#8b5cf6",
                      cursor: conv.isListening ? "not-allowed" : "pointer",
                    }}
                  />
                  <span
                    style={{
                      fontSize: "11px",
                      color: "var(--muted)",
                      minWidth: 30,
                      textAlign: "right",
                    }}
                  >
                    Nhanh
                  </span>
                  <span
                    style={{
                      fontSize: "13px",
                      fontWeight: 700,
                      color: "#8b5cf6",
                      minWidth: 45,
                      padding: "2px 6px",
                      background: "rgba(139,92,246,0.08)",
                      borderRadius: 6,
                      textAlign: "center",
                    }}
                  >
                    {speed.toFixed(1)}x
                  </span>
                </div>
              </div>

              {/* Voice select */}
              <div className="drawer-section">
                <div className="drawer-section-title">
                  🔊 Giọng đọc{" "}
                  {activeTtsProvider === "elevenlabs"
                    ? "(ElevenLabs)"
                    : "(Azure)"}
                </div>
                {activeTtsProvider === "elevenlabs" ? (
                  <>
                    <div className="drawer-row">
                      <label>
                        {srcLang.flag} Giọng {srcLang.name}
                      </label>
                      <select
                        value={srcVoice}
                        onChange={(e) => setSrcVoice(e.target.value)}
                        disabled={conv.isListening}
                        className="drawer-select"
                      >
                        {VOICE_OPTIONS_ELEVENLABS.map((v) => (
                          <option key={v.id} value={v.id}>
                            {v.label}
                          </option>
                        ))}
                      </select>
                    </div>
                    <div className="drawer-row">
                      <label>
                        {tgtLang.flag} Giọng {tgtLang.name}
                      </label>
                      <select
                        value={tgtVoice}
                        onChange={(e) => setTgtVoice(e.target.value)}
                        disabled={conv.isListening}
                        className="drawer-select"
                      >
                        {VOICE_OPTIONS_ELEVENLABS.map((v) => (
                          <option key={v.id} value={v.id}>
                            {v.label}
                          </option>
                        ))}
                      </select>
                    </div>
                  </>
                ) : (
                  <>
                    <div className="drawer-row">
                      <label>
                        {srcLang.flag} {srcLang.name}
                      </label>
                      <select
                        value={srcVoice}
                        onChange={(e) => setSrcVoice(e.target.value)}
                        disabled={conv.isListening}
                        className="drawer-select"
                      >
                        {(VOICE_OPTIONS_AZURE[srcLang.translateCode] || []).map(
                          (v) => (
                            <option key={v.id} value={v.id}>
                              {v.label}
                            </option>
                          ),
                        )}
                      </select>
                    </div>
                    <div className="drawer-row">
                      <label>
                        {tgtLang.flag} {tgtLang.name}
                      </label>
                      <select
                        value={tgtVoice}
                        onChange={(e) => setTgtVoice(e.target.value)}
                        disabled={conv.isListening}
                        className="drawer-select"
                      >
                        {(VOICE_OPTIONS_AZURE[tgtLang.translateCode] || []).map(
                          (v) => (
                            <option key={v.id} value={v.id}>
                              {v.label}
                            </option>
                          ),
                        )}
                      </select>
                    </div>
                  </>
                )}
              </div>

              {/* Advanced logic toggles */}
              <div className="drawer-section">
                <div className="drawer-section-title">⚡ Cấu hình liên tục</div>

                {/* Auto Language detect */}
                <div className="drawer-row" style={{ opacity: provider !== 'azure' ? 0.6 : 1 }}>
                  <label>🌐 Tự nhận dạng ngôn ngữ</label>
                  <div
                    className={`toggle-switch ${autoDetect ? "on" : "off"} ${conv.isListening || provider !== 'azure' ? "disabled" : ""}`}
                    onClick={() =>
                      !conv.isListening && provider === 'azure' && setAutoDetect(!autoDetect)
                    }
                    title={provider !== 'azure' ? "Chỉ hỗ trợ tự nhận dạng ngôn ngữ khi sử dụng công cụ Azure" : ""}
                  >
                    <div className="toggle-switch-knob" />
                  </div>
                </div>

                {/* Helper text if not Azure */}
                {provider !== 'azure' && (
                  <div
                    style={{
                      fontSize: '11px',
                      color: '#9ca3af',
                      background: 'rgba(255,255,255,0.02)',
                      borderRadius: 6,
                      padding: '5px 8px',
                      marginTop: '-4px',
                      marginBottom: '8px',
                      lineHeight: '1.4',
                      border: '1px dashed rgba(255,255,255,0.05)',
                    }}
                  >
                    💡 Chỉ khả dụng khi sử dụng công cụ STT Azure.
                  </div>
                )}

                {/* Auto TTS Toggle */}
                <div className="drawer-row">
                  <label>{autoTTS ? "🔊" : "🔇"} Tự phát giọng sau dịch</label>
                  <div
                    className={`toggle-switch ${autoTTS ? "on" : "off"}`}
                    onClick={() => {
                      setAutoTTS(!autoTTS);
                    }}
                  >
                    <div className="toggle-switch-knob" />
                  </div>
                </div>

                {/* Helper text based on AutoTTS */}
                <div
                  style={{
                    fontSize: "11px",
                    color: autoDetect && autoTTS ? "#eab308" : autoTTS ? "#6b7280" : "#10b981",
                    background: autoDetect && autoTTS
                      ? "rgba(234,179,8,0.06)"
                      : autoTTS
                      ? "rgba(255,255,255,0.02)"
                      : "rgba(16,185,129,0.06)",
                    borderRadius: 6,
                    padding: "6px 10px",
                    marginTop: "-4px",
                    marginBottom: "8px",
                    lineHeight: "1.4",
                    border: autoDetect && autoTTS
                      ? "1px solid rgba(234,179,8,0.15)"
                      : autoTTS
                      ? "none"
                      : "1px solid rgba(16,185,129,0.15)",
                  }}
                >
                  {autoDetect && autoTTS
                    ? "🎧 Khuyên dùng tai nghe: Bạn đang bật Tự nhận dạng ngôn ngữ và Tự phát loa. Hãy đeo tai nghe để tránh tiếng từ loa ngoài dội lại mic gây vọng lặp âm."
                    : autoTTS
                    ? "💡 Máy sẽ tự động đọc to bản dịch ngay khi xử lý xong."
                    : "💡 Tắt đọc giúp hệ thống dịch hiển thị chữ liên tục, hoàn toàn không rú âm, không cần tai nghe."}
                </div>

                {/* Headphones overlap listening (Only show if AutoTTS is ON!) */}
                {autoTTS && (
                  <>
                    <div
                      className="drawer-row"
                      style={{
                        borderTop: "1px solid rgba(255,255,255,0.05)",
                        paddingTop: "10px",
                      }}
                    >
                      <label>🎧 Nghe đè khi phát (Chống vọng AI)</label>
                      <div
                        className={`toggle-switch ${overlapListening ? "on" : "off"}`}
                        onClick={() => setOverlapListening(!overlapListening)}
                      >
                        <div className="toggle-switch-knob" />
                      </div>
                    </div>

                    {overlapListening && (
                      <div
                        className="drawer-row"
                        style={{
                          paddingLeft: "15px",
                          marginTop: "-2px",
                          marginBottom: "6px",
                          borderLeft: "2px solid rgba(139,92,246,0.3)",
                        }}
                      >
                        <label style={{ fontSize: "12px", color: "var(--text2)" }}>
                          🔌 Tôi đang đeo tai nghe
                        </label>
                        <div
                          className={`toggle-switch ${useHeadphones ? "on" : "off"}`}
                          onClick={() => setUseHeadphones(!useHeadphones)}
                        >
                          <div className="toggle-switch-knob" />
                        </div>
                      </div>
                    )}

                    <div
                      style={{
                        fontSize: "11px",
                        color: autoDetect && overlapListening && !useHeadphones
                          ? "#ef4444"
                          : autoDetect && overlapListening
                          ? "#eab308"
                          : overlapListening && !useHeadphones
                          ? "#eab308"
                          : overlapListening
                          ? "#10b981"
                          : "#6b7280",
                        background: autoDetect && overlapListening && !useHeadphones
                          ? "rgba(239,68,68,0.06)"
                          : autoDetect && overlapListening
                          ? "rgba(234,179,8,0.06)"
                          : overlapListening && !useHeadphones
                          ? "rgba(234,179,8,0.06)"
                          : overlapListening
                          ? "rgba(16,185,129,0.06)"
                          : "rgba(255,255,255,0.02)",
                        borderRadius: 6,
                        padding: "6px 10px",
                        marginTop: "-4px",
                        marginBottom: "8px",
                        lineHeight: "1.4",
                        border: autoDetect && overlapListening && !useHeadphones
                          ? "1px solid rgba(239,68,68,0.15)"
                          : autoDetect && overlapListening
                          ? "1px solid rgba(234,179,8,0.15)"
                          : overlapListening && !useHeadphones
                          ? "1px solid rgba(234,179,8,0.15)"
                          : overlapListening
                          ? "1px solid rgba(16,185,129,0.15)"
                          : "none",
                      }}
                    >
                      {autoDetect && overlapListening
                        ? (useHeadphones
                            ? "🎧 Tự nhận dạng + Tai nghe: Âm lượng phát dịch hạ xuống 80% khi nói. Hãy đeo tai nghe để tránh tiếng vọng dội lại mic gây lặp dịch."
                            : "🚨 BẮT BUỘC đeo tai nghe: Khi bật Tự nhận dạng + Nghe đè mà dùng loa ngoài, tiếng dội âm sẽ dễ dàng gây ra vòng lặp dịch vô hạn (âm phát dội lại hạ xuống 50% khi nói).")
                        : overlapListening
                        ? (useHeadphones
                            ? "🟢 Đã bật Nghe đè (Tai nghe): Âm lượng robot tự hạ xuống 80% khi bạn nói để nghe rõ bản dịch bám đuổi."
                            : "⚠️ Nghe đè (Loa ngoài): Âm lượng robot tự hạ sâu xuống 50% khi bạn nói để giảm tiếng vọng dội ngược vào micro.")
                        : "💡 Tắt: Micro tạm đóng khi robot phát tiếng để chống rú vọng âm."}
                    </div>
                  </>
                )}

                {/* Silence slider */}
                <div
                  className="drawer-row"
                  style={{
                    gap: 8,
                    borderTop: "1px solid rgba(255,255,255,0.05)",
                    paddingTop: "10px",
                  }}
                >
                  <label>🕐 Im lặng dịch</label>
                  <input
                    type="range"
                    min={2}
                    max={8}
                    step={1}
                    value={silenceSeconds}
                    onChange={(e) => setSilenceSeconds(Number(e.target.value))}
                    disabled={conv.isListening}
                    style={{
                      flex: 1,
                      accentColor: "#0ea5e9",
                      cursor: conv.isListening ? "not-allowed" : "pointer",
                    }}
                  />
                  <span
                    style={{
                      fontSize: "13px",
                      fontWeight: 700,
                      color: "#0ea5e9",
                      minWidth: 30,
                      textAlign: "center",
                    }}
                  >
                    {silenceSeconds}s
                  </span>
                </div>
              </div>

              {/* Limit warning */}
              <div
                style={{
                  fontSize: "12px",
                  color: "#ff4d4f",
                  textAlign: "center",
                  lineHeight: 1.4,
                  fontWeight: 600,
                  background: "rgba(255,77,79,0.06)",
                  borderRadius: 8,
                  padding: "8px 12px",
                  border: "1px solid rgba(255,77,79,0.15)",
                }}
              >
                ⚠️ Khuyên dùng khoảng im lặng 2s - 3s để giao tiếp song song có trải
                nghiệm bám đuổi tốt nhất!
              </div>
            </div>
          </div>
        </>
      )}
    </div>
  );
}
