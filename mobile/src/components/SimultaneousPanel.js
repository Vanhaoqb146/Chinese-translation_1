// mobile/src/components/SimultaneousPanel.js
import React, { useState, useEffect, useRef } from 'react';
import {
  StyleSheet,
  Text,
  View,
  TouchableOpacity,
  ScrollView,
  ActivityIndicator,
  Alert,
  Modal,
  Switch,
} from 'react-native';
import { Audio } from 'expo-av';
import { Feather } from '@expo/vector-icons';
import Voice from '../services/speechRecognition';
import {
  MIN_SPEECH_CAPTURE_MS,
  isSpeechMeteringActive,
  startSpeechAudioRecording,
  stopSpeechAudioRecording,
} from '../services/speechAudioRecorder';
import {
  detectMobileTextLanguage,
  getMobileAutoDetectLanguages,
  isTextLikelyLanguage,
  normalizeMobileAutoDetectLanguage,
} from '../lib/mobileAutoDetect';
import { COLORS, SIZES } from '../theme';
import MicrophonePulse from './MicrophonePulse';
import { VOICE_OPTIONS_AZURE, VOICE_OPTIONS_ELEVENLABS } from '../lib/voiceOptions';

const DEFAULT_SILENCE_SECONDS = 2;
const MIN_SILENCE_SECONDS = 2;
const MAX_SILENCE_SECONDS = 5;
const TTS_DUCK_VOLUME_HEADPHONES = 0.8;
const TTS_DUCK_VOLUME_SPEAKER = 0.4;
const TTS_DUCK_VOLUME_AUTO_SPEAKER = 0.55;
const MIC_RESTART_AFTER_TTS_HEADPHONES_MS = 350;
const MIC_RESTART_AFTER_TTS_SPEAKER_MS = 800;
const RECENT_ROBOT_SPEECH_MAX_ITEMS = 8;
const RECENT_ROBOT_SPEECH_TTL_MS = 45000;
const ECHO_RISK_UNVERIFIED_CONFIDENCE_LIMIT = 0.65;

const logPerformance = (requestId, stage, details = {}) => {
  console.log(`[PERF ${requestId}] ${stage} ${JSON.stringify(details)}`);
};

const clampSilenceSeconds = (value) => {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return DEFAULT_SILENCE_SECONDS;
  const stepped = Math.round(numeric * 2) / 2;
  return Math.max(MIN_SILENCE_SECONDS, Math.min(MAX_SILENCE_SECONDS, stepped));
};

const getSpeechLocale = (translateCode) => (
  translateCode === 'zh' ? 'zh-CN' :
  translateCode === 'vi' ? 'vi-VN' :
  translateCode === 'en' ? 'en-US' :
  translateCode === 'ja' ? 'ja-JP' :
  translateCode === 'ko' ? 'ko-KR' : 'vi-VN'
);

const normalizeDetectedLanguage = (eventOrLocale) => {
  const locale = typeof eventOrLocale === 'string'
    ? eventOrLocale
    : eventOrLocale?.detectedLanguage ||
      eventOrLocale?.language ||
      eventOrLocale?.languageCode ||
      eventOrLocale?.locale;

  return typeof locale === 'string' ? locale.split('-')[0].toLowerCase() : null;
};

const detectLangFromText = (text, srcLang, tgtLang) => {
  const normalized = (text || '').trim();
  if (!normalized) return null;

  if (/[\u3400-\u9fff]/.test(normalized)) return 'zh';
  if (/[\u3040-\u30ff]/.test(normalized)) return null;
  if (/[\uac00-\ud7af]/.test(normalized)) return null;

  const decomposed = normalized.normalize('NFD');
  if (/[\u0300-\u036f]/.test(decomposed) || /đ/i.test(normalized)) return 'vi';

  if (/[a-zA-Z]/.test(normalized)) {
    const codes = [srcLang.translateCode, tgtLang.translateCode];
    if (codes.includes('vi')) return 'vi';
  }

  return null;
};

const normalizeForComparison = (text) => (
  (text || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9\u3400-\u9fff\u3040-\u30ff\uac00-\ud7af]+/g, '')
);

const getSimilarityRatio = (str1, str2) => {
  const s1 = normalizeForComparison(str1);
  const s2 = normalizeForComparison(str2);

  if (!s1 || !s2) return 0;
  if (s1 === s2) return 1;

  const len1 = s1.length;
  const len2 = s2.length;
  const matrix = Array(len2 + 1).fill(null).map(() => Array(len1 + 1).fill(0));

  for (let i = 0; i <= len1; i += 1) matrix[0][i] = i;
  for (let j = 0; j <= len2; j += 1) matrix[j][0] = j;

  for (let j = 1; j <= len2; j += 1) {
    for (let i = 1; i <= len1; i += 1) {
      const substitutionCost = s1[i - 1] === s2[j - 1] ? 0 : 1;
      matrix[j][i] = Math.min(
        matrix[j][i - 1] + 1,
        matrix[j - 1][i] + 1,
        matrix[j - 1][i - 1] + substitutionCost
      );
    }
  }

  const distance = matrix[len2][len1];
  return (Math.max(len1, len2) - distance) / Math.max(len1, len2);
};

const getLongestCommonSubstringLength = (str1, str2) => {
  const s1 = normalizeForComparison(str1);
  const s2 = normalizeForComparison(str2);
  if (!s1 || !s2) return 0;

  let previous = new Array(s2.length + 1).fill(0);
  let longest = 0;

  for (let i = 1; i <= s1.length; i += 1) {
    const current = new Array(s2.length + 1).fill(0);
    for (let j = 1; j <= s2.length; j += 1) {
      if (s1[i - 1] === s2[j - 1]) {
        current[j] = previous[j - 1] + 1;
        longest = Math.max(longest, current[j]);
      }
    }
    previous = current;
  }

  return longest;
};

const getEchoMatchDetails = (candidate, robotText) => {
  const candidateNormalized = normalizeForComparison(candidate);
  const robotNormalized = normalizeForComparison(robotText);
  const commonLength = getLongestCommonSubstringLength(candidate, robotText);
  const hasCjk = /[\u3400-\u9fff]/.test(candidateNormalized + robotNormalized);
  const minCommonLength = hasCjk ? 8 : 18;
  const candidateCoverage = candidateNormalized
    ? commonLength / candidateNormalized.length
    : 0;
  const robotCoverage = robotNormalized
    ? commonLength / robotNormalized.length
    : 0;

  return {
    commonLength,
    candidateCoverage,
    robotCoverage,
    isPartialEcho: commonLength >= minCommonLength &&
      (candidateCoverage >= 0.38 || robotCoverage >= 0.38),
  };
};

const SHORT_FILLERS = new Set([
  'à', 'ờ', 'ừ', 'ừm', 'ờm', 'à à', 'alo',
  'um', 'uh', 'erm', 'hmm', 'ok', 'okay',
  '嗯', '啊', '哦', '呀', '好',
].map(normalizeForComparison));

const getDefaultVoiceForLang = (provider, langCode) => {
  if (provider === 'elevenlabs') {
    return VOICE_OPTIONS_ELEVENLABS[0]?.id || '';
  }

  return VOICE_OPTIONS_AZURE[langCode]?.[0]?.id || '';
};

const getSafeVoiceForLang = (provider, langCode, voiceId) => {
  const voices = provider === 'elevenlabs'
    ? VOICE_OPTIONS_ELEVENLABS
    : (VOICE_OPTIONS_AZURE[langCode] || []);

  return voices.some((voice) => voice.id === voiceId)
    ? voiceId
    : getDefaultVoiceForLang(provider, langCode);
};

const getAllowedAutoCodes = (srcLang, tgtLang) => (
  getMobileAutoDetectLanguages(srcLang.translateCode, tgtLang.translateCode)
);

const resolveAutoDetectedLanguage = (text, detectedLangOverride, srcLang, tgtLang) => {
  const allowedCodes = getAllowedAutoCodes(srcLang, tgtLang);
  const detectedLang = normalizeMobileAutoDetectLanguage(detectedLangOverride);
  const textLang = detectMobileTextLanguage(text, allowedCodes);

  if (detectedLang && allowedCodes.includes(detectedLang)) {
    if (textLang && textLang !== detectedLang && isTextLikelyLanguage(text, textLang)) {
      return textLang;
    }
    return detectedLang;
  }

  return textLang;
};

