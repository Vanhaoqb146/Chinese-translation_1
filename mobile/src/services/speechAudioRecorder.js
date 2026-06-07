import { Audio } from 'expo-av';
import { NativeEventEmitter, NativeModules, Platform } from 'react-native';
import * as FileSystem from 'expo-file-system/legacy';

export const SPEECH_METERING_THRESHOLD_DB = -45;
export const SPEECH_RECORDING_INTERVAL_MS = 250;
export const MIN_SPEECH_CAPTURE_MS = 450;

/**
 * Recording options for auto-detect STT (Azure Fast Transcription + Whisper).
 *
 * Android: M4A/AAC is the reliable native recording format.
 *   Android's MediaRecorder does NOT natively support PCM/WAV output;
 *   using DEFAULT outputFormat produces AMR with a fake extension.
 *   Azure Fast Transcription and Whisper both accept M4A natively.
 *
 * iOS: LINEARPCM (WAV) works natively and is the most reliable format.
 */
export const SPEECH_RECORDING_OPTIONS = {
  ...Audio.RecordingOptionsPresets.HIGH_QUALITY,
  isMeteringEnabled: true,
  android: {
    ...Audio.RecordingOptionsPresets.HIGH_QUALITY.android,
    sampleRate: 16000,
    numberOfChannels: 1,
    bitRate: 64000,
  },
  ios: {
    ...Audio.RecordingOptionsPresets.HIGH_QUALITY.ios,
    sampleRate: 16000,
    numberOfChannels: 1,
    bitRate: 64000,
  },
};

let activeRecording = null;
let recordingOperation = Promise.resolve();
const AndroidAecRecorder = NativeModules.AndroidAecRecorder || null;
const androidAecRecorderEvents = AndroidAecRecorder
  ? new NativeEventEmitter(AndroidAecRecorder)
  : null;
let androidAecAvailabilityPromise = null;

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function runRecordingOperation(operation) {
  const run = recordingOperation.catch(() => {}).then(operation);
  recordingOperation = run.catch(() => {});
  return run;
}

export function isSpeechMeteringActive(status, threshold = SPEECH_METERING_THRESHOLD_DB) {
  const value = Number(status?.metering);
  return Number.isFinite(value) && value > threshold;
}

export async function getAndroidAecRecorderAvailability() {
  if (Platform.OS !== 'android' || !AndroidAecRecorder) {
    return {
      available: false,
      aecAvailable: false,
      noiseSuppressorAvailable: false,
      agcAvailable: false,
    };
  }

  if (!androidAecAvailabilityPromise) {
    androidAecAvailabilityPromise = AndroidAecRecorder.getAvailability().catch((error) => {
      androidAecAvailabilityPromise = null;
      throw error;
    });
  }

  return androidAecAvailabilityPromise;
}

export async function isAndroidAecRecordingSupported() {
  try {
    const availability = await getAndroidAecRecorderAvailability();
    return Boolean(availability?.available && availability?.aecAvailable);
  } catch (error) {
    console.warn('[AndroidAecRecorder] Availability check failed:', error);
    return false;
  }
}

/**
 * Verify that a recorded audio file actually exists and has a non-zero
 * size.  React Native's fetch() with a FormData file object will throw
 * `TypeError: Network request failed` if the URI points to a missing
 * or zero-byte file.
 *
 * @param {string|null} uri  File URI returned by Recording.getURI()
 * @returns {Promise<string|null>}  The original URI if the file is valid, null otherwise.
 */
async function verifySpeechAudioFile(uri) {
  if (!uri) return null;
  try {
    const info = await FileSystem.getInfoAsync(uri);
    if (!info.exists || (info.size != null && info.size <= 44)) {
      // 44 bytes = WAV header only, no audio data
      console.warn('[speechAudioRecorder] Recorded file missing or empty:', uri, info);
      return null;
    }
    console.log(`[🎙 recorder] ✅ Audio verified: ${(info.size / 1024).toFixed(1)}KB  ext=${uri.split('.').pop()}  uri=${uri.slice(-60)}`);
    return uri;
  } catch (err) {
    console.warn('[speechAudioRecorder] Cannot verify audio file:', uri, err);
    return null;
  }
}

