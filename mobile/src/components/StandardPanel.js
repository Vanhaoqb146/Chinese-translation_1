import React, { useState } from 'react';
import {
  StyleSheet,
  Text,
  View,
  TextInput,
  TouchableOpacity,
  ActivityIndicator,
  Keyboard,
} from 'react-native';
import { Feather } from '@expo/vector-icons';
import { COLORS, SIZES } from '../theme';
import MicrophonePulse from './MicrophonePulse';

export default function StandardPanel({
  srcIdx,
  tgtIdx,
  LANGUAGES,
  sourceText,
  setSourceText,
  translatedText,
  setTranslatedText,
  isTranslating,
  setIsTranslating,
  isRecording,
  startRecording,
  stopRecording,
  playTts,
  isPlaying,
  user,
  apiKey,
  selectedModel,
  api,
  loadHistory,
  themeColors,
  partialText,
}) {
  const [inputText, setInputText] = useState('');

  const srcLang = LANGUAGES[srcIdx];
  const tgtLang = LANGUAGES[tgtIdx];

  const colors = themeColors || COLORS;
  const styles = getStyles(colors);

  // Manual text translation
  const handleTextTranslate = async () => {
    if (!inputText.trim()) return;
    Keyboard.dismiss();
    setIsTranslating(true);
    setSourceText(inputText);
    setTranslatedText('Đang dịch thuật...');

    try {
      const translation = await api.translateText({
        text: inputText,
        sourceLang: srcLang.translateCode,
        targetLang: tgtLang.translateCode,
        engine: selectedModel,
        apiKey,
      });

      setTranslatedText(translation);
      setInputText('');

      // Play neural speech
      playTts(translation, tgtLang.ttsCode, tgtLang.ttsVoice);

      // Save translation in History database
      await api.saveHistory({
        userId: user.username,
        source: inputText,
        target: translation,
        fromLang: srcLang.translateCode,
        toLang: tgtLang.translateCode,
      });

      loadHistory();
    } catch (e) {
      console.error(e);
      setTranslatedText(`Lỗi kết nối: ${e.message}`);
    } finally {
      setIsTranslating(false);
    }
  };

  return (
    <View style={styles.container}>
      {/* KEYBOARD TEXT INPUT CARD */}
      <View style={styles.inputCard}>
        <TextInput
          style={styles.textInput}
          value={inputText}
          onChangeText={setInputText}
          placeholder="Nhập văn bản cần dịch..."
          placeholderTextColor={colors.muted}
          multiline
          maxLength={500}
          onSubmitEditing={handleTextTranslate}
        />
        {inputText.trim().length > 0 && (
          <TouchableOpacity style={styles.translateBtn} onPress={handleTextTranslate}>
            <Text style={styles.translateBtnText}>Dịch ⇄</Text>
          </TouchableOpacity>
        )}
      </View>

      {/* PANELS DISPLAY */}
      <View style={styles.panelsContainer}>
        {/* Source Text Panel */}
        <View style={[styles.panel, styles.panelSource]}>
          <Text style={styles.panelHeaderLabel}>
            {srcLang.flag} {srcLang.name} (Nguồn)
          </Text>
          <Text style={styles.panelBodyText}>
            {isRecording ? (
              partialText ? (
                <Text style={{ color: colors.text, fontStyle: 'italic' }}>{partialText}</Text>
              ) : (
                <Text style={styles.placeholder}>Đang lắng nghe...</Text>
              )
            ) : (
              sourceText || <Text style={styles.placeholder}>Nhập chữ ở trên hoặc nhấn giữ mic bên dưới để nói...</Text>
            )}
          </Text>
        </View>

        {/* Target Text Panel */}
        <View style={[styles.panel, styles.panelTarget]}>
          <View style={styles.targetHeader}>
            <Text style={styles.panelHeaderLabel}>
              {tgtLang.flag} {tgtLang.name} (Đích)
            </Text>
            {translatedText && !isTranslating ? (
              <TouchableOpacity 
                style={styles.replayBtn} 
                onPress={() => playTts(translatedText, tgtLang.ttsCode, tgtLang.ttsVoice)}
              >
                <Feather 
                  name={isPlaying ? "volume-2" : "volume-x"} 
                  size={16} 
                  color={isPlaying ? colors.success : colors.text2} 
                />
              </TouchableOpacity>
            ) : null}
          </View>
          <Text style={styles.panelBodyText}>
            {translatedText || <Text style={styles.placeholder}>Bản dịch sẽ xuất hiện ở đây...</Text>}
          </Text>
        </View>
      </View>

      {/* MIC RECORD BUTTON ZONE */}
      <View style={styles.recordingArea}>
        {isTranslating && (
          <View style={styles.translatingBadge}>
            <ActivityIndicator size="small" color={colors.accent1} style={{ marginRight: 6 }} />
            <Text style={styles.translatingText}>Đang dịch thuật...</Text>
          </View>
        )}
        
        <View style={styles.recordBtnWrapper}>
          <MicrophonePulse isRecording={isRecording} color={colors.danger} size={76} />
          <TouchableOpacity
            onPressIn={startRecording}
            onPressOut={stopRecording}
            activeOpacity={0.85}
            style={[styles.recordBtn, isRecording && styles.recordBtnRecording]}
          >
            <Feather name={isRecording ? "square" : "mic"} size={26} color="#fff" />
          </TouchableOpacity>
        </View>
        <Text style={styles.recordInstruction}>
          {isRecording ? 'THẢ TAY ĐỂ DỊCH' : 'NHẤN GIỮ ĐỂ NÓI'}
        </Text>
      </View>
    </View>
  );
}

