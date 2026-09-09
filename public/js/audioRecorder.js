/**
 * Records the candidate's microphone audio ALONGSIDE the Web Speech API
 * (RecognitionEngine) — see
 * docs/project-improvement/VOICE_RECOGNITION_ACCURACY_PLAN.md. This class
 * never produces any transcript itself; it only captures the raw audio so
 * app.js can send it to the server for a real ASR pass (Groq Whisper /
 * Gemini — see transcriptionService.ts) once recording stops, as an
 * improvement over the Web Speech text that's already showing by then.
 *
 * Mirrors RecognitionEngine's start()/startContinue()/stop() shape
 * deliberately, so app.js can drive both engines with matching calls at
 * the same call sites. Every method is a no-op (never throws) when the
 * browser doesn't support MediaRecorder/getUserMedia, or when the
 * candidate denies microphone permission — the whole feature degrades to
 * "no audio captured, Web Speech text stands as-is", never to a broken
 * recording flow.
 */
export class AudioRecorder {
  constructor() {
    this.supported = !!(
      navigator.mediaDevices &&
      typeof navigator.mediaDevices.getUserMedia === 'function' &&
      typeof window.MediaRecorder !== 'undefined'
    );
    this.stream = null;
    this.mediaRecorder = null;
    // Chunks for the CURRENT recording — carried across a startContinue()
    // call (not cleared) so stop() returns the full combined audio,
    // mirroring RecognitionEngine's previousTranscript/finalTranscript
    // merge behavior for "Continue From Here".
    this.chunks = [];
    this.mimeType = '';
  }

  isSupported() {
    return this.supported;
  }

  static _pickMimeType() {
    if (typeof MediaRecorder === 'undefined' || typeof MediaRecorder.isTypeSupported !== 'function') return '';
    const candidates = [
      'audio/webm;codecs=opus',
      'audio/webm',
      'audio/ogg;codecs=opus',
      'audio/ogg',
      'audio/mp4',
    ];
    return candidates.find((c) => MediaRecorder.isTypeSupported(c)) || '';
  }

  async _openStream() {
    return navigator.mediaDevices.getUserMedia({
      audio: {
        channelCount: 1,
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true,
      },
    });
  }

  _releaseStream() {
    if (this.stream) {
      this.stream.getTracks().forEach((track) => track.stop());
      this.stream = null;
    }
  }

  /** Resolves once the current MediaRecorder instance has fully stopped
   *  (its 'stop' event fired) — does NOT touch the mic stream or chunks,
   *  just settles the recorder itself. Never rejects. */
  _stopCurrentRecorderOnly() {
    return new Promise((resolve) => {
      if (!this.mediaRecorder || this.mediaRecorder.state === 'inactive') {
        resolve();
        return;
      }
      const recorder = this.mediaRecorder;
      recorder.addEventListener('stop', () => resolve(), { once: true });
      try {
        recorder.stop();
      } catch (e) {
        resolve();
      }
    });
  }

  async _startRecorder() {
    this.stream = await this._openStream();
    const mimeType = AudioRecorder._pickMimeType();
    this.mediaRecorder = mimeType
      ? new MediaRecorder(this.stream, { mimeType, audioBitsPerSecond: 32000 })
      : new MediaRecorder(this.stream);
    this.mimeType = this.mediaRecorder.mimeType || mimeType || 'audio/webm';

    this.mediaRecorder.addEventListener('dataavailable', (e) => {
      if (e.data && e.data.size > 0) this.chunks.push(e.data);
    });
    // 1s timeslice: periodic flush keeps a long answer from holding its
    // entire audio in one un-flushed buffer, and — because every chunk
    // comes from the SAME MediaRecorder session in order — concatenating
    // them back into one Blob reconstructs a valid file exactly as
    // recorded (this is the standard MediaRecorder chunking pattern).
    this.mediaRecorder.start(1000);
  }

  /** Start a fresh recording — discards anything left over from a
   *  previous unfinished take (defensive: normal call sites already
   *  stop()/discard() before starting again, but this makes start()
   *  itself safe to call unconditionally). */
  async start() {
    if (!this.supported) return;
    await this._stopCurrentRecorderOnly();
    this._releaseStream();
    this.mediaRecorder = null;
    this.chunks = [];
    try {
      await this._startRecorder();
    } catch (e) {
      // Mic permission denied, no device, etc. — fail silently into "no
      // audio this take"; app.js's enhancement step already treats a
      // missing/empty recording as "nothing to improve on", not an error.
      console.warn('[AudioRecorder] Could not start recording:', e && e.message);
      this._releaseStream();
      this.mediaRecorder = null;
    }
  }

  /**
   * Start recording a continuation of the SAME answer ("Continue From
   * Here") — keeps `this.chunks` from the prior segment(s) instead of
   * clearing them, so stop() returns the full combined audio. Note: the
   * concatenated audio spans two separate MediaRecorder sessions (this
   * one and the one(s) before it), which is a best-effort combine rather
   * than a guaranteed-clean single container the way a single session's
   * own timeslice chunks are (see start()'s comment) — in the rare case a
   * downstream decoder handles that awkwardly, the enhancement step just
   * fails closed and the candidate keeps their Web Speech text, same as
   * any other transcription failure.
   */
  async startContinue() {
    if (!this.supported) return;
    await this._stopCurrentRecorderOnly();
    this._releaseStream();
    this.mediaRecorder = null;
    try {
      await this._startRecorder();
    } catch (e) {
      console.warn('[AudioRecorder] Could not continue recording:', e && e.message);
      this._releaseStream();
      this.mediaRecorder = null;
    }
  }

  /**
   * Stops recording and resolves with `{ blob, mimeType }` for everything
   * captured this take (including any startContinue() segments before
   * it), or `null` if nothing usable was captured — unsupported browser,
   * permission denied, or a take with no audio at all. Never rejects.
   */
  async stop() {
    if (!this.supported || !this.mediaRecorder) return null;
    await this._stopCurrentRecorderOnly();
    this._releaseStream();
    const chunks = this.chunks;
    const mimeType = this.mimeType || 'audio/webm';
    this.chunks = [];
    this.mediaRecorder = null;
    if (chunks.length === 0) return null;
    const blob = new Blob(chunks, { type: mimeType });
    if (blob.size === 0) return null;
    return { blob, mimeType };
  }

  /**
   * Abandons the current recording — releases the microphone and discards
   * whatever audio was captured, without resolving anything. Use this
   * (instead of stop()) whenever the answer itself is being discarded:
   * ending the interview early, restarting the app, or any other cleanup
   * path that doesn't want a transcription request fired.
   */
  async discard() {
    if (!this.supported) return;
    await this._stopCurrentRecorderOnly();
    this._releaseStream();
    this.mediaRecorder = null;
    this.chunks = [];
  }
}