async function startAndroidAecRecording(onStatusUpdate) {
  if (!(await isAndroidAecRecordingSupported())) {
    return null;
  }

  let subscription = null;
  try {
    subscription = androidAecRecorderEvents.addListener('AndroidAecRecorderStatus', (status) => {
      onStatusUpdate?.({
        ...status,
        isRecording: true,
        androidAec: true,
      });
    });

    const startResult = await AndroidAecRecorder.start({
      sampleRate: 16000,
      statusIntervalMs: SPEECH_RECORDING_INTERVAL_MS,
    });

    console.log(
      `[🎙 AEC recorder] Recording started (WAV 16kHz mono) ` +
      `aec=${startResult?.aecEnabled} ns=${startResult?.noiseSuppressorEnabled} agc=${startResult?.agcEnabled}`
    );

    return {
      __androidAec: true,
      subscription,
      startResult,
    };
  } catch (error) {
    subscription?.remove?.();
    console.warn('[AndroidAecRecorder] Failed to start, falling back to Expo recorder:', error);
    return null;
  }
}

async function stopAndroidAecRecording(recording) {
  try {
    const stopResult = await AndroidAecRecorder.stop();
    const uri = await verifySpeechAudioFile(stopResult?.uri);
    if (uri) {
      console.log(
        `[🎙 AEC recorder] ✅ Audio verified: ` +
        `${((stopResult?.sizeBytes || 0) / 1024).toFixed(1)}KB  uri=${uri.slice(-60)}`
      );
    }
    return uri;
  } finally {
    recording?.subscription?.remove?.();
  }
}

async function stopRecordingNow(recording) {
  if (!recording) return null;
  if (recording.__androidAec) {
    return stopAndroidAecRecording(recording);
  }

  try {
    await recording.stopAndUnloadAsync();
  } catch (error) {
    const message = String(error?.message || error || '');
    if (
      !message.includes('not prepared') &&
      !message.includes('not recording') &&
      !message.includes('no valid audio data')
    ) {
      throw error;
    }
  }

  const uri = recording.getURI();
  return verifySpeechAudioFile(uri);
}

export async function startSpeechAudioRecording(onStatusUpdate, options = {}) {
  return runRecordingOperation(async () => {
    if (activeRecording) {
      const previousRecording = activeRecording;
      activeRecording = null;
      await stopRecordingNow(previousRecording);
      await delay(120);
    }

    if (options?.preferAndroidAec) {
      const androidAecRecording = await startAndroidAecRecording(onStatusUpdate);
      if (androidAecRecording) {
        activeRecording = androidAecRecording;
        return androidAecRecording;
      }
    }

    const recording = new Audio.Recording();
    recording.setOnRecordingStatusUpdate(onStatusUpdate);
    recording.setProgressUpdateInterval(SPEECH_RECORDING_INTERVAL_MS);
    try {
      await recording.prepareToRecordAsync(SPEECH_RECORDING_OPTIONS);
      await recording.startAsync();
      activeRecording = recording;
      console.log(`[🎙 recorder] Recording started (${Platform.OS === 'ios' ? 'WAV' : 'M4A'} 16kHz mono)`);
      return recording;
    } catch (error) {
      if (activeRecording === recording) activeRecording = null;
      try {
        await stopRecordingNow(recording);
      } catch {}
      throw error;
    }
  });
}

export async function stopSpeechAudioRecording(recording) {
  return runRecordingOperation(async () => {
    if (!recording) return null;
    if (activeRecording === recording) {
      activeRecording = null;
    }
    return stopRecordingNow(recording);
  });
}
