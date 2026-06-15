package __ANDROID_AEC_PACKAGE__

import android.Manifest
import android.annotation.SuppressLint
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.media.AudioFormat
import android.media.AudioManager
import android.media.AudioRecord
import android.media.MediaRecorder
import android.media.audiofx.AcousticEchoCanceler
import android.media.audiofx.AutomaticGainControl
import android.media.audiofx.NoiseSuppressor
import android.net.Uri
import android.os.Build
import com.facebook.react.bridge.Arguments
import com.facebook.react.bridge.Promise
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.ReactContextBaseJavaModule
import com.facebook.react.bridge.ReactMethod
import com.facebook.react.bridge.ReadableMap
import com.facebook.react.modules.core.DeviceEventManagerModule
import java.io.File
import java.io.RandomAccessFile
import java.util.UUID
import kotlin.math.log10
import kotlin.math.max
import kotlin.math.sqrt

class AndroidAecRecorderModule(
  private val reactContext: ReactApplicationContext
) : ReactContextBaseJavaModule(reactContext) {
  companion object {
    private const val EVENT_STATUS = "AndroidAecRecorderStatus"
    private const val DEFAULT_SAMPLE_RATE = 16000
    private const val DEFAULT_STATUS_INTERVAL_MS = 250L
    private const val WAV_HEADER_BYTES = 44L

    @Volatile
    private var activeInstance: AndroidAecRecorderModule? = null

    fun stopActiveRecorderFromService() {
      activeInstance?.let { instance ->
        synchronized(instance) {
          instance.stopRecordingBlocking()
        }
      }
    }
  }

  private data class SegmentResult(
    val file: File?,
    val sizeBytes: Long,
    val durationMs: Long
  )

  @Volatile
  private var isRecording = false
  private var recordingThread: Thread? = null
  private var audioRecord: AudioRecord? = null
  private var outputFile: File? = null
  private var outputWav: RandomAccessFile? = null
  private var outputDataBytes = 0L
  private var startedAtMs = 0L
  private var sampleRate = DEFAULT_SAMPLE_RATE
  private var persistentMode = false
  private var enableAecForCurrentSession = true
  private var audioManager: AudioManager? = null
  private var previousAudioMode: Int? = null
  private var previousSpeakerphoneOn: Boolean? = null
  private var aec: AcousticEchoCanceler? = null
  private var ns: NoiseSuppressor? = null
  private var agc: AutomaticGainControl? = null
  private var backgroundTimer: java.util.Timer? = null
  private val segmentLock = Any()

  init {
    activeInstance = this
  }

  override fun getName(): String = "AndroidAecRecorder"

  @ReactMethod
  fun addListener(eventName: String) {
    // Required by React Native's NativeEventEmitter.
  }

  @ReactMethod
  fun removeListeners(count: Int) {
    // Required by React Native's NativeEventEmitter.
  }

  @ReactMethod
  fun getAvailability(promise: Promise) {
    val minBuffer = AudioRecord.getMinBufferSize(
      DEFAULT_SAMPLE_RATE,
      AudioFormat.CHANNEL_IN_MONO,
      AudioFormat.ENCODING_PCM_16BIT
    )
    val result = Arguments.createMap().apply {
      putBoolean("available", minBuffer > 0)
      putBoolean("aecAvailable", AcousticEchoCanceler.isAvailable())
      putBoolean("noiseSuppressorAvailable", NoiseSuppressor.isAvailable())
      putBoolean("agcAvailable", AutomaticGainControl.isAvailable())
      putInt("sampleRate", DEFAULT_SAMPLE_RATE)
    }
    promise.resolve(result)
  }

  @ReactMethod
  fun start(options: ReadableMap?, promise: Promise) {
    if (!hasRecordAudioPermission()) {
      promise.reject("E_PERMISSION", "RECORD_AUDIO permission is not granted")
      return
    }

    try {
      synchronized(this) {
        if (isRecording) {
          stopRecordingBlocking()
        }
        startRecording(
          requestedSampleRate(options),
          requestedStatusInterval(options),
          persistent = false,
          enableAec = requestedEnableAec(options, defaultValue = true)
        )
      }
      promise.resolve(createStartResult())
    } catch (error: Exception) {
      stopRecordingBlocking()
      promise.reject("E_START_AEC_RECORDER", error.message, error)
    }
  }

  @ReactMethod
  fun stop(promise: Promise) {
    try {
      promise.resolve(stopRecordingBlocking())
    } catch (error: Exception) {
      promise.reject("E_STOP_AEC_RECORDER", error.message, error)
    }
  }

  @ReactMethod
  fun startPersistent(options: ReadableMap?, promise: Promise) {
    if (!hasRecordAudioPermission()) {
      promise.reject("E_PERMISSION", "RECORD_AUDIO permission is not granted")
      return
    }

    try {
      synchronized(this) {
        if (isRecording) {
          stopRecordingBlocking()
        }
        startRecording(
          requestedSampleRate(options),
          requestedStatusInterval(options),
          persistent = true,
          enableAec = requestedEnableAec(options, defaultValue = false)
        )
      }
      promise.resolve(createStartResult())
    } catch (error: Exception) {
      stopRecordingBlocking()
      promise.reject("E_START_PERSISTENT_RECORDER", error.message, error)
    }
  }

  @ReactMethod
  fun beginPersistentSegment(promise: Promise) {
    try {
      synchronized(this) {
        if (!isRecording || !persistentMode) {
          throw IllegalStateException("Persistent microphone session is not active")
        }
        synchronized(segmentLock) {
          if (outputWav != null) {
            throw IllegalStateException("A persistent recording segment is already active")
          }
          openSegmentLocked()
        }
      }
      promise.resolve(createStartResult())
    } catch (error: Exception) {
      promise.reject("E_BEGIN_PERSISTENT_SEGMENT", error.message, error)
    }
  }

  @ReactMethod
  fun finishPersistentSegment(promise: Promise) {
    try {
      val segment = synchronized(segmentLock) {
        finishSegmentLocked()
      }
      promise.resolve(createSegmentResultMap(segment))
    } catch (error: Exception) {
      promise.reject("E_FINISH_PERSISTENT_SEGMENT", error.message, error)
    }
  }

  @ReactMethod
  fun stopPersistent(promise: Promise) {
    try {
      promise.resolve(stopRecordingBlocking())
    } catch (error: Exception) {
      promise.reject("E_STOP_PERSISTENT_RECORDER", error.message, error)
    }
  }

  @ReactMethod
  fun startForegroundService(options: ReadableMap?, promise: Promise) {
    val title = options?.getString("title") ?: "VoiceTranslate AI is active"
    val body = options?.getString("body") ?: "Background microphone is active."
    try {
      val intent = Intent(reactContext, VoiceTranslateService::class.java).apply {
        putExtra("title", title)
        putExtra("body", body)
      }
      if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
        reactContext.startForegroundService(intent)
      } else {
        reactContext.startService(intent)
      }
      promise.resolve(true)
    } catch (error: Exception) {
      promise.reject("E_START_SERVICE", error.message, error)
    }
  }

  @ReactMethod
  fun stopForegroundService(promise: Promise) {
    try {
      val intent = Intent(reactContext, VoiceTranslateService::class.java)
      reactContext.stopService(intent)
      promise.resolve(true)
    } catch (error: Exception) {
      promise.reject("E_STOP_SERVICE", error.message, error)
    }
  }

  @ReactMethod
  fun isForegroundServiceRunning(promise: Promise) {
    promise.resolve(VoiceTranslateService.isRunning)
  }

  @ReactMethod
  fun startBackgroundTimer(delayMs: Int, promise: Promise) {
    synchronized(this) {
      try {
        backgroundTimer?.cancel()
        backgroundTimer = java.util.Timer()
        backgroundTimer?.schedule(object : java.util.TimerTask() {
          override fun run() {
            synchronized(this@AndroidAecRecorderModule) {
              backgroundTimer = null
            }
            promise.resolve(true)
          }
        }, delayMs.toLong())
      } catch (error: Exception) {
        promise.reject("E_START_TIMER", error.message, error)
      }
    }
  }

  @ReactMethod
  fun cancelBackgroundTimer(promise: Promise) {
    synchronized(this) {
      try {
        if (backgroundTimer != null) {
          backgroundTimer?.cancel()
          backgroundTimer = null
          promise.resolve(true)
        } else {
          promise.resolve(false)
        }
      } catch (error: Exception) {
        promise.reject("E_CANCEL_TIMER", error.message, error)
      }
    }
  }

  private fun hasRecordAudioPermission(): Boolean =
    reactContext.checkSelfPermission(Manifest.permission.RECORD_AUDIO) ==
      PackageManager.PERMISSION_GRANTED

  private fun requestedSampleRate(options: ReadableMap?): Int =
    if (options?.hasKey("sampleRate") == true) {
      options.getInt("sampleRate")
    } else {
      DEFAULT_SAMPLE_RATE
    }

  private fun requestedStatusInterval(options: ReadableMap?): Long =
    if (options?.hasKey("statusIntervalMs") == true) {
      max(100L, options.getInt("statusIntervalMs").toLong())
    } else {
      DEFAULT_STATUS_INTERVAL_MS
    }

  private fun requestedEnableAec(options: ReadableMap?, defaultValue: Boolean): Boolean =
    if (options?.hasKey("enableAec") == true) {
      options.getBoolean("enableAec")
    } else {
      defaultValue
    }

  @SuppressLint("MissingPermission")
  private fun startRecording(
    requestedSampleRate: Int,
    statusIntervalMs: Long,
    persistent: Boolean,
    enableAec: Boolean
  ) {
    sampleRate = requestedSampleRate
    val minBuffer = AudioRecord.getMinBufferSize(
      sampleRate,
      AudioFormat.CHANNEL_IN_MONO,
      AudioFormat.ENCODING_PCM_16BIT
    )
    if (minBuffer <= 0) {
      throw IllegalStateException("AudioRecord min buffer is invalid: $minBuffer")
    }

    val bufferSize = max(minBuffer * 2, sampleRate / 5 * 2)
    val audioSource = if (enableAec) {
      MediaRecorder.AudioSource.VOICE_COMMUNICATION
    } else {
      MediaRecorder.AudioSource.VOICE_RECOGNITION
    }
    val record = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) {
      val format = AudioFormat.Builder()
        .setSampleRate(sampleRate)
        .setEncoding(AudioFormat.ENCODING_PCM_16BIT)
        .setChannelMask(AudioFormat.CHANNEL_IN_MONO)
        .build()
      AudioRecord.Builder()
        .setAudioSource(audioSource)
        .setAudioFormat(format)
        .setBufferSizeInBytes(bufferSize)
        .build()
    } else {
      AudioRecord(
        audioSource,
        sampleRate,
        AudioFormat.CHANNEL_IN_MONO,
        AudioFormat.ENCODING_PCM_16BIT,
        bufferSize
      )
    }

    if (record.state != AudioRecord.STATE_INITIALIZED) {
      record.release()
      throw IllegalStateException("AudioRecord failed to initialize")
    }

    persistentMode = persistent
    enableAecForCurrentSession = enableAec
    if (enableAec) {
      configureCommunicationAudioMode()
      configureAudioEffects(record.audioSessionId)
    }
    synchronized(segmentLock) {
      openSegmentLocked()
    }
    audioRecord = record
    isRecording = true

    recordingThread = Thread({
      recordLoop(record, bufferSize, statusIntervalMs)
    }, "AndroidAecRecorder").also { it.start() }
  }

  private fun recordLoop(
    record: AudioRecord,
    bufferSize: Int,
    statusIntervalMs: Long
  ) {
    val buffer = ByteArray(bufferSize)
    var lastStatusAt = 0L

    try {
      record.startRecording()
      while (isRecording) {
        val read = record.read(buffer, 0, buffer.size)
        if (read > 0) {
          synchronized(segmentLock) {
            outputWav?.let { wav ->
              wav.write(buffer, 0, read)
              outputDataBytes += read.toLong()
            }
          }
          val now = System.currentTimeMillis()
          if (now - lastStatusAt >= statusIntervalMs) {
            lastStatusAt = now
            emitStatus(buffer, read, now)
          }
        }
      }
    } finally {
      isRecording = false
      try {
        if (record.recordingState == AudioRecord.RECORDSTATE_RECORDING) {
          record.stop()
        }
      } catch (_: Exception) {}
      record.release()
      releaseAudioEffects()
      restoreAudioMode()
    }
  }

  private fun emitStatus(buffer: ByteArray, length: Int, now: Long) {
    val metering = calculateDb(buffer, length)
    val segmentState = synchronized(segmentLock) {
      Pair(outputWav != null, startedAtMs)
    }
    val payload = Arguments.createMap().apply {
      putBoolean("isRecording", true)
      putBoolean("androidAec", enableAecForCurrentSession)
      putBoolean("persistent", persistentMode)
      putBoolean("segmentActive", segmentState.first)
      putDouble("metering", metering)
      putDouble(
        "durationMillis",
        if (segmentState.first) (now - segmentState.second).toDouble() else 0.0
      )
    }
    reactContext
      .getJSModule(DeviceEventManagerModule.RCTDeviceEventEmitter::class.java)
      .emit(EVENT_STATUS, payload)
  }

  private fun calculateDb(buffer: ByteArray, length: Int): Double {
    var sum = 0.0
    var count = 0
    var index = 0
    while (index + 1 < length) {
      val low = buffer[index].toInt() and 0xff
      val high = buffer[index + 1].toInt()
      val sample = (high shl 8) or low
      sum += sample.toDouble() * sample.toDouble()
      count += 1
      index += 2
    }
    if (count == 0) return -120.0
    val rms = sqrt(sum / count.toDouble())
    if (rms <= 1.0) return -120.0
    return 20.0 * log10(rms / 32767.0)
  }

  private fun configureCommunicationAudioMode() {
    audioManager = reactContext.getSystemService(Context.AUDIO_SERVICE) as? AudioManager
    audioManager?.let { manager ->
      previousAudioMode = manager.mode
      previousSpeakerphoneOn = manager.isSpeakerphoneOn
      manager.mode = AudioManager.MODE_IN_COMMUNICATION
      manager.isSpeakerphoneOn = true
    }
  }

  private fun restoreAudioMode() {
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
      aec = AcousticEchoCanceler.create(audioSessionId)?.apply { enabled = true }
    }
    if (NoiseSuppressor.isAvailable()) {
      ns = NoiseSuppressor.create(audioSessionId)?.apply { enabled = true }
    }
    if (AutomaticGainControl.isAvailable()) {
      agc = AutomaticGainControl.create(audioSessionId)?.apply { enabled = true }
    }
  }

  private fun releaseAudioEffects() {
    try { aec?.release() } catch (_: Exception) {}
    try { ns?.release() } catch (_: Exception) {}
    try { agc?.release() } catch (_: Exception) {}
    aec = null
    ns = null
    agc = null
  }

  @Synchronized
  private fun stopRecordingBlocking(): com.facebook.react.bridge.WritableMap {
    isRecording = false
    try {
      if (audioRecord?.recordingState == AudioRecord.RECORDSTATE_RECORDING) {
        audioRecord?.stop()
      }
    } catch (_: Exception) {}
    recordingThread?.join(2500)
    recordingThread = null
    audioRecord = null

    val segment = synchronized(segmentLock) {
      finishSegmentLocked()
    }
    persistentMode = false
    enableAecForCurrentSession = true
    return createSegmentResultMap(segment).apply {
      putBoolean("stopped", true)
    }
  }

  private fun createStartResult(): com.facebook.react.bridge.WritableMap =
    Arguments.createMap().apply {
      putBoolean("started", true)
      putBoolean("persistent", persistentMode)
      putBoolean("aecEnabled", enableAecForCurrentSession && aec?.enabled == true)
      putBoolean("noiseSuppressorEnabled", enableAecForCurrentSession && ns?.enabled == true)
      putBoolean("agcEnabled", enableAecForCurrentSession && agc?.enabled == true)
      putInt("audioSessionId", audioRecord?.audioSessionId ?: -1)
      putInt("sampleRate", sampleRate)
    }

  private fun createSegmentResultMap(
    segment: SegmentResult
  ): com.facebook.react.bridge.WritableMap =
    Arguments.createMap().apply {
      putBoolean("stopped", false)
      putString("uri", segment.file?.let { Uri.fromFile(it).toString() })
      putDouble("sizeBytes", segment.sizeBytes.toDouble())
      putDouble("durationMs", segment.durationMs.toDouble())
    }

  private fun openSegmentLocked() {
    val file = File(
      reactContext.cacheDir,
      "aec-recording-${System.currentTimeMillis()}-${UUID.randomUUID()}.wav"
    )
    val wav = RandomAccessFile(file, "rw")
    writeEmptyWavHeader(wav)
    outputFile = file
    outputWav = wav
    outputDataBytes = 0L
    startedAtMs = System.currentTimeMillis()
  }

  private fun finishSegmentLocked(): SegmentResult {
    val wav = outputWav
    val file = outputFile
    val durationMs = if (startedAtMs > 0L) {
      System.currentTimeMillis() - startedAtMs
    } else {
      0L
    }

    if (wav != null) {
      updateWavHeader(wav, outputDataBytes, sampleRate)
      wav.close()
    }

    val result = SegmentResult(
      file = file,
      sizeBytes = file?.length() ?: 0L,
      durationMs = durationMs
    )
    outputWav = null
    outputFile = null
    outputDataBytes = 0L
    startedAtMs = 0L
    return result
  }

  private fun writeEmptyWavHeader(file: RandomAccessFile) {
    file.setLength(0)
    repeat(WAV_HEADER_BYTES.toInt()) {
      file.write(0)
    }
  }

  private fun updateWavHeader(file: RandomAccessFile, dataBytes: Long, sampleRate: Int) {
    file.seek(0)
    writeAscii(file, "RIFF")
    writeIntLe(file, (36L + dataBytes).toInt())
    writeAscii(file, "WAVE")
    writeAscii(file, "fmt ")
    writeIntLe(file, 16)
    writeShortLe(file, 1)
    writeShortLe(file, 1)
    writeIntLe(file, sampleRate)
    writeIntLe(file, sampleRate * 2)
    writeShortLe(file, 2)
    writeShortLe(file, 16)
    writeAscii(file, "data")
    writeIntLe(file, dataBytes.toInt())
  }

  private fun writeAscii(file: RandomAccessFile, value: String) {
    file.write(value.toByteArray(Charsets.US_ASCII))
  }

  private fun writeIntLe(file: RandomAccessFile, value: Int) {
    file.write(value and 0xff)
    file.write((value shr 8) and 0xff)
    file.write((value shr 16) and 0xff)
    file.write((value shr 24) and 0xff)
  }

  private fun writeShortLe(file: RandomAccessFile, value: Int) {
    file.write(value and 0xff)
    file.write((value shr 8) and 0xff)
  }
}
