const fs = require('fs');
const path = require('path');
const { withDangerousMod } = require('@expo/config-plugins');

const SUPPORTED_VERSION = '3.1.3';
const PATCH_MARKER = 'VoiceTranslate Android live STT AEC patch';
const SCOPED_PATCH_MARKER = 'VoiceTranslate scoped live STT AEC';

function replaceRequired(contents, search, replacement, label) {
  if (!contents.includes(search)) {
    throw new Error(`Unable to apply ${PATCH_MARKER}: missing ${label}`);
  }
  return contents.replace(search, replacement);
}

function getNativeSourcePath(packageRoot, fileName) {
  return path.join(
    packageRoot,
    'android',
    'src',
    'main',
    'java',
    'expo',
    'modules',
    'speechrecognition',
    fileName
  );
}

function applyBaseRecorderPatch(contents) {
  if (contents.includes(PATCH_MARKER)) {
    return contents;
  }

  let next = replaceRequired(
    contents,
    `import android.media.AudioRecord
import android.media.MediaRecorder`,
    `import android.media.AudioRecord
import android.media.AudioManager
import android.media.MediaRecorder
import android.media.audiofx.AcousticEchoCanceler
import android.media.audiofx.AutomaticGainControl
import android.media.audiofx.NoiseSuppressor`,
    'Android audio imports'
  );

  next = replaceRequired(
    next,
    `    private var audioRecorder: AudioRecord? = null

    var outputFile: File? = null`,
    `    private var audioRecorder: AudioRecord? = null
    private var audioManager: AudioManager? = null
    private var previousAudioMode: Int? = null
    private var previousSpeakerphoneOn: Boolean? = null
    private var acousticEchoCanceler: AcousticEchoCanceler? = null
    private var noiseSuppressor: NoiseSuppressor? = null
    private var automaticGainControl: AutomaticGainControl? = null

    var outputFile: File? = null`,
    'audio effect fields'
  );

  next = replaceRequired(
    next,
    `    @SuppressLint("MissingPermission")
    private fun createRecorder(): AudioRecord =
        AudioRecord(
            MediaRecorder.AudioSource.VOICE_RECOGNITION,
            sampleRateInHz,
            channelConfig,
            AudioFormat.ENCODING_PCM_16BIT,
            bufferSizeInBytes,
        )`,
    `    @SuppressLint("MissingPermission")
    private fun createRecorder(): AudioRecord {
        configureCommunicationAudioMode()
        val recorderBufferSize = maxOf(bufferSizeInBytes * 2, 4096)
        return if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) {
            val format =
                AudioFormat.Builder()
                    .setSampleRate(sampleRateInHz)
                    .setEncoding(audioFormat)
                    .setChannelMask(channelConfig)
                    .build()
            AudioRecord.Builder()
                .setAudioSource(MediaRecorder.AudioSource.VOICE_COMMUNICATION)
                .setAudioFormat(format)
                .setBufferSizeInBytes(recorderBufferSize)
                .build()
        } else {
            AudioRecord(
                MediaRecorder.AudioSource.VOICE_COMMUNICATION,
                sampleRateInHz,
                channelConfig,
                audioFormat,
                recorderBufferSize,
            )
        }
    }`,
    'VOICE_COMMUNICATION recorder'
  );

  next = replaceRequired(
    next,
    `        createRecorder().apply {
            audioRecorder = this

            // First check whether the above object actually initialized
            if (this.state != AudioRecord.STATE_INITIALIZED) {
                return
            }

            this.startRecording()`,
    `        createRecorder().apply {
            // First check whether the above object actually initialized
            if (this.state != AudioRecord.STATE_INITIALIZED) {
                this.release()
                restoreCommunicationAudioMode()
                return
            }

            audioRecorder = this
            configureAudioEffects(this.audioSessionId)
            Log.d(
                TAG,
                "${PATCH_MARKER}: session=\${this.audioSessionId} " +
                    "aec=\${acousticEchoCanceler?.enabled == true} " +
                    "ns=\${noiseSuppressor?.enabled == true} " +
                    "agc=\${automaticGainControl?.enabled == true}",
            )

            this.startRecording()`,
    'recorder startup'
  );

  next = replaceRequired(
    next,
    `        audioRecorder?.stop()
        audioRecorder?.release()
        audioRecorder = null
        recordingThread = null`,
    `        try {
            audioRecorder?.stop()
        } catch (_: IllegalStateException) {}
        audioRecorder?.release()
        audioRecorder = null
        releaseAudioEffects()
        restoreCommunicationAudioMode()
        recordingThread = null`,
    'recorder cleanup'
  );

  return replaceRequired(
    next,
    `    private fun streamAudioToPipe() {`,
    `    // ${PATCH_MARKER}
    private fun configureCommunicationAudioMode() {
        val manager = context.getSystemService(Context.AUDIO_SERVICE) as? AudioManager ?: return
        if (audioManager == null) {
            previousAudioMode = manager.mode
            previousSpeakerphoneOn = manager.isSpeakerphoneOn
        }
        audioManager = manager
        manager.mode = AudioManager.MODE_IN_COMMUNICATION
        manager.isSpeakerphoneOn = true
    }

    private fun restoreCommunicationAudioMode() {
        audioManager?.let { manager ->
            previousAudioMode?.let { manager.mode = it }
            previousSpeakerphoneOn?.let { manager.isSpeakerphoneOn = it }
        }
        previousAudioMode = null
        previousSpeakerphoneOn = null
        audioManager = null
    }

    private fun configureAudioEffects(audioSessionId: Int) {
        if (AcousticEchoCanceler.isAvailable()) {
            acousticEchoCanceler =
                AcousticEchoCanceler.create(audioSessionId)?.apply { enabled = true }
        }
        if (NoiseSuppressor.isAvailable()) {
            noiseSuppressor =
                NoiseSuppressor.create(audioSessionId)?.apply { enabled = true }
        }
        if (AutomaticGainControl.isAvailable()) {
            automaticGainControl =
                AutomaticGainControl.create(audioSessionId)?.apply { enabled = true }
        }
    }

    private fun releaseAudioEffects() {
        try {
            acousticEchoCanceler?.release()
        } catch (_: Exception) {}
        try {
            noiseSuppressor?.release()
        } catch (_: Exception) {}
        try {
            automaticGainControl?.release()
        } catch (_: Exception) {}
        acousticEchoCanceler = null
        noiseSuppressor = null
        automaticGainControl = null
    }

    private fun streamAudioToPipe() {`,
    'AEC helpers'
  );
}

