package __ANDROID_AEC_PACKAGE__

import android.Manifest
import android.annotation.SuppressLint
import android.content.Context
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
  }

  @Volatile
  private var isRecording = false
  private var recordingThread: Thread? = null
  private var audioRecord: AudioRecord? = null
  private var outputFile: File? = null
  private var outputDataBytes = 0L
  private var startedAtMs = 0L
  private var sampleRate = DEFAULT_SAMPLE_RATE
  private var audioManager: AudioManager? = null
  private var previousAudioMode: Int? = null
  private var previousSpeakerphoneOn: Boolean? = null
  private var aec: AcousticEchoCanceler? = null
  private var ns: NoiseSuppressor? = null
  private var agc: AutomaticGainControl? = null

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
    if (
      reactContext.checkSelfPermission(Manifest.permission.RECORD_AUDIO) !=
      PackageManager.PERMISSION_GRANTED
    ) {
      promise.reject("E_PERMISSION", "RECORD_AUDIO permission is not granted")
      return
    }

    synchronized(this) {
      if (isRecording) {
        stopRecordingBlocking()
      }
    }

    val requestedRate = if (options?.hasKey("sampleRate") == true) {
      options.getInt("sampleRate")
    } else {
      DEFAULT_SAMPLE_RATE
    }
    val statusIntervalMs = if (options?.hasKey("statusIntervalMs") == true) {
      max(100L, options.getInt("statusIntervalMs").toLong())
    } else {
      DEFAULT_STATUS_INTERVAL_MS
    }

    try {
      startRecording(requestedRate, statusIntervalMs)
      val result = Arguments.createMap().apply {
        putBoolean("started", true)
        putBoolean("aecEnabled", aec?.enabled == true)
        putBoolean("noiseSuppressorEnabled", ns?.enabled == true)
        putBoolean("agcEnabled", agc?.enabled == true)
        putInt("audioSessionId", audioRecord?.audioSessionId ?: -1)
        putInt("sampleRate", sampleRate)
      }
      promise.resolve(result)
    } catch (error: Exception) {
      stopRecordingBlocking()
      promise.reject("E_START_AEC_RECORDER", error.message, error)
    }
  }

  @ReactMethod
  fun stop(promise: Promise) {
    try {
      val result = stopRecordingBlocking()
      promise.resolve(result)
    } catch (error: Exception) {
      promise.reject("E_STOP_AEC_RECORDER", error.message, error)
    }
  }

  @SuppressLint("MissingPermission")
  private fun startRecording(requestedSampleRate: Int, statusIntervalMs: Long) {
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
    val record = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) {
      val format = AudioFormat.Builder()
        .setSampleRate(sampleRate)
        .setEncoding(AudioFormat.ENCODING_PCM_16BIT)
        .setChannelMask(AudioFormat.CHANNEL_IN_MONO)
        .build()
      AudioRecord.Builder()
        .setAudioSource(MediaRecorder.AudioSource.VOICE_COMMUNICATION)
        .setAudioFormat(format)
        .setBufferSizeInBytes(bufferSize)
        .build()
    } else {
      AudioRecord(
        MediaRecorder.AudioSource.VOICE_COMMUNICATION,
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

    configureCommunicationAudioMode()
    configureAudioEffects(record.audioSessionId)

    val file = File(reactContext.cacheDir, "aec-recording-${System.currentTimeMillis()}.wav")
    outputFile = file
    outputDataBytes = 0L
    startedAtMs = System.currentTimeMillis()
    audioRecord = record
    isRecording = true

    recordingThread = Thread({
      recordLoop(record, file, bufferSize, statusIntervalMs)
    }, "AndroidAecRecorder").also { it.start() }
  }

  private fun recordLoop(
    record: AudioRecord,
    file: File,
    bufferSize: Int,
    statusIntervalMs: Long
  ) {
    val buffer = ByteArray(bufferSize)
    var lastStatusAt = 0L

    try {
      RandomAccessFile(file, "rw").use { wav ->
        writeEmptyWavHeader(wav)
        record.startRecording()

        while (isRecording) {
          val read = record.read(buffer, 0, buffer.size)
          if (read > 0) {
            wav.write(buffer, 0, read)
            outputDataBytes += read.toLong()
            val now = System.currentTimeMillis()
            if (now - lastStatusAt >= statusIntervalMs) {
              lastStatusAt = now
              emitStatus(buffer, read, now)
            }
          }
        }

        updateWavHeader(wav, outputDataBytes, sampleRate)
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
    val payload = Arguments.createMap().apply {
      putBoolean("isRecording", true)
      putBoolean("androidAec", true)
      putDouble("metering", metering)
      putDouble("durationMillis", (now - startedAtMs).toDouble())
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

  private fun stopRecordingBlocking(): com.facebook.react.bridge.WritableMap {
    isRecording = false
    recordingThread?.join(2500)
    recordingThread = null
    audioRecord = null

    val file = outputFile
    val result = Arguments.createMap().apply {
      putBoolean("stopped", true)
      putString("uri", file?.let { Uri.fromFile(it).toString() })
      putDouble("sizeBytes", file?.length()?.toDouble() ?: 0.0)
      putDouble("durationMs", (System.currentTimeMillis() - startedAtMs).toDouble())
    }
    outputFile = null
    outputDataBytes = 0L
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