export default function SimultaneousPanel({
  srcIdx,
  tgtIdx,
  LANGUAGES,
  user,
  apiKey,
  selectedModel,
  api,
  sound,
  setSound,
  isPlaying,
  setIsPlaying,
  stopAudio,
  themeColors,
  chatLog: persistedChatLog,
  setChatLog: setPersistedChatLog,
}) {
  const colors = themeColors || COLORS;
  const styles = getStyles(colors);
  const [fontSize, setFontSize] = useState(16);
  const [provider, setProvider] = useState('azure');
  const [speed, setSpeed] = useState(1.0);
  const [srcVoice, setSrcVoice] = useState('');
  const [tgtVoice, setTgtVoice] = useState('');
  const [autoTTS, setAutoTTS] = useState(true);
  const [autoDetect, setAutoDetect] = useState(false);
  const [silenceSeconds, setSilenceSeconds] = useState(DEFAULT_SILENCE_SECONDS);
  const [muteSrc, setMuteSrc] = useState(false);
  const [muteTgt, setMuteTgt] = useState(false);
  const [overlapListening, setOverlapListening] = useState(false);
  const [useHeadphones, setUseHeadphones] = useState(true);

  const [settingsVisible, setSettingsVisible] = useState(false);
  const [localChatLog, setLocalChatLog] = useState([]);
  const chatLog = persistedChatLog || localChatLog;
  const setChatLog = setPersistedChatLog || setLocalChatLog;
  const [isActive, setIsActive] = useState(false);
  const [activeInputLang, setActiveInputLang] = useState(null);
  const setStatusText = useRef(() => {}).current;
  const [isProcessing, setIsProcessing] = useState(false);
  const [isSpeechActive, setIsSpeechActive] = useState(false);
  const [queueLength, setQueueLength] = useState(0);

  const [liveText, setLiveText] = useState('');
  const liveTextRef = useRef('');
  const silenceTimerRef = useRef(null);

  const isActiveRef = useRef(false);
  const isRecordingRef = useRef(false);
  const isStartingMicRef = useRef(false);
  const stoppingRef = useRef(false);
  const captureSessionRef = useRef(0);
  const audioCaptureIdRef = useRef(0);
  const recognitionSequenceRef = useRef(0);
  const nextRecognitionCommitRef = useRef(1);
  const pendingRecognitionResultsRef = useRef(new Map());
  const soundInstanceRef = useRef(null);
  const isTtsPlayingRef = useRef(false);
  const activeInputLangRef = useRef(null);
  const detectedAutoLangRef = useRef(null);
  const audioRecordingRef = useRef(null);
  const audioCaptureStartedAtRef = useRef(0);
  const audioLastSpeechAtRef = useRef(0);
  const audioHasSpeechRef = useRef(false);
  const translationQueueRef = useRef([]);
  const isProcessingQueueRef = useRef(false);
  const chatLogRef = useRef([]);
  const lastQueuedTextRef = useRef('');
  const lastRobotSpokenTextRef = useRef('');
  const recentRobotSpeechRef = useRef([]);
  const activeTtsLangRef = useRef(null);
  const currentDuckVolumeRef = useRef(null);
  const ttsSessionRef = useRef(0);
  const recordingDuringTtsRef = useRef(false);
  const recordingTtsLangRef = useRef(null);
  const manualRecognitionConfidenceRef = useRef(null);
  const recordingUsesAndroidAecRef = useRef(false);

  const providerRef = useRef(provider);
  const speedRef = useRef(speed);
  const srcVoiceRef = useRef(srcVoice);
  const tgtVoiceRef = useRef(tgtVoice);
  const autoTTSRef = useRef(autoTTS);
  const autoDetectRef = useRef(autoDetect);
  const muteSrcRef = useRef(muteSrc);
  const muteTgtRef = useRef(muteTgt);
  const silenceSecondsRef = useRef(silenceSeconds);
  const overlapListeningRef = useRef(overlapListening);
  const useHeadphonesRef = useRef(useHeadphones);

  const scrollViewRef = useRef(null);

  isActiveRef.current = isActive;
  activeInputLangRef.current = activeInputLang;
  chatLogRef.current = chatLog;
  providerRef.current = provider;
  speedRef.current = speed;
  srcVoiceRef.current = srcVoice;
  tgtVoiceRef.current = tgtVoice;
  autoTTSRef.current = autoTTS;
  autoDetectRef.current = autoDetect;
  muteSrcRef.current = muteSrc;
  muteTgtRef.current = muteTgt;
  silenceSecondsRef.current = silenceSeconds;
  overlapListeningRef.current = overlapListening;
  useHeadphonesRef.current = useHeadphones;

  useEffect(() => {
    soundInstanceRef.current = sound;
  }, [sound]);

  useEffect(() => {
    isTtsPlayingRef.current = isPlaying;
  }, [isPlaying]);

  useEffect(() => {
    if (!overlapListening && !isPlaying && isActive && !isProcessing && !isRecordingRef.current) {
      const restartDelay = useHeadphonesRef.current
        ? MIC_RESTART_AFTER_TTS_HEADPHONES_MS
        : MIC_RESTART_AFTER_TTS_SPEAKER_MS;
      const timer = setTimeout(() => {
        startContinuousMicLoop(activeInputLangRef.current || (autoDetectRef.current ? 'auto' : 'src'));
      }, restartDelay);
      return () => clearTimeout(timer);
    }
    // startContinuousMicLoop reads live refs, so it should not be a dependency here.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isPlaying, isActive, isProcessing, overlapListening]);

  useEffect(() => {
    if (!overlapListening && isPlaying) {
      cleanupRecording();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isPlaying, overlapListening]);

  useEffect(() => {
    async function loadSettings() {
      const saved = await api.getModeSettings('sim');
      if (saved) {
        const savedProvider = saved.autoDetect ? 'azure' : (saved.provider || 'azure');

        if (saved.fontSize) setFontSize(saved.fontSize);
        if (saved.provider) setProvider(savedProvider);
        if (saved.speed) setSpeed(saved.speed);
        setSrcVoice(getSafeVoiceForLang(savedProvider, LANGUAGES[srcIdx].translateCode, saved.srcVoice));
        setTgtVoice(getSafeVoiceForLang(savedProvider, LANGUAGES[tgtIdx].translateCode, saved.tgtVoice));
        if (saved.autoTTS !== undefined) setAutoTTS(saved.autoTTS);
        if (saved.autoDetect !== undefined) setAutoDetect(saved.autoDetect);
        if (saved.silenceSeconds) setSilenceSeconds(clampSilenceSeconds(saved.silenceSeconds));
        if (saved.muteSrc !== undefined) setMuteSrc(saved.muteSrc);
        if (saved.muteTgt !== undefined) setMuteTgt(saved.muteTgt);
        if (saved.overlapListening !== undefined) setOverlapListening(saved.overlapListening);
        if (saved.useHeadphones !== undefined) setUseHeadphones(saved.useHeadphones);
      } else {
        setSrcVoice(getDefaultVoiceForLang('azure', LANGUAGES[srcIdx].translateCode));
        setTgtVoice(getDefaultVoiceForLang('azure', LANGUAGES[tgtIdx].translateCode));
      }
    }
    loadSettings();
  }, [api, LANGUAGES, srcIdx, tgtIdx]);

  useEffect(() => {
    const currentSettings = {
      fontSize,
      provider,
      speed,
      srcVoice,
      tgtVoice,
      autoTTS,
      autoDetect,
      silenceSeconds,
      muteSrc,
      muteTgt,
      overlapListening,
      useHeadphones,
    };
    api.saveModeSettings('sim', currentSettings);
  }, [api, fontSize, provider, speed, srcVoice, tgtVoice, autoTTS, autoDetect, silenceSeconds, muteSrc, muteTgt, overlapListening, useHeadphones]);

  useEffect(() => {
    if (autoDetect && provider !== 'azure') {
      setProvider('azure');
    }
  }, [autoDetect, provider]);

  useEffect(() => {
    setSrcVoice((currentVoice) => getSafeVoiceForLang(provider, LANGUAGES[srcIdx].translateCode, currentVoice));
    setTgtVoice((currentVoice) => getSafeVoiceForLang(provider, LANGUAGES[tgtIdx].translateCode, currentVoice));
  }, [provider, LANGUAGES, srcIdx, tgtIdx]);

  useEffect(() => {
    return () => {
      isActiveRef.current = false;
      clearSilenceTimer();
      cleanupRecording();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const clearSilenceTimer = () => {
    if (silenceTimerRef.current) {
      clearTimeout(silenceTimerRef.current);
      silenceTimerRef.current = null;
    }
  };

  const resetLiveText = () => {
    setLiveText('');
    liveTextRef.current = '';
  };

  const cleanupRecording = async () => {
    try {
      clearSilenceTimer();
      isRecordingRef.current = false;
      setIsSpeechActive(false);
      if (audioRecordingRef.current) {
        const recording = audioRecordingRef.current;
        audioRecordingRef.current = null;
        await stopSpeechAudioRecording(recording);
      }
      await Voice.stop();
      await Voice.destroy();
    } catch (e) {}
  };

  const getFallbackLangType = () => (
    autoDetectRef.current ? 'auto' : (activeInputLangRef.current || 'src')
  );

  const pruneRecentRobotSpeech = (now = Date.now()) => {
    const next = recentRobotSpeechRef.current
      .filter((entry) => entry?.normalized && now - entry.createdAt <= RECENT_ROBOT_SPEECH_TTL_MS)
      .slice(-RECENT_ROBOT_SPEECH_MAX_ITEMS);
    recentRobotSpeechRef.current = next;
    return next;
  };

  const rememberRobotSpeech = ({ requestId, text, lang, sourceText }) => {
    const normalized = normalizeForComparison(text);
    if (!normalized) return;

    const now = Date.now();
    const entry = {
      requestId: requestId || `tts-${now.toString(36)}`,
      lang: normalizeMobileAutoDetectLanguage(lang),
      text,
      normalized,
      sourceText: sourceText || '',
      createdAt: now,
    };
    recentRobotSpeechRef.current = [...pruneRecentRobotSpeech(now), entry]
      .slice(-RECENT_ROBOT_SPEECH_MAX_ITEMS);
    lastRobotSpokenTextRef.current = text;

    logPerformance(entry.requestId, 'robot_speech_remembered', {
      lang: entry.lang,
      textLength: text.length,
      retained: recentRobotSpeechRef.current.length,
    });
  };

  const getRecentRobotSpeechEntries = () => {
    const entries = pruneRecentRobotSpeech();
    const fallbackText = lastRobotSpokenTextRef.current;
    if (
      !fallbackText ||
      entries.some((entry) => entry.text === fallbackText)
    ) {
      return entries;
    }

    return [
      ...entries,
      {
        requestId: 'last-robot',
        lang: null,
        text: fallbackText,
        normalized: normalizeForComparison(fallbackText),
        sourceText: '',
        createdAt: 0,
      },
    ];
  };

  const isSpeakerEchoRiskTrace = (trace = {}) => (
    autoDetectRef.current &&
    overlapListeningRef.current &&
    !useHeadphonesRef.current &&
    Boolean(trace.recordedDuringTts || trace.ttsLang)
  );

  const isSpeakerOverlapAutoMode = () => (
    autoDetectRef.current &&
    activeInputLangRef.current === 'auto' &&
    overlapListeningRef.current &&
    !useHeadphonesRef.current
  );

  const startSimultaneous = async (langType) => {
    const nextLangType = autoDetect ? 'auto' : langType;
    await stopAudio();
    stoppingRef.current = false;
    captureSessionRef.current += 1;
    recognitionSequenceRef.current = 0;
    nextRecognitionCommitRef.current = 1;
    pendingRecognitionResultsRef.current.clear();
    translationQueueRef.current = [];
    setQueueLength(0);
    lastQueuedTextRef.current = '';
    lastRobotSpokenTextRef.current = '';
    recentRobotSpeechRef.current = [];
    recordingUsesAndroidAecRef.current = false;
    ttsSessionRef.current += 1;
    activeTtsLangRef.current = null;
    isProcessingQueueRef.current = false;
    setIsActive(true);
    isActiveRef.current = true;
    setActiveInputLang(nextLangType);
    activeInputLangRef.current = nextLangType;
    setStatusText(nextLangType === 'auto' ? 'Live Auto đang nghe...' : 'Mic đang nghe...');
    resetLiveText();
    startContinuousMicLoop(nextLangType);
  };

  const stopSimultaneous = async () => {
    stoppingRef.current = true;
    captureSessionRef.current += 1;
    pendingRecognitionResultsRef.current.clear();
    setIsActive(false);
    isActiveRef.current = false;
    setActiveInputLang(null);
    activeInputLangRef.current = null;
    translationQueueRef.current = [];
    setQueueLength(0);
    lastQueuedTextRef.current = '';
    lastRobotSpokenTextRef.current = '';
    recentRobotSpeechRef.current = [];
    recordingUsesAndroidAecRef.current = false;
    isProcessingQueueRef.current = false;
    ttsSessionRef.current += 1;
    activeTtsLangRef.current = null;
    setIsProcessing(false);
    setStatusText('Đã dừng giao tiếp song song.');
    resetLiveText();
    await restoreTtsVolume();
    await stopAudio();
    await cleanupRecording();
  };

  const handlePressMic = async (langType) => {
    if (isActiveRef.current) {
      await stopSimultaneous();
      return;
    }

    if (isProcessingQueueRef.current) return;
    await startSimultaneous(langType);
  };

  const handleSpeechValue = (event, langType) => {
    const transcript = event?.value?.[0];
    if (!transcript || !isActiveRef.current) return;

    const confidence = Number(event?.confidence);
    if (Number.isFinite(confidence) && confidence >= 0) {
      manualRecognitionConfidenceRef.current = confidence;
    }
    setLiveText(transcript);
    liveTextRef.current = transcript;

    if (overlapListeningRef.current && isTtsPlayingRef.current) {
      recordingDuringTtsRef.current = true;
      recordingTtsLangRef.current = activeTtsLangRef.current;
      duckTtsVolume();
    }

    clearSilenceTimer();
    silenceTimerRef.current = setTimeout(() => {
      stopRecognitionAndQueue(langType);
    }, silenceSecondsRef.current * 1000);
  };

  const startAzureAutoRecording = async (langType, captureSession, captureId) => {
    audioHasSpeechRef.current = false;
    audioCaptureStartedAtRef.current = Date.now();
    audioLastSpeechAtRef.current = Date.now();
    recordingDuringTtsRef.current = isTtsPlayingRef.current;
    recordingTtsLangRef.current = activeTtsLangRef.current;
    recordingUsesAndroidAecRef.current = false;

    const preferAndroidAec = isSpeakerOverlapAutoMode();
    const recording = await startSpeechAudioRecording((status) => {
      if (
        stoppingRef.current ||
        captureSessionRef.current !== captureSession ||
        audioCaptureIdRef.current !== captureId ||
        !isActiveRef.current ||
        !isRecordingRef.current ||
        activeInputLangRef.current !== langType ||
        !status?.isRecording
      ) return;

      if (isSpeechMeteringActive(status)) {
        audioHasSpeechRef.current = true;
        audioLastSpeechAtRef.current = Date.now();
        setIsSpeechActive(true);
        if (overlapListeningRef.current && isTtsPlayingRef.current) {
          recordingDuringTtsRef.current = true;
          recordingTtsLangRef.current = activeTtsLangRef.current;
          duckTtsVolume();
        }
        return;
      }

      const elapsedMs = Date.now() - audioCaptureStartedAtRef.current;
      const silentForMs = Date.now() - audioLastSpeechAtRef.current;
      const silenceLimitMs = silenceSecondsRef.current * 1000;

      if (
        audioHasSpeechRef.current &&
        elapsedMs >= MIN_SPEECH_CAPTURE_MS &&
        silentForMs >= silenceLimitMs
      ) {
        stopRecognitionAndQueue(langType);
      }
    }, { preferAndroidAec });
    recordingUsesAndroidAecRef.current = Boolean(recording?.__androidAec);
    if (preferAndroidAec) {
      logPerformance(`sim-${captureSession}-aec`, 'android_aec_capture_selected', {
        captureId,
        androidAec: recordingUsesAndroidAecRef.current,
      });
    }

    if (
      stoppingRef.current ||
      captureSessionRef.current !== captureSession ||
      audioCaptureIdRef.current !== captureId ||
      !isActiveRef.current
    ) {
      await stopSpeechAudioRecording(recording);
      return null;
    }

    audioRecordingRef.current = recording;
    return recording;
  };

  const stopAzureAutoRecording = async () => {
    const capture = {
      captureId: audioCaptureIdRef.current,
      startedAt: audioCaptureStartedAtRef.current,
      lastSpeechAt: audioLastSpeechAtRef.current,
      hasSpeech: audioHasSpeechRef.current,
      recordedDuringTts: recordingDuringTtsRef.current,
      ttsLang: recordingTtsLangRef.current,
      androidAec: recordingUsesAndroidAecRef.current,
    };
    const recording = audioRecordingRef.current;
    audioRecordingRef.current = null;
    const audioUri = await stopSpeechAudioRecording(recording);
    recordingUsesAndroidAecRef.current = false;
    return {
      ...capture,
      audioUri,
      stoppedAt: Date.now(),
    };
  };

  const startContinuousMicLoop = async (requestedLangType) => {
    const langType = requestedLangType || getFallbackLangType();
    if (
      stoppingRef.current ||
      !isActiveRef.current ||
      isRecordingRef.current ||
      isStartingMicRef.current
    ) return;

    if (!overlapListeningRef.current && isTtsPlayingRef.current) {
      return;
    }

    isStartingMicRef.current = true;
    try {
      const permission = await Audio.requestPermissionsAsync();
      if (permission.status !== 'granted') {
        setIsActive(false);
        isActiveRef.current = false;
        Alert.alert('Cấp quyền', 'Vui lòng cấp quyền micro để sử dụng.');
        return;
      }

      await Audio.setAudioModeAsync({
        allowsRecordingIOS: true,
        playsInSilentModeIOS: true,
        shouldDuckAndroid: true,
        playThroughEarpieceAndroid: false,
      });

      try {
        await Voice.stop();
        await Voice.destroy();
      } catch (e) {}

      if (stoppingRef.current || !isActiveRef.current) return;

      if (!(autoDetectRef.current && langType === 'auto')) {
        resetLiveText();
      }
      clearSilenceTimer();
      detectedAutoLangRef.current = null;

      const srcLang = LANGUAGES[srcIdx];
      const tgtLang = LANGUAGES[tgtIdx];
      const srcLocale = getSpeechLocale(srcLang.translateCode);
      const allowedAutoCodes = getAllowedAutoCodes(srcLang, tgtLang);
      const captureSession = captureSessionRef.current;
      const captureId = ++audioCaptureIdRef.current;

      // Non-auto must stay on Voice.start() to preserve live partial transcripts.
      if (autoDetectRef.current && langType === 'auto') {
        isRecordingRef.current = true;
        setActiveInputLang(langType);
        activeInputLangRef.current = langType;
        setIsSpeechActive(true);
        setStatusText('Azure Auto đang nghe...');
        await startAzureAutoRecording(langType, captureSession, captureId);
        return;
      }

      Voice.onSpeechStart = () => {
        resetLiveText();
        setStatusText(langType === 'auto' ? 'Live Auto đang ghi âm...' : 'Đang ghi âm...');
        setIsSpeechActive(true);
        if (overlapListeningRef.current && isTtsPlayingRef.current) {
          duckTtsVolume();
        }
      };

      Voice.onSpeechRecognized = () => {
        setIsSpeechActive(true);
      };

      Voice.onSpeechEnd = () => {
        setIsSpeechActive(false);
      };

      Voice.onSpeechResults = (event) => handleSpeechValue(event, langType);
      Voice.onSpeechPartialResults = (event) => handleSpeechValue(event, langType);

      Voice.onSpeechLanguageDetection = (event) => {
        if (!autoDetectRef.current || langType !== 'auto') return;

        const detectedCode = normalizeDetectedLanguage(event);
        if (detectedCode && allowedAutoCodes.includes(detectedCode) && event?.confidence !== 0) {
          detectedAutoLangRef.current = detectedCode;
        }
      };

      Voice.onSpeechVolumeChanged = (event) => {
        const value = Number(event?.value);
        if (
          overlapListeningRef.current &&
          isTtsPlayingRef.current &&
          Number.isFinite(value) &&
          value > -35
        ) {
          duckTtsVolume();
        }
      };

      Voice.onSpeechError = (event) => {
        console.warn('Voice recognition error inside SimultaneousPanel:', event);
        isRecordingRef.current = false;
        setIsSpeechActive(false);
        if (isActiveRef.current && (overlapListeningRef.current || !isTtsPlayingRef.current)) {
          setTimeout(() => {
            startContinuousMicLoop(activeInputLangRef.current || getFallbackLangType());
          }, 500);
        }
      };

      const inputLang = langType === 'tgt' ? tgtLang : srcLang;
      const speechLocale = langType === 'auto' ? srcLocale : getSpeechLocale(inputLang.translateCode);
      const recognitionOptions = {
        continuous: true,
        androidLiveAec:
          overlapListeningRef.current &&
          !useHeadphonesRef.current &&
          !autoDetectRef.current,
      };

      recordingDuringTtsRef.current = isTtsPlayingRef.current;
      recordingTtsLangRef.current = activeTtsLangRef.current;
      manualRecognitionConfidenceRef.current = null;
      isRecordingRef.current = true;
      setActiveInputLang(langType);
      activeInputLangRef.current = langType;
      await Voice.start(speechLocale, recognitionOptions);
      setStatusText(langType === 'auto' ? 'Live Auto đang nghe...' : `Đang nghe ${inputLang.name}...`);
    } catch (error) {
      console.error('Simultaneous setup failed:', error);
      isRecordingRef.current = false;
      setIsSpeechActive(false);
      setIsActive(false);
      isActiveRef.current = false;
      setStatusText('Không thể khởi động micro.');
    } finally {
      isStartingMicRef.current = false;
    }
  };

  const resolveDirection = (langType, text, detectedLangOverride = null) => {
    const srcLang = LANGUAGES[srcIdx];
    const tgtLang = LANGUAGES[tgtIdx];

    let inputLang = srcLang;
    let outputLang = tgtLang;

    if (autoDetectRef.current && langType === 'auto') {
      const detectedLang = resolveAutoDetectedLanguage(
        text,
        detectedLangOverride || detectedAutoLangRef.current,
        srcLang,
        tgtLang
      );
      console.log(`[🧭 Sim] Auto-detect: override=${detectedLangOverride} ref=${detectedAutoLangRef.current} → resolved=${detectedLang}  src=${srcLang.translateCode} tgt=${tgtLang.translateCode}`);
      if (detectedLang === tgtLang.translateCode) {
        inputLang = tgtLang;
        outputLang = srcLang;
      }
      console.log(`[🧭 Sim] Direction: ${inputLang.translateCode} → ${outputLang.translateCode}  text="${(text || '').slice(0, 50)}"`);
    } else if (langType === 'tgt') {
      inputLang = tgtLang;
      outputLang = srcLang;
    }

    return { inputLang, outputLang };
  };

  const shouldDropCandidate = (text, trace = {}) => {
    const normalized = normalizeForComparison(text);
    if (!normalized || normalized.length <= 1) return true;
    if (SHORT_FILLERS.has(normalized)) return true;

    const previousQueued = lastQueuedTextRef.current;
    if (previousQueued && getSimilarityRatio(text, previousQueued) >= 0.92) {
      return true;
    }

    const echoGuardActive =
      overlapListeningRef.current ||
      isTtsPlayingRef.current ||
      Boolean(activeTtsLangRef.current) ||
      Boolean(trace.recordedDuringTts) ||
      Boolean(trace.ttsLang);
    if (!echoGuardActive) return false;

    const robotEntries = getRecentRobotSpeechEntries();
    let bestMatch = null;

    for (const robotEntry of robotEntries) {
      const robotText = robotEntry.text;
      const robotNormalized = robotEntry.normalized || normalizeForComparison(robotText);
      if (!robotNormalized) continue;

      const shortContained = normalized.length < 10 && robotNormalized.includes(normalized);
      const fullSimilarity = getSimilarityRatio(text, robotText);
      const leadingSimilarity = getSimilarityRatio(normalized.slice(0, 18), robotNormalized.slice(0, 18));
      const echoMatch = getEchoMatchDetails(text, robotText);
      const dropReason =
        shortContained ? 'short-contained' :
        fullSimilarity >= 0.7 ? 'full-similarity' :
        leadingSimilarity >= 0.76 ? 'leading-similarity' :
        echoMatch.isPartialEcho ? 'partial-echo' :
        null;
      const rank = Math.max(
        fullSimilarity,
        leadingSimilarity,
        echoMatch.candidateCoverage,
        echoMatch.robotCoverage
      );

      if (!bestMatch || rank > bestMatch.rank) {
        bestMatch = {
          rank,
          requestId: robotEntry.requestId,
          lang: robotEntry.lang,
          fullSimilarity,
          leadingSimilarity,
          commonLength: echoMatch.commonLength,
          candidateCoverage: echoMatch.candidateCoverage,
          robotCoverage: echoMatch.robotCoverage,
        };
      }

      if (dropReason) {
        logPerformance(trace.requestId || 'sim-echo', 'echo_dropped', {
          reason: dropReason,
          robotRequestId: robotEntry.requestId || null,
          robotLang: robotEntry.lang || null,
          recordedDuringTts: Boolean(trace.recordedDuringTts),
          detectedLanguage: trace.detectedLanguage || null,
          ttsLang: trace.ttsLang || activeTtsLangRef.current || null,
          provider: trace.provider || null,
          confidence: trace.confidence ?? null,
          androidAec: Boolean(trace.androidAec),
          fullSimilarity: Number(fullSimilarity.toFixed(3)),
          leadingSimilarity: Number(leadingSimilarity.toFixed(3)),
          commonLength: echoMatch.commonLength,
          candidateCoverage: Number(echoMatch.candidateCoverage.toFixed(3)),
          robotCoverage: Number(echoMatch.robotCoverage.toFixed(3)),
          recentRobotCount: robotEntries.length,
        });
        return true;
      }
    }

    if (isSpeakerEchoRiskTrace(trace)) {
      const provider = String(trace.provider || '');
      const confidence = Number(trace.confidence);
      const detectedLanguage = normalizeMobileAutoDetectLanguage(trace.detectedLanguage);
      const ttsLang = normalizeMobileAutoDetectLanguage(trace.ttsLang || activeTtsLangRef.current);
      const verifierBacked = provider === 'whisper-verified' ||
        provider === 'whisper-only' ||
        provider === 'azure-verified';
      const lowConfidenceAzure = provider.startsWith('azure') &&
        (!Number.isFinite(confidence) || confidence < ECHO_RISK_UNVERIFIED_CONFIDENCE_LIMIT);
      const sameAsTtsLangWithoutVerifier = provider.startsWith('azure') &&
        !verifierBacked &&
        Boolean(ttsLang && detectedLanguage === ttsLang);

      logPerformance(trace.requestId || 'sim-echo', 'echo_check', {
        risk: 'speaker-overlap',
        provider,
        confidence: Number.isFinite(confidence) ? Number(confidence.toFixed(3)) : null,
        detectedLanguage,
        ttsLang,
        verifierBacked,
        androidAec: Boolean(trace.androidAec),
        recentRobotCount: robotEntries.length,
        bestRobotRequestId: bestMatch?.requestId || null,
        bestRobotLang: bestMatch?.lang || null,
        bestFullSimilarity: bestMatch ? Number(bestMatch.fullSimilarity.toFixed(3)) : null,
        bestCandidateCoverage: bestMatch ? Number(bestMatch.candidateCoverage.toFixed(3)) : null,
      });

      if (!verifierBacked && (lowConfidenceAzure || sameAsTtsLangWithoutVerifier)) {
        logPerformance(trace.requestId || 'sim-echo', 'echo_risk_dropped', {
          reason: lowConfidenceAzure ? 'low-confidence-azure-during-tts' : 'same-language-as-tts',
          provider,
          confidence: Number.isFinite(confidence) ? Number(confidence.toFixed(3)) : null,
          detectedLanguage,
          ttsLang,
          androidAec: Boolean(trace.androidAec),
        });
        return true;
      }
    }

    return false;
  };

  const enqueueTranslationTask = (text, langType, detectedLangOverride = null, trace = {}) => {
    if (autoDetectRef.current && (stoppingRef.current || !isActiveRef.current)) {
      return false;
    }

    const cleanedText = (text || '').replace(/\s+/g, ' ').trim();
    if (!cleanedText) return false;

    if (shouldDropCandidate(cleanedText, {
      ...trace,
      detectedLanguage: normalizeMobileAutoDetectLanguage(detectedLangOverride),
    })) {
      setStatusText('Đã bỏ qua tiếng vọng hoặc câu quá ngắn.');
      return false;
    }

    const { inputLang, outputLang } = resolveDirection(langType, cleanedText, detectedLangOverride);
    const task = {
      id: `${Date.now()}-${translationQueueRef.current.length}`,
      captureSession: captureSessionRef.current,
      requestId: trace.requestId || `sim-${Date.now().toString(36)}`,
      trace,
      text: cleanedText,
      fromLang: inputLang.translateCode,
      toLang: outputLang.translateCode,
      inputLang,
      outputLang,
    };

    translationQueueRef.current.push(task);
    lastQueuedTextRef.current = cleanedText;
    setQueueLength(translationQueueRef.current.length);
    processTranslationQueue();
    return true;
  };

  const commitRecognitionResult = (sequence, result) => {
    if (
      stoppingRef.current ||
      !isActiveRef.current ||
      captureSessionRef.current !== result.captureSession
    ) {
      return;
    }

    pendingRecognitionResultsRef.current.set(sequence, result);

    while (pendingRecognitionResultsRef.current.has(nextRecognitionCommitRef.current)) {
      const nextSequence = nextRecognitionCommitRef.current;
      const nextResult = pendingRecognitionResultsRef.current.get(nextSequence);
      pendingRecognitionResultsRef.current.delete(nextSequence);
      nextRecognitionCommitRef.current += 1;

      if (nextResult.error) {
        console.warn(`[PERF ${nextResult.requestId}] stt_failed:`, nextResult.error);
        continue;
      }

      const recognizedText = (nextResult.sttResult?.text || '').trim();
      logPerformance(nextResult.requestId, 'stt_committed', {
        sequence: nextSequence,
        commitWaitMs: Date.now() - nextResult.sttFinishedAt,
        provider: nextResult.sttResult?.provider || null,
        language: nextResult.sttResult?.language || null,
        textLength: recognizedText.length,
      });

      const accepted = enqueueTranslationTask(
        recognizedText,
        nextResult.langType,
        normalizeMobileAutoDetectLanguage(nextResult.sttResult?.language),
        {
          requestId: nextResult.requestId,
          captureStartedAt: nextResult.captureStartedAt,
          speechEndedAt: nextResult.speechEndedAt,
          captureStoppedAt: nextResult.captureStoppedAt,
          sttStartedAt: nextResult.sttStartedAt,
          sttFinishedAt: nextResult.sttFinishedAt,
          recordedDuringTts: nextResult.recordedDuringTts,
          ttsLang: nextResult.ttsLang,
          androidAec: nextResult.androidAec,
          provider: nextResult.sttResult?.provider || null,
          confidence: nextResult.sttResult?.confidence ?? null,
        }
      );

      if (accepted && recognizedText) {
        setLiveText(recognizedText);
        liveTextRef.current = recognizedText;
      } else if (recognizedText) {
        resetLiveText();
        logPerformance(nextResult.requestId, 'stt_dropped_before_display', {
          provider: nextResult.sttResult?.provider || null,
          language: nextResult.sttResult?.language || null,
          textLength: recognizedText.length,
        });
      }
    }
  };

  const stopRecognitionAndQueue = async (langType) => {
    clearSilenceTimer();
    if (!isRecordingRef.current) return;

    const captureSession = captureSessionRef.current;
    const isAzureAutoCapture = autoDetectRef.current && langType === 'auto' && audioRecordingRef.current;
    let restartScheduled = false;
    isRecordingRef.current = false;
    setIsSpeechActive(false);

    try {
      if (isAzureAutoCapture) {
        const capture = await stopAzureAutoRecording();
        resetLiveText();

        if (
          stoppingRef.current ||
          !isActiveRef.current ||
          captureSessionRef.current !== captureSession
        ) {
          return;
        }

        if (overlapListeningRef.current) {
          restartScheduled = true;
          setTimeout(() => {
            if (
              !stoppingRef.current &&
              captureSessionRef.current === captureSession &&
              isActiveRef.current
            ) {
              startContinuousMicLoop(langType);
            }
          }, 50);
        }

        // Guard: bail out early if recording produced no usable file
        if (!capture.audioUri) {
          console.warn('[SimultaneousPanel] Azure auto recording returned no audio file.');
          setStatusText('Không thu được âm, thử lại...');
        } else if (capture.hasSpeech) {
          const sequence = ++recognitionSequenceRef.current;
          const requestId = `sim-${captureSession}-${sequence}-${Date.now().toString(36)}`;
          const sttStartedAt = Date.now();
          const echoRiskCapture = isSpeakerEchoRiskTrace({
            recordedDuringTts: capture.recordedDuringTts,
            ttsLang: capture.ttsLang,
          });
          logPerformance(requestId, 'capture_stopped', {
            sequence,
            captureMs: capture.stoppedAt - capture.startedAt,
            silenceMs: capture.stoppedAt - capture.lastSpeechAt,
            recordedDuringTts: capture.recordedDuringTts,
            ttsLang: capture.ttsLang,
            androidAec: capture.androidAec,
            echoRiskCapture,
            micRestartScheduled: restartScheduled,
          });
          setStatusText('Azure Auto đang nhận dạng...');
          const srcLang = LANGUAGES[srcIdx];
          const tgtLang = LANGUAGES[tgtIdx];
          try {
            const sttResult = await api.transcribeAudio({
              audioUri: capture.audioUri,
              srcLang: srcLang.translateCode,
              tgtLang: tgtLang.translateCode,
              mode: 'conversation',
              provider: 'azure',
              fallbackProvider: 'whisper',
              requestId,
              allowEarlyAzure: !echoRiskCapture,
            });
            const sttFinishedAt = Date.now();
            logPerformance(requestId, 'stt_finished', {
              sttMs: sttFinishedAt - sttStartedAt,
              provider: sttResult.provider,
              language: sttResult.language,
              textLength: (sttResult.text || '').trim().length,
              timings: sttResult.timings || null,
            });
            commitRecognitionResult(sequence, {
              requestId,
              captureSession,
              langType,
              captureStartedAt: capture.startedAt,
              speechEndedAt: capture.lastSpeechAt,
              captureStoppedAt: capture.stoppedAt,
              sttStartedAt,
              sttFinishedAt,
              recordedDuringTts: capture.recordedDuringTts,
              ttsLang: capture.ttsLang,
              androidAec: capture.androidAec,
              sttResult,
            });
          } catch (sttError) {
            commitRecognitionResult(sequence, {
              requestId,
              captureSession,
              langType,
              sttFinishedAt: Date.now(),
              error: sttError,
            });
          }
        }
        return;
      }

      await Voice.stop();
      await new Promise(resolve => setTimeout(resolve, 300));

      if (
        autoDetectRef.current &&
        (stoppingRef.current || !isActiveRef.current || captureSessionRef.current !== captureSession)
      ) {
        return;
      }

      const textToTranslate = liveTextRef.current;
      resetLiveText();

      const requestId = `sim-${Date.now().toString(36)}`;
      logPerformance(requestId, 'manual_stt_final', {
        langType,
        text: textToTranslate,
        textLength: (textToTranslate || '').trim().length,
        recordedDuringTts: recordingDuringTtsRef.current,
        ttsLang: recordingTtsLangRef.current,
        confidence: manualRecognitionConfidenceRef.current,
      });
      const hasQueued = enqueueTranslationTask(textToTranslate, langType, null, {
        requestId,
        recordedDuringTts: recordingDuringTtsRef.current,
        ttsLang: recordingTtsLangRef.current,
        provider: 'android-speech',
        confidence: manualRecognitionConfidenceRef.current,
      });
      if (!hasQueued && isActiveRef.current && !isTtsPlayingRef.current) {
        setStatusText(langType === 'auto' ? 'Live Auto đang nghe...' : 'Mic đang nghe...');
      }
    } catch (error) {
      console.error('Failed to stop Voice recording inside SimultaneousPanel:', error);
      isRecordingRef.current = false;
    } finally {
      if (
        !stoppingRef.current &&
        captureSessionRef.current === captureSession &&
        isActiveRef.current &&
        overlapListeningRef.current &&
        !restartScheduled
      ) {
        setTimeout(() => {
          if (!stoppingRef.current && captureSessionRef.current === captureSession) {
            startContinuousMicLoop(langType);
          }
        }, 150);
      } else if (
        !stoppingRef.current &&
        captureSessionRef.current === captureSession &&
        isActiveRef.current &&
        !isTtsPlayingRef.current &&
        translationQueueRef.current.length === 0
      ) {
        setTimeout(() => {
          if (!stoppingRef.current && captureSessionRef.current === captureSession) {
            startContinuousMicLoop(langType);
          }
        }, 500);
      }
    }
  };

  const processTranslationQueue = async () => {
    if (isProcessingQueueRef.current) return;
    if (!translationQueueRef.current.length) return;

    isProcessingQueueRef.current = true;
    setIsProcessing(true);

    try {
      while (translationQueueRef.current.length > 0) {
        const task = translationQueueRef.current[0];
        try {
          setStatusText(`Đang dịch ${task.inputLang.name} -> ${task.outputLang.name}...`);

          const historyContext = chatLogRef.current.slice(-4).flatMap((msg) => ([
            { role: msg.isUser ? 'user' : 'assistant', content: msg.sourceText },
            { role: msg.isUser ? 'assistant' : 'user', content: msg.translatedText },
          ]));

          const translateStartedAt = Date.now();
          logPerformance(task.requestId, 'translate_started', {
            queueWaitMs: translateStartedAt - (task.trace.sttFinishedAt || translateStartedAt),
            speechEndToTranslateMs: task.trace.speechEndedAt
              ? translateStartedAt - task.trace.speechEndedAt
              : null,
            queueLength: translationQueueRef.current.length,
          });
          const translation = await api.translateText({
            text: task.text,
            sourceLang: task.fromLang,
            targetLang: task.toLang,
            engine: selectedModel,
            apiKey,
            history: historyContext,
            requestId: task.requestId,
          });
          const translateFinishedAt = Date.now();
          logPerformance(task.requestId, 'translate_finished', {
            translateMs: translateFinishedAt - translateStartedAt,
            speechEndToTranslationMs: task.trace.speechEndedAt
              ? translateFinishedAt - task.trace.speechEndedAt
              : null,
          });

          if (
            autoDetectRef.current &&
            (
              stoppingRef.current ||
              !isActiveRef.current ||
              captureSessionRef.current !== task.captureSession
            )
          ) {
            continue;
          }

          if (autoDetectRef.current && !isTextLikelyLanguage(translation, task.toLang)) {
            console.warn(
              `Simultaneous translation ignored: output did not look like ${task.toLang}.`,
              { fromLang: task.fromLang, toLang: task.toLang, text: task.text, translation }
            );
            setStatusText('Đã bỏ qua bản dịch sai ngôn ngữ.');
            continue;
          }

          const newEntry = {
            id: task.id,
            sourceText: task.text,
            translatedText: translation,
            isUser: task.fromLang === LANGUAGES[srcIdx].translateCode,
            fromLang: task.fromLang,
            toLang: task.toLang,
            time: new Date().toLocaleTimeString('vi-VN', { hour: '2-digit', minute: '2-digit' }),
          };

          setChatLog((prev) => {
            const next = [...prev, newEntry];
            chatLogRef.current = next;
            return next;
          });
          if (
            autoDetectRef.current &&
            normalizeForComparison(liveTextRef.current) === normalizeForComparison(task.text)
          ) {
            resetLiveText();
          }

          if (user?.username) {
            api.saveHistory({
              userId: user.username,
              source: task.text,
              target: translation,
              fromLang: task.fromLang,
              toLang: task.toLang,
            }).catch((historyError) => {
              console.warn('Simultaneous history save failed:', historyError);
            });
          }

          const outputIsSrc = task.toLang === LANGUAGES[srcIdx].translateCode;
          const isMuted = outputIsSrc ? muteSrcRef.current : muteTgtRef.current;
          const currentVoice = getSafeVoiceForLang(
            providerRef.current,
            task.toLang,
            outputIsSrc ? srcVoiceRef.current : tgtVoiceRef.current
          );

          if (isActiveRef.current && autoTTSRef.current && !isMuted) {
            ttsSessionRef.current += 1;
            activeTtsLangRef.current = task.toLang;
            await playSimultaneousTts(
              translation,
              task.outputLang.ttsCode,
              currentVoice,
              task.requestId,
              task.trace.speechEndedAt,
              task.toLang,
              task.text
            );
          }
        } catch (error) {
          console.warn('Simultaneous translation failed:', error);
          setStatusText('Lỗi dịch, mic sẽ tiếp tục nghe.');
        } finally {
          scheduleClearActiveTtsGuard();
          await restoreTtsVolume();
          if (translationQueueRef.current[0]?.id === task.id) {
            translationQueueRef.current.shift();
          }
          setQueueLength(translationQueueRef.current.length);
        }
      }
    } finally {
      isProcessingQueueRef.current = false;
      setIsProcessing(false);
      if (isActiveRef.current) {
        setStatusText(activeInputLangRef.current === 'auto' ? 'Live Auto đang nghe...' : 'Mic đang nghe...');
        if (!overlapListeningRef.current && !isRecordingRef.current && !isTtsPlayingRef.current) {
          const restartDelay = useHeadphonesRef.current
            ? MIC_RESTART_AFTER_TTS_HEADPHONES_MS
            : MIC_RESTART_AFTER_TTS_SPEAKER_MS;
          setTimeout(() => {
            if (
              isActiveRef.current &&
              !overlapListeningRef.current &&
              !isRecordingRef.current &&
              !isTtsPlayingRef.current
            ) {
              startContinuousMicLoop(activeInputLangRef.current || getFallbackLangType());
            }
          }, restartDelay);
        }
      }
    }
  };

  const duckTtsVolume = async () => {
    if (!overlapListeningRef.current || !isTtsPlayingRef.current || !soundInstanceRef.current) return;

    const targetVolume = useHeadphonesRef.current
      ? TTS_DUCK_VOLUME_HEADPHONES
      : (autoDetectRef.current ? TTS_DUCK_VOLUME_AUTO_SPEAKER : TTS_DUCK_VOLUME_SPEAKER);

    if (currentDuckVolumeRef.current === targetVolume) return;

    try {
      await soundInstanceRef.current.setVolumeAsync(targetVolume);
      currentDuckVolumeRef.current = targetVolume;
    } catch (error) {
      console.warn('Simultaneous TTS ducking failed:', error);
    }
  };

  const restoreTtsVolume = async () => {
    const sound = soundInstanceRef.current;
    currentDuckVolumeRef.current = null;
    if (!sound) return;

    try {
      const status = await sound.getStatusAsync();
      if (status?.isLoaded) {
        await sound.setVolumeAsync(1);
      }
    } catch (error) {
      // Sound may have been unloaded between check and set — ignore
    }
  };

  const scheduleClearActiveTtsGuard = () => {
    if (!activeTtsLangRef.current) return;
    if (!autoDetectRef.current) {
      activeTtsLangRef.current = null;
      return;
    }
    const sessionAtFinish = ttsSessionRef.current;
    const guardDelay = overlapListeningRef.current && !useHeadphonesRef.current ? 6000 : 1500;
    setTimeout(() => {
      if (ttsSessionRef.current === sessionAtFinish) {
        activeTtsLangRef.current = null;
      }
    }, guardDelay);
  };

  const playSimultaneousTts = async (
    text,
    lang,
    voice,
    requestId = null,
    speechEndedAt = null,
    robotLang = null,
    sourceText = ''
  ) => {
    const traceId = requestId || `tts-${Date.now().toString(36)}`;
    const ttsStartedAt = Date.now();
    try {
      await stopAudio();
      await restoreTtsVolume();

      const audioSource = await api.getTtsAudioSource({
        text,
        lang,
        voice,
        provider: providerRef.current,
        requestId: traceId,
      });

      rememberRobotSpeech({
        requestId: traceId,
        text,
        lang: robotLang || lang,
        sourceText,
      });

      await Audio.setAudioModeAsync({
        allowsRecordingIOS: true,
        playsInSilentModeIOS: true,
        shouldDuckAndroid: true,
        playThroughEarpieceAndroid: false,
      });

      const initialVolume = overlapListeningRef.current && !useHeadphonesRef.current
        ? (autoDetectRef.current
            ? TTS_DUCK_VOLUME_AUTO_SPEAKER
            : TTS_DUCK_VOLUME_SPEAKER)
        : 1;

      const { sound: newSound } = await Audio.Sound.createAsync(
        audioSource,
        { shouldPlay: true, volume: initialVolume }
      );
      const playbackStartedAt = Date.now();
      logPerformance(traceId, 'tts_ready', {
        ttsReadyMs: playbackStartedAt - ttsStartedAt,
        speechEndToTtsReadyMs: speechEndedAt ? playbackStartedAt - speechEndedAt : null,
        provider: providerRef.current,
        initialVolume,
        autoDetect: autoDetectRef.current,
        useHeadphones: useHeadphonesRef.current,
      });
      currentDuckVolumeRef.current = initialVolume < 1 ? initialVolume : null;
      if (overlapListeningRef.current && isRecordingRef.current) {
        recordingDuringTtsRef.current = true;
        recordingTtsLangRef.current = activeTtsLangRef.current;
      }

      if (speedRef.current !== 1.0) {
        try {
          await newSound.setRateAsync(speedRef.current, true);
        } catch (e) {}
      }

      soundInstanceRef.current = newSound;
      setSound(newSound);
      setIsPlaying(true);
      isTtsPlayingRef.current = true;

      await new Promise((resolve) => {
        let resolved = false;
        let safetyTimeout = null;

        const finish = async () => {
          if (resolved) return;
          resolved = true;
          if (safetyTimeout) clearTimeout(safetyTimeout);
          await restoreTtsVolume();
          setIsPlaying(false);
          isTtsPlayingRef.current = false;
          setSound(null);
          if (soundInstanceRef.current === newSound) {
            soundInstanceRef.current = null;
          }
          try {
            await newSound.unloadAsync();
          } catch (e) {}
          logPerformance(traceId, 'tts_finished', {
            playbackMs: Date.now() - playbackStartedAt,
            ttsTotalMs: Date.now() - ttsStartedAt,
          });
          resolve();
        };

        safetyTimeout = setTimeout(finish, 20000);

        newSound.setOnPlaybackStatusUpdate((status) => {
          if (!status?.isLoaded) {
            finish();
            return;
          }

          if (status?.didJustFinish) {
            finish();
            return;
          }

        });
      });
    } catch (error) {
      console.warn(`[PERF ${traceId}] tts_failed:`, error);
      setIsPlaying(false);
      isTtsPlayingRef.current = false;
      await restoreTtsVolume();
      scheduleClearActiveTtsGuard();
    }
  };

  const handleReplay = async (text, toLang) => {
    const isSrc = toLang === LANGUAGES[srcIdx].translateCode;
    const lang = isSrc ? LANGUAGES[srcIdx] : LANGUAGES[tgtIdx];
    const voice = getSafeVoiceForLang(provider, lang.translateCode, isSrc ? srcVoice : tgtVoice);
    await playSimultaneousTts(text, lang.ttsCode, voice);
  };

  const srcLangCode = LANGUAGES[srcIdx].translateCode;
  const tgtLangCode = LANGUAGES[tgtIdx].translateCode;
  const azureVoicesSrc = VOICE_OPTIONS_AZURE[srcLangCode] || [];
  const azureVoicesTgt = VOICE_OPTIONS_AZURE[tgtLangCode] || [];
  const voicesListSrc = provider === 'elevenlabs' ? VOICE_OPTIONS_ELEVENLABS : azureVoicesSrc;
  const voicesListTgt = provider === 'elevenlabs' ? VOICE_OPTIONS_ELEVENLABS : azureVoicesTgt;
  const controlsLocked = isActive || isProcessing;
  const providerLocked = controlsLocked || autoDetect;
  const isAutoActive = isActive && activeInputLang === 'auto';
  const isSrcActive = isActive && activeInputLang === 'src';
  const isTgtActive = isActive && activeInputLang === 'tgt';

  const handleAutoDetectToggle = (value) => {
    if (controlsLocked) return;
    if (value) setProvider('azure');
    setAutoDetect(value);
  };

  return (
    <View style={styles.container}>
      <View style={styles.headerBar}>
        <View style={styles.speakerRow}>
          <TouchableOpacity
            style={[styles.speakerBtn, muteSrc && styles.speakerBtnMuted]}
            onPress={() => setMuteSrc(!muteSrc)}
          >
            <View style={styles.speakerBtnInner}>
              <Text style={{ fontSize: 13 }}>{LANGUAGES[srcIdx].flag}</Text>
              <Feather name={muteSrc ? 'volume-x' : 'volume-2'} size={13} color={colors.text} />
            </View>
          </TouchableOpacity>
          <TouchableOpacity
            style={[styles.speakerBtn, muteTgt && styles.speakerBtnMuted]}
            onPress={() => setMuteTgt(!muteTgt)}
          >
            <View style={styles.speakerBtnInner}>
              <Text style={{ fontSize: 13 }}>{LANGUAGES[tgtIdx].flag}</Text>
              <Feather name={muteTgt ? 'volume-x' : 'volume-2'} size={13} color={colors.text} />
            </View>
          </TouchableOpacity>
        </View>

        <Text style={styles.headerTitle}>Giao tiếp song song</Text>

        <TouchableOpacity style={styles.settingsBtn} onPress={() => setSettingsVisible(true)}>
          <Feather name="settings" size={16} color={colors.text} />
        </TouchableOpacity>
      </View>

      <View style={styles.chatStage}>
      <ScrollView
        ref={scrollViewRef}
        onContentSizeChange={() => scrollViewRef.current?.scrollToEnd({ animated: true })}
        style={styles.chatLog}
        contentContainerStyle={styles.chatListContent}
      >
        {chatLog.length === 0 ? (
          <View style={styles.emptyContainer}>
            <View style={styles.emptyIconWrapper}>
              <Feather name="mic" size={24} color={colors.accent1} />
            </View>
            <Text style={styles.emptyTextTitle}>Giao tiếp song song</Text>
            <Text style={styles.emptyTextSub}>
              Hệ thống thu âm liên tục. Khi bạn im lặng, câu nói sẽ tự động dịch tuần tự mà không ngắt mic.
            </Text>
          </View>
        ) : (
          chatLog.map((chat) => (
            <View key={chat.id} style={[styles.bubbleContainer, chat.isUser ? styles.bubbleRight : styles.bubbleLeft]}>
              <View style={[styles.bubbleCard, chat.isUser ? styles.cardUser : styles.cardPartner]}>
                <Text style={[styles.bubbleSource, { fontSize: fontSize - 2 }]}>{chat.sourceText}</Text>
                <View style={styles.bubbleFooter}>
                  <Text style={[styles.bubbleTarget, { fontSize }]}>{chat.translatedText}</Text>
                  <TouchableOpacity
                    onPress={() => handleReplay(chat.translatedText, chat.toLang)}
                    style={[styles.replayBtn, chat.isUser ? styles.replayBtnUser : styles.replayBtnPartner]}
                  >
                    <Feather
                      name="volume-2"
                      size={14}
                      color={chat.isUser ? colors.accent1 : colors.success}
                    />
                  </TouchableOpacity>
                </View>
                <Text style={styles.bubbleTime}>{chat.time}</Text>
              </View>
            </View>
          ))
        )}
        {liveText.trim() !== '' && (
          <View style={[styles.bubbleContainer, activeInputLang === 'tgt' ? styles.bubbleLeft : styles.bubbleRight]}>
            <View style={[styles.bubbleCard, activeInputLang === 'tgt' ? styles.cardPartner : styles.cardUser, styles.liveBubble]}>
              <Text style={[styles.bubbleSource, { fontSize, fontStyle: 'italic' }]}>
                {liveText}...
              </Text>
            </View>
          </View>
        )}
        {isProcessing && (
          <View style={styles.loadingBubble}>
            <ActivityIndicator size="small" color={colors.accent1} />
            <Text style={styles.loadingText}>
              {queueLength > 0 ? `Đang xử lý ${queueLength} lượt...` : 'Đang dịch...'}
            </Text>
          </View>
        )}
      </ScrollView>

      <View style={styles.actionArea}>
        <View style={styles.bottomMicCard}>
          {autoDetect ? (
            <View style={styles.singleMicContainer}>
              <View style={styles.circleMicWrapper}>
                {isAutoActive && (
                  <MicrophonePulse isRecording={true} color={colors.danger} size={64} />
                )}
                <TouchableOpacity
                  activeOpacity={0.85}
                  style={[
                    styles.circleMicBtn,
                    styles.circleMicBtnAuto,
                    isAutoActive && styles.circleMicBtnActive,
                  ]}
                  onPress={() => handlePressMic('auto')}
                >
                  <Feather name={isActive ? 'square' : 'mic'} size={22} color="#fff" />
                </TouchableOpacity>
              </View>
              <Text style={[styles.circleMicLabel, isAutoActive && styles.circleMicLabelActive]}>
                Live Auto
              </Text>
            </View>
          ) : (
            <>
              <View style={styles.circleMicColumn}>
                <View style={styles.circleMicWrapper}>
                  {isSrcActive && (
                    <MicrophonePulse isRecording={true} color={colors.danger} size={64} />
                  )}
                  <TouchableOpacity
                    activeOpacity={0.85}
                    style={[
                      styles.circleMicBtn,
                      styles.circleMicBtnSource,
                      isSrcActive && styles.circleMicBtnActive,
                      (isTgtActive || isProcessing) && styles.circleMicBtnDisabled,
                    ]}
                    disabled={isTgtActive || isProcessing}
                    onPress={() => handlePressMic('src')}
                  >
                    <Feather name={isSrcActive ? 'square' : 'mic'} size={22} color="#fff" />
                  </TouchableOpacity>
                </View>
                <Text style={[styles.circleMicLabel, isSrcActive && styles.circleMicLabelActive]}>
                  {LANGUAGES[srcIdx].flag} {LANGUAGES[srcIdx].name}
                </Text>
              </View>

              <View style={styles.micCenterSeparator}>
                <Feather name="chevron-right" size={14} color={colors.muted} />
                <Text style={styles.micCenterText}>Chọn Mic</Text>
              </View>

              <View style={styles.circleMicColumn}>
                <View style={styles.circleMicWrapper}>
                  {isTgtActive && (
                    <MicrophonePulse isRecording={true} color={colors.danger} size={64} />
                  )}
                  <TouchableOpacity
                    activeOpacity={0.85}
                    style={[
                      styles.circleMicBtn,
                      styles.circleMicBtnTarget,
                      isTgtActive && styles.circleMicBtnActive,
                      (isSrcActive || isProcessing) && styles.circleMicBtnDisabled,
                    ]}
                    disabled={isSrcActive || isProcessing}
                    onPress={() => handlePressMic('tgt')}
                  >
                    <Feather name={isTgtActive ? 'square' : 'mic'} size={22} color="#fff" />
                  </TouchableOpacity>
                </View>
                <Text style={[styles.circleMicLabel, isTgtActive && styles.circleMicLabelActive]}>
                  {LANGUAGES[tgtIdx].flag} {LANGUAGES[tgtIdx].name}
                </Text>
              </View>
            </>
          )}
        </View>
      </View>
      </View>

      <Modal
        animationType="slide"
        transparent={true}
        visible={settingsVisible}
        onRequestClose={() => setSettingsVisible(false)}
      >
        <View style={styles.modalOverlay}>
          <View style={styles.modalCard}>
            <View style={styles.modalHeader}>
              <Text style={styles.modalTitle}>Cài đặt Giao tiếp song song</Text>
              <TouchableOpacity onPress={() => setSettingsVisible(false)} style={styles.closeBtn}>
                <Text style={styles.closeBtnText}>×</Text>
              </TouchableOpacity>
            </View>

            <ScrollView contentContainerStyle={styles.modalBody}>
              <View style={styles.settingItem}>
                <Text style={styles.settingLabel}>Cỡ chữ: {fontSize}px</Text>
                <View style={styles.adjustRow}>
                  <TouchableOpacity onPress={() => setFontSize(Math.max(12, fontSize - 1))} style={styles.adjustBtn}>
                    <Text style={styles.adjustBtnText}>-</Text>
                  </TouchableOpacity>
                  <TouchableOpacity onPress={() => setFontSize(Math.min(28, fontSize + 1))} style={styles.adjustBtn}>
                    <Text style={styles.adjustBtnText}>+</Text>
                  </TouchableOpacity>
                </View>
              </View>

              <View style={styles.settingItem}>
                <Text style={styles.sectionTitle}>Nhận dạng giọng nói (STT)</Text>
                <View style={styles.btnGroup}>
                  <View style={[styles.btnGroupItem, styles.btnGroupItemActive]}>
                    <Text style={styles.btnGroupText}>{autoDetect ? 'Azure Auto' : 'Native Speech'}</Text>
                  </View>
                </View>
              </View>

              <View style={styles.settingItem}>
                <Text style={styles.sectionTitle}>TTS Provider</Text>
                <View style={styles.btnGroup}>
                  <TouchableOpacity
                    style={[styles.btnGroupItem, provider === 'azure' && styles.btnGroupItemActive, providerLocked && styles.btnGroupItemDisabled]}
                    onPress={() => !providerLocked && setProvider('azure')}
                    disabled={providerLocked}
                  >
                    <Text style={styles.btnGroupText}>Azure</Text>
                  </TouchableOpacity>
                  <TouchableOpacity
                    style={[styles.btnGroupItem, provider === 'elevenlabs' && styles.btnGroupItemActive, providerLocked && styles.btnGroupItemDisabled]}
                    onPress={() => !providerLocked && setProvider('elevenlabs')}
                    disabled={providerLocked}
                  >
                    <Text style={styles.btnGroupText}>ElevenLabs</Text>
                  </TouchableOpacity>
                </View>
              </View>

              <View style={styles.settingItem}>
                <Text style={styles.settingLabel}>Tốc độ phát giọng nói: {speed.toFixed(1)}x</Text>
                <View style={styles.adjustRow}>
                  <TouchableOpacity
                    onPress={() => !controlsLocked && setSpeed(Math.max(0.8, Math.round((speed - 0.1) * 10) / 10))}
                    style={[styles.adjustBtn, controlsLocked && styles.controlDisabled]}
                    disabled={controlsLocked}
                  >
                    <Text style={styles.adjustBtnText}>-</Text>
                  </TouchableOpacity>
                  <TouchableOpacity
                    onPress={() => !controlsLocked && setSpeed(Math.min(2.0, Math.round((speed + 0.1) * 10) / 10))}
                    style={[styles.adjustBtn, controlsLocked && styles.controlDisabled]}
                    disabled={controlsLocked}
                  >
                    <Text style={styles.adjustBtnText}>+</Text>
                  </TouchableOpacity>
                </View>
              </View>

              <View style={styles.settingItem}>
                <Text style={styles.sectionTitle}>Cấu hình liên tục</Text>
                <View style={[styles.switchRow, controlsLocked && styles.controlDisabled]}>
                  <Text style={styles.settingLabel}>Tự nhận dạng ngôn ngữ</Text>
                  <Switch
                    value={autoDetect}
                    onValueChange={handleAutoDetectToggle}
                    disabled={controlsLocked}
                    trackColor={{ true: colors.selectedSolid || colors.accent1 }}
                  />
                </View>

                <View style={[styles.switchRow, controlsLocked && styles.controlDisabled]}>
                  <Text style={styles.settingLabel}>Tự phát giọng sau dịch</Text>
                  <Switch
                    value={autoTTS}
                    onValueChange={(value) => !controlsLocked && setAutoTTS(value)}
                    disabled={controlsLocked}
                    trackColor={{ true: colors.selectedSolid || colors.accent1 }}
                  />
                </View>

                <View style={[styles.switchRow, !autoTTS && styles.controlDisabled]}>
                  <Text style={styles.settingLabel}>Nghe đè khi phát (Chống vọng AI)</Text>
                  <Switch
                    value={overlapListening}
                    onValueChange={setOverlapListening}
                    disabled={!autoTTS}
                    trackColor={{ true: colors.selectedSolid || colors.accent1 }}
                  />
                </View>

                {overlapListening && (
                  <View style={styles.switchRow}>
                    <Text style={styles.settingLabel}>Tôi đang đeo tai nghe</Text>
                    <Switch
                      value={useHeadphones}
                      onValueChange={setUseHeadphones}
                      trackColor={{ true: colors.selectedSolid || colors.accent1 }}
                    />
                  </View>
                )}
              </View>

              {autoTTS && (
                <View style={[
                  styles.warningBox,
                  autoDetect && overlapListening && !useHeadphones && styles.warningBoxDanger,
                ]}>
                  <Text style={[
                    styles.warningText,
                    autoDetect && overlapListening && !useHeadphones && styles.warningTextDanger,
                  ]}>
                    {autoDetect && overlapListening
                      ? (useHeadphones
                          ? 'Tự nhận dạng + tai nghe: âm lượng phát dịch hạ xuống 80% khi bạn nói.'
                          : 'Khuyên dùng tai nghe: dùng loa ngoài khi tự nhận dạng + nghe đè dễ tạo vòng lặp vọng âm.')
                      : 'Khuyên dùng khoảng im lặng 2s - 3s để giao tiếp song song bám đuổi tốt hơn.'}
                  </Text>
                </View>
              )}

              <View style={styles.settingItem}>
                <Text style={styles.settingLabel}>Im lặng dịch: {silenceSeconds.toFixed(1)}s</Text>
                <View style={styles.adjustRow}>
                  <TouchableOpacity
                    onPress={() => !controlsLocked && setSilenceSeconds(clampSilenceSeconds(silenceSeconds - 0.5))}
                    style={[styles.adjustBtn, controlsLocked && styles.controlDisabled]}
                    disabled={controlsLocked}
                  >
                    <Text style={styles.adjustBtnText}>-</Text>
                  </TouchableOpacity>
                  <TouchableOpacity
                    onPress={() => !controlsLocked && setSilenceSeconds(clampSilenceSeconds(silenceSeconds + 0.5))}
                    style={[styles.adjustBtn, controlsLocked && styles.controlDisabled]}
                    disabled={controlsLocked}
                  >
                    <Text style={styles.adjustBtnText}>+</Text>
                  </TouchableOpacity>
                </View>
              </View>

              <View style={styles.voiceSection}>
                <Text style={styles.settingLabel}>{LANGUAGES[srcIdx].flag} Giọng {LANGUAGES[srcIdx].name}</Text>
                <ScrollView style={styles.voiceScroll} nestedScrollEnabled>
                  {voicesListSrc.map((voice) => (
                    <TouchableOpacity
                      key={voice.id}
                      style={[styles.voiceItem, srcVoice === voice.id && styles.voiceItemActive, controlsLocked && styles.controlDisabled]}
                      onPress={() => !controlsLocked && setSrcVoice(voice.id)}
                      disabled={controlsLocked}
                    >
                      <Text style={[styles.voiceItemText, srcVoice === voice.id && styles.voiceItemTextActive]}>
                        {voice.label}
                      </Text>
                    </TouchableOpacity>
                  ))}
                </ScrollView>
              </View>

              <View style={styles.voiceSection}>
                <Text style={styles.settingLabel}>{LANGUAGES[tgtIdx].flag} Giọng {LANGUAGES[tgtIdx].name}</Text>
                <ScrollView style={styles.voiceScroll} nestedScrollEnabled>
                  {voicesListTgt.map((voice) => (
                    <TouchableOpacity
                      key={voice.id}
                      style={[styles.voiceItem, tgtVoice === voice.id && styles.voiceItemActive, controlsLocked && styles.controlDisabled]}
                      onPress={() => !controlsLocked && setTgtVoice(voice.id)}
                      disabled={controlsLocked}
                    >
                      <Text style={[styles.voiceItemText, tgtVoice === voice.id && styles.voiceItemTextActive]}>
                        {voice.label}
                      </Text>
                    </TouchableOpacity>
                  ))}
                </ScrollView>
              </View>
            </ScrollView>

            <TouchableOpacity style={styles.saveBtn} onPress={() => setSettingsVisible(false)}>
              <Text style={styles.saveBtnText}>Lưu & Đóng</Text>
            </TouchableOpacity>
          </View>
        </View>
      </Modal>
    </View>
  );
}

const getStyles = (colors) => StyleSheet.create({
  container: {
    flex: 1,
  },
  headerBar: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginBottom: 10,
  },
  speakerRow: {
    flexDirection: 'row',
    gap: 8,
  },
  speakerBtn: {
    backgroundColor: 'rgba(255,255,255,0.05)',
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: SIZES.radiusSm,
    paddingVertical: 6,
    paddingHorizontal: 10,
  },
  speakerBtnMuted: {
    borderColor: colors.danger,
    backgroundColor: 'rgba(239,68,68,0.1)',
  },
  speakerBtnInner: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
  },
  headerTitle: {
    fontSize: 14,
    fontWeight: 'bold',
    color: colors.text,
  },
  settingsBtn: {
    backgroundColor: colors.bg2,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: SIZES.radiusSm,
    width: 32,
    height: 32,
    alignItems: 'center',
    justifyContent: 'center',
  },
  chatStage: {
    flex: 1,
    position: 'relative',
  },
  chatLog: {
    flex: 1,
    backgroundColor: colors.bg === '#060d16' ? 'rgba(255,255,255,0.04)' : 'rgba(255,255,255,0.58)',
    borderWidth: 1,
    borderColor: colors.glassBorder,
    borderRadius: 22,
  },
  chatListContent: {
    flexGrow: 1,
    padding: 14,
    paddingBottom: 132,
    gap: 14,
  },
  emptyContainer: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 24,
    paddingVertical: 40,
  },
  emptyIconWrapper: {
    width: 56,
    height: 56,
    borderRadius: 28,
    backgroundColor: colors.bg === '#060d16' ? 'rgba(14, 165, 233, 0.15)' : 'rgba(14, 165, 233, 0.08)',
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: 16,
    borderWidth: 1,
    borderColor: colors.border,
  },
  emptyTextTitle: {
    fontSize: 17,
    lineHeight: 22,
    fontWeight: '900',
    color: colors.text,
    marginBottom: 8,
    textAlign: 'center',
    letterSpacing: 0,
  },
  emptyTextSub: {
    fontSize: 13,
    color: colors.text2,
    lineHeight: 19,
    textAlign: 'center',
  },
  bubbleContainer: {
    width: '100%',
    flexDirection: 'row',
  },
  bubbleLeft: {
    justifyContent: 'flex-start',
  },
  bubbleRight: {
    justifyContent: 'flex-end',
  },
  bubbleCard: {
    maxWidth: '88%',
    borderRadius: 18,
    paddingVertical: 12,
    paddingHorizontal: 15,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 8 },
    shadowOpacity: colors.bg === '#060d16' ? 0.22 : 0.13,
    shadowRadius: 14,
    elevation: 4,
  },
  cardUser: {
    backgroundColor: colors.bg === '#060d16' ? 'rgba(14,165,233,0.22)' : 'rgba(223,244,255,0.96)',
    borderWidth: 1,
    borderColor: 'rgba(14,165,233,0.38)',
    borderBottomRightRadius: 6,
  },
  cardPartner: {
    backgroundColor: colors.bg === '#060d16' ? 'rgba(16,185,129,0.18)' : 'rgba(221,250,238,0.96)',
    borderWidth: 1,
    borderColor: 'rgba(16,185,129,0.34)',
    borderBottomLeftRadius: 6,
  },
  liveBubble: {
    opacity: 0.92,
    borderStyle: 'dashed',
  },
  bubbleSource: {
    color: colors.text,
    opacity: 0.78,
    marginBottom: 6,
    lineHeight: 22,
  },
  bubbleFooter: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 12,
  },
  bubbleTarget: {
    color: colors.text,
    fontWeight: '900',
    flex: 1,
    lineHeight: 26,
  },
  replayBtn: {
    backgroundColor: 'rgba(14, 165, 233, 0.10)',
    borderWidth: 1,
    borderColor: 'rgba(14, 165, 233, 0.18)',
    width: 30,
    height: 30,
    borderRadius: 15,
    alignItems: 'center',
    justifyContent: 'center',
  },
  replayBtnUser: {
    backgroundColor: 'rgba(14, 165, 233, 0.12)',
  },
  replayBtnPartner: {
    backgroundColor: 'rgba(16, 185, 129, 0.12)',
    borderColor: 'rgba(16, 185, 129, 0.18)',
  },
  bubbleTime: {
    fontSize: 10,
    color: colors.muted,
    textAlign: 'right',
    marginTop: 6,
    fontWeight: '700',
  },
  loadingBubble: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    alignSelf: 'center',
    backgroundColor: colors.bg2,
    paddingVertical: 8,
    paddingHorizontal: 16,
    borderRadius: SIZES.radiusRound,
    borderWidth: 1,
    borderColor: colors.border,
    marginTop: 8,
  },
  loadingText: {
    fontSize: 12,
    color: colors.text2,
  },
  actionArea: {
    position: 'absolute',
    left: 0,
    right: 0,
    bottom: 12,
    width: '100%',
    paddingHorizontal: 10,
    alignItems: 'center',
    gap: 10,
  },
  bottomMicCard: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-around',
    backgroundColor: 'transparent',
    borderWidth: 0,
    borderRadius: 0,
    paddingVertical: 0,
    paddingHorizontal: 6,
    width: '100%',
    shadowOpacity: 0,
    elevation: 0,
  },
  singleMicContainer: {
    alignItems: 'center',
    justifyContent: 'center',
    width: '100%',
    backgroundColor: 'transparent',
  },
  circleMicColumn: {
    alignItems: 'center',
    justifyContent: 'center',
    gap: 6,
  },
  circleMicWrapper: {
    width: 72,
    height: 72,
    alignItems: 'center',
    justifyContent: 'center',
  },
  circleMicBtn: {
    width: 62,
    height: 62,
    borderRadius: 31,
    backgroundColor: colors.accent1,
    borderWidth: 2,
    borderColor: 'rgba(14, 165, 233, 0.42)',
    alignItems: 'center',
    justifyContent: 'center',
    shadowColor: colors.accent1,
    shadowOffset: { width: 0, height: 7 },
    shadowOpacity: 0.34,
    shadowRadius: 12,
    elevation: 6,
  },
  circleMicBtnSource: {
    backgroundColor: colors.accent1,
    borderColor: 'rgba(14, 165, 233, 0.52)',
    shadowColor: colors.accent1,
  },
  circleMicBtnTarget: {
    backgroundColor: colors.success,
    borderColor: 'rgba(16, 185, 129, 0.52)',
    shadowColor: colors.success,
  },
  circleMicBtnAuto: {
    backgroundColor: colors.accent3,
    borderColor: 'rgba(2, 132, 199, 0.52)',
    shadowColor: colors.accent3,
  },
  circleMicBtnActive: {
    backgroundColor: colors.danger,
    borderColor: 'rgba(244, 63, 94, 0.58)',
    shadowColor: colors.danger,
    shadowOpacity: 0.42,
    shadowRadius: 14,
    elevation: 8,
  },
  circleMicBtnDisabled: {
    opacity: 0.4,
  },
  circleMicLabel: {
    fontSize: 11,
    lineHeight: 14,
    fontWeight: '900',
    color: colors.text,
    maxWidth: 104,
    textAlign: 'center',
  },
  circleMicLabelActive: {
    color: colors.danger,
  },
  micCenterSeparator: {
    display: 'none',
    alignItems: 'center',
    justifyContent: 'center',
    width: 28,
    height: 28,
    backgroundColor: 'transparent',
    borderWidth: 0,
  },
  micCenterText: {
    display: 'none',
    fontSize: 0,
    fontWeight: 'bold',
    color: colors.muted,
    textTransform: 'uppercase',
  },
  modalOverlay: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.7)',
    justifyContent: 'center',
    alignItems: 'center',
  },
  modalCard: {
    width: '90%',
    maxHeight: '80%',
    backgroundColor: colors.surfaceCard || colors.bg2,
    borderRadius: SIZES.radiusLg,
    borderWidth: 1,
    borderColor: colors.surfaceBorder || colors.border,
    padding: 20,
  },
  modalHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    borderBottomWidth: 1,
    borderBottomColor: colors.surfaceBorder || colors.border,
    paddingBottom: 10,
    marginBottom: 15,
  },
  modalTitle: {
    fontSize: 16,
    fontWeight: 'bold',
    color: colors.accent1,
  },
  closeBtn: {
    width: 28,
    height: 28,
    borderRadius: 14,
    backgroundColor: colors.surfaceAction || 'rgba(255,255,255,0.05)',
    alignItems: 'center',
    justifyContent: 'center',
  },
  closeBtnText: {
    color: colors.text2,
    fontSize: 18,
    lineHeight: 20,
  },
  modalBody: {
    gap: 16,
    paddingBottom: 20,
  },
  settingItem: {
    gap: 8,
  },
  sectionTitle: {
    fontSize: 12,
    fontWeight: 'bold',
    color: colors.text2,
    textTransform: 'uppercase',
  },
  settingLabel: {
    fontSize: 12,
    fontWeight: 'bold',
    color: colors.text2,
    flexShrink: 1,
  },
  settingHint: {
    fontSize: 11,
    color: colors.muted,
    lineHeight: 16,
  },
  adjustRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
  },
  adjustBtn: {
    width: 36,
    height: 36,
    borderRadius: SIZES.radiusSm,
    backgroundColor: colors.surfaceAction || colors.bg2,
    borderWidth: 1,
    borderColor: colors.surfaceBorder || colors.border,
    alignItems: 'center',
    justifyContent: 'center',
  },
  adjustBtnText: {
    color: colors.text,
    fontSize: 18,
    fontWeight: 'bold',
  },
  btnGroup: {
    flexDirection: 'row',
    backgroundColor: colors.surfaceInset || 'rgba(0,0,0,0.3)',
    borderWidth: 1,
    borderColor: colors.surfaceBorder || colors.border,
    borderRadius: SIZES.radiusSm,
    padding: 3,
    gap: 4,
  },
  btnGroupItem: {
    flex: 1,
    paddingVertical: 10,
    alignItems: 'center',
    borderRadius: SIZES.radiusSm,
    borderWidth: 1,
    borderColor: 'transparent',
  },
  btnGroupItemActive: {
    backgroundColor: colors.selectedBg || 'rgba(14,165,233,0.15)',
    borderColor: colors.selectedBorder || colors.accent1,
  },
  btnGroupItemDisabled: {
    opacity: 0.45,
  },
  btnGroupText: {
    color: colors.text,
    fontSize: 12,
    fontWeight: 'bold',
  },
  controlDisabled: {
    opacity: 0.45,
  },
  switchRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    gap: 12,
    minHeight: 38,
  },
  warningBox: {
    backgroundColor: 'rgba(245,158,11,0.1)',
    borderWidth: 1,
    borderColor: colors.warning,
    borderRadius: SIZES.radiusSm,
    padding: 10,
  },
  warningBoxDanger: {
    backgroundColor: 'rgba(239,68,68,0.1)',
    borderColor: colors.danger,
  },
  warningText: {
    fontSize: 11,
    color: colors.warning,
    lineHeight: 16,
  },
  warningTextDanger: {
    color: colors.danger,
  },
  voiceSection: {
    gap: 6,
  },
  voiceScroll: {
    height: 100,
    backgroundColor: colors.surfaceInset || 'rgba(0,0,0,0.2)',
    borderWidth: 1,
    borderColor: colors.surfaceBorder || colors.border,
    borderRadius: SIZES.radiusSm,
    padding: 4,
  },
  voiceItem: {
    paddingVertical: 8,
    paddingHorizontal: 12,
    borderRadius: SIZES.radiusSm,
    marginBottom: 4,
    borderWidth: 1,
    borderColor: 'transparent',
  },
  voiceItemActive: {
    backgroundColor: colors.selectedBg || 'rgba(14,165,233,0.15)',
    borderColor: colors.selectedBorder || colors.accent1,
  },
  voiceItemText: {
    color: colors.text2,
    fontSize: 12,
  },
  voiceItemTextActive: {
    color: colors.selectedText || colors.accent1,
    fontWeight: 'bold',
  },
  saveBtn: {
    backgroundColor: colors.accent1,
    borderRadius: SIZES.radiusLg,
    paddingVertical: 14,
    alignItems: 'center',
    marginTop: 15,
  },
  saveBtnText: {
    color: '#fff',
    fontWeight: 'bold',
    fontSize: 14,
  },
});