function applyScopedRecorderPatch(contents) {
  if (contents.includes(SCOPED_PATCH_MARKER)) {
    return contents;
  }

  let next = replaceRequired(
    contents,
    `    private val outputFilePath: String?,
) : AudioRecorder {`,
    `    private val outputFilePath: String?,
    private val enableVoiceCommunicationAec: Boolean = false,
) : AudioRecorder {`,
    'scoped AEC constructor option'
  );

  next = replaceRequired(
    next,
    `    private fun createRecorder(): AudioRecord {
        configureCommunicationAudioMode()
        val recorderBufferSize = maxOf(bufferSizeInBytes * 2, 4096)
        return if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) {
            val format =
                AudioFormat.Builder()
                    .setSampleRate(sampleRateInHz)
                    .setEncoding(audioFormat)
                    .setChannelMask(channelConfig)
                    .build()
            AudioRecord.Builder()
                .setAudioSource(MediaRecorder.AudioSource.VOICE_COMMUNICATION)
                .setAudioFormat(format)
                .setBufferSizeInBytes(recorderBufferSize)
                .build()
        } else {
            AudioRecord(
                MediaRecorder.AudioSource.VOICE_COMMUNICATION,
                sampleRateInHz,
                channelConfig,
                audioFormat,
                recorderBufferSize,
            )
        }
    }`,
    `    private fun createRecorder(): AudioRecord {
        if (enableVoiceCommunicationAec) {
            configureCommunicationAudioMode()
        }
        val audioSource =
            if (enableVoiceCommunicationAec) {
                MediaRecorder.AudioSource.VOICE_COMMUNICATION
            } else {
                MediaRecorder.AudioSource.VOICE_RECOGNITION
            }
        val recorderBufferSize = maxOf(bufferSizeInBytes * 2, 4096)
        return if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) {
            val format =
                AudioFormat.Builder()
                    .setSampleRate(sampleRateInHz)
                    .setEncoding(audioFormat)
                    .setChannelMask(channelConfig)
                    .build()
            AudioRecord.Builder()
                .setAudioSource(audioSource)
                .setAudioFormat(format)
                .setBufferSizeInBytes(recorderBufferSize)
                .build()
        } else {
            AudioRecord(
                audioSource,
                sampleRateInHz,
                channelConfig,
                audioFormat,
                recorderBufferSize,
            )
        }
    }`,
    'scoped recorder audio source'
  );

  return replaceRequired(
    next,
    `            audioRecorder = this
            configureAudioEffects(this.audioSessionId)
            Log.d(
                TAG,
                "${PATCH_MARKER}: session=\${this.audioSessionId} " +
                    "aec=\${acousticEchoCanceler?.enabled == true} " +
                    "ns=\${noiseSuppressor?.enabled == true} " +
                    "agc=\${automaticGainControl?.enabled == true}",
            )

            this.startRecording()`,
    `            audioRecorder = this
            if (enableVoiceCommunicationAec) {
                configureAudioEffects(this.audioSessionId)
                Log.d(
                    TAG,
                    "${SCOPED_PATCH_MARKER}: session=\${this.audioSessionId} " +
                        "aec=\${acousticEchoCanceler?.enabled == true} " +
                        "ns=\${noiseSuppressor?.enabled == true} " +
                        "agc=\${automaticGainControl?.enabled == true}",
                )
            }

            this.startRecording()`,
    'scoped AEC startup'
  );
}