const getStyles = (colors) => StyleSheet.create({
  container: {
    flex: 1,
  },
  placeholder: {
    color: colors.muted,
    fontStyle: 'italic',
  },
  inputCard: {
    backgroundColor: colors.bg2,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: SIZES.radiusLg,
    padding: 12,
    marginBottom: 16,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },
  textInput: {
    flex: 1,
    color: colors.text,
    fontSize: 14,
    minHeight: 44,
    paddingHorizontal: 8,
  },
  translateBtn: {
    backgroundColor: colors.accent1,
    borderRadius: SIZES.radiusSm,
    paddingVertical: 10,
    paddingHorizontal: 16,
  },
  translateBtnText: {
    color: '#fff',
    fontSize: 12,
    fontWeight: 'bold',
  },
  panelsContainer: {
    gap: 12,
    marginBottom: 20,
  },
  panel: {
    backgroundColor: colors.bg2,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: SIZES.radiusLg,
    padding: 16,
    minHeight: 110,
  },
  panelSource: {
    borderLeftWidth: 4,
    borderLeftColor: colors.accent1,
  },
  panelTarget: {
    borderLeftWidth: 4,
    borderLeftColor: colors.success,
  },
  panelHeaderLabel: {
    fontSize: 11,
    fontWeight: 'bold',
    color: colors.text2,
    marginBottom: 8,
    textTransform: 'uppercase',
  },
  targetHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginBottom: 8,
  },
  panelBodyText: {
    fontSize: 16,
    color: colors.text,
    lineHeight: 24,
  },
  recordingArea: {
    alignItems: 'center',
    justifyContent: 'center',
    marginVertical: 14,
  },
  translatingBadge: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: colors.bg2,
    borderWidth: 1,
    borderColor: colors.border,
    paddingHorizontal: 12,
    paddingVertical: 6,
    borderRadius: SIZES.radiusMd,
    marginBottom: 14,
  },
  translatingText: {
    fontSize: 12,
    color: colors.text2,
    fontWeight: '600',
  },
  replayBtn: {
    backgroundColor: 'rgba(16, 185, 129, 0.08)',
    borderWidth: 1,
    borderColor: 'rgba(16, 185, 129, 0.15)',
    borderRadius: 10,
    width: 28,
    height: 28,
    alignItems: 'center',
    justifyContent: 'center',
  },
  recordBtnWrapper: {
    width: 76,
    height: 76,
    alignItems: 'center',
    justifyContent: 'center',
    marginVertical: 8,
  },
  recordBtn: {
    width: 76,
    height: 76,
    borderRadius: SIZES.radiusRound,
    backgroundColor: colors.accent1,
    alignItems: 'center',
    justifyContent: 'center',
    shadowColor: colors.accent1,
    shadowOffset: { width: 0, height: 6 },
    shadowOpacity: 0.35,
    shadowRadius: 10,
    elevation: 6,
  },
  recordBtnRecording: {
    backgroundColor: colors.danger,
    transform: [{ scale: 1.08 }],
    shadowColor: colors.danger,
  },
  recordInstruction: {
    fontSize: 11,
    fontWeight: 'bold',
    color: colors.text2,
    marginTop: 10,
    letterSpacing: 1.2,
  },
});