function patchSpeechRecognitionOptions(packageRoot) {
  const optionsPath = getNativeSourcePath(packageRoot, 'ExpoSpeechRecognitionOptions.kt');
  let contents = fs.readFileSync(optionsPath, 'utf8');

  if (!contents.includes('androidLiveAec')) {
    contents = replaceRequired(
      contents,
      `    @Field
    val continuous: Boolean? = false

    @Field
    val maxAlternatives: Int? = 5`,
      `    @Field
    val continuous: Boolean? = false

    @Field
    val androidLiveAec: Boolean? = false

    @Field
    val maxAlternatives: Int? = 5`,
      'androidLiveAec recognition option'
    );
    fs.writeFileSync(optionsPath, contents);
  }
}

function patchSpeechService(packageRoot) {
  const servicePath = getNativeSourcePath(packageRoot, 'ExpoSpeechService.kt');
  let contents = fs.readFileSync(servicePath, 'utf8');

  if (!contents.includes('options.androidLiveAec')) {
    contents = replaceRequired(
      contents,
      'audioRecorder = ExpoAudioRecorder(reactContext, resolveFilePathFromConfig(options.recordingOptions))',
      `audioRecorder =
                    ExpoAudioRecorder(
                        reactContext,
                        resolveFilePathFromConfig(options.recordingOptions),
                        false,
                    )`,
      'persisted recorder constructor'
    );
    contents = replaceRequired(
      contents,
      'audioRecorder = ExpoAudioRecorder(reactContext, null)',
      `audioRecorder =
                    ExpoAudioRecorder(
                        reactContext,
                        null,
                        options.androidLiveAec == true,
                    )`,
      'continuous recorder constructor'
    );
    fs.writeFileSync(servicePath, contents);
  }
}

function patchExpoSpeechRecognition(projectRoot) {
  const packageJsonPath = require.resolve('expo-speech-recognition/package.json', {
    paths: [projectRoot],
  });
  const packageRoot = path.dirname(packageJsonPath);
  const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, 'utf8'));

  if (packageJson.version !== SUPPORTED_VERSION) {
    throw new Error(
      `${PATCH_MARKER} supports expo-speech-recognition ${SUPPORTED_VERSION}, ` +
      `but ${packageJson.version} is installed. Review the native recorder before upgrading.`
    );
  }

  const recorderPath = getNativeSourcePath(packageRoot, 'ExpoAudioRecorder.kt');
  let recorderContents = fs.readFileSync(recorderPath, 'utf8');
  recorderContents = applyBaseRecorderPatch(recorderContents);
  recorderContents = applyScopedRecorderPatch(recorderContents);
  fs.writeFileSync(recorderPath, recorderContents);

  patchSpeechRecognitionOptions(packageRoot);
  patchSpeechService(packageRoot);
}

module.exports = function withAndroidSpeechRecognitionAec(config) {
  return withDangerousMod(config, [
    'android',
    async (modConfig) => {
      patchExpoSpeechRecognition(modConfig.modRequest.projectRoot);
      return modConfig;
    },
  ]);
};
