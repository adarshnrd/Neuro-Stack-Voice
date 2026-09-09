export class RecognitionEngine {
  constructor() {
    this.supported = false;
    this.recognition = null;

    const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (!SpeechRecognition) {
      // Don't throw — just mark as unsupported so the rest of the app (auth, etc.) still works.
      console.warn('[RecognitionEngine] Speech Recognition API not available. Voice input will be disabled.');
      return;
    }

    this.supported = true;
    this.recognition = new SpeechRecognition();
    this.recognition.continuous     = true;
    this.recognition.interimResults = true;
    this.recognition.lang           = 'en-US';
    // Ask the browser for up to 3 hypotheses per result instead of just its
    // single best guess — see
    // docs/project-improvement/VOICE_RECOGNITION_ACCURACY_PLAN.md §1/§2.
    // We still use alternative[0] as the live/displayed transcript (the
    // browser's own best guess, unchanged behavior), but this makes
    // event.results[i] carry event.results[i].length > 1 alternatives with
    // their own .confidence, which is what a later low-confidence-highlight
    // pass (or the server-side ASR handoff in app.js) can use. Requesting
    // alternatives costs nothing when unused — most browsers already
    // compute them internally and only expose index 0 by default.
    this.recognition.maxAlternatives = 3;

    this.onResultCallback  = null;
    this.onSilenceCallback = null;

    this.silenceTimer    = null;
    this.silenceDuration = 5000; // 5 seconds of silence → done (configurable)
    this.isListening     = false;
    this.shouldRestart   = false;
    this.finalTranscript = '';

    // Resume/Continue mode
    this.previousTranscript = '';
    this.isResumeMode = false;

    this._setupListeners();
  }

  /**
   * Set silence timeout duration (called from app with server config)
   */
  setSilenceTimeout(ms) {
    this.silenceDuration = ms;
  }

  isSupported() {
    return this.supported;
  }

  _setupListeners() {
    if (!this.supported) return;
    this.recognition.onresult = (event) => {
      this._resetSilenceTimer();

      let interim = '';
      let newFinal = '';

      for (let i = event.resultIndex; i < event.results.length; i++) {
        const res = event.results[i];
        if (res.isFinal) {
          newFinal += res[0].transcript;
        } else {
          interim += res[0].transcript;
        }
      }

      if (newFinal) {
        this.finalTranscript += newFinal + ' ';
      }

      if (this.onResultCallback) {
        // In resume mode, prepend previous transcript to final output
        const displayFinal = this.isResumeMode
          ? `${this.previousTranscript} ${this.finalTranscript}`.trim()
          : this.finalTranscript.trim();

        this.onResultCallback({
          interim: interim.trim(),
          final: displayFinal,
        });
      }
    };

    this.recognition.onerror = (event) => {
      if (event.error === 'no-speech') return; // Harmless
      if (event.error === 'aborted')   return; // Manual stop
      console.error('[RecognitionEngine] Error:', event.error);
    };

    this.recognition.onend = () => {
      this.isListening = false;
      clearTimeout(this.silenceTimer);

      if (this.shouldRestart) {
        // Browser stopped recognition (e.g. its own internal ~60s cap) —
        // restart automatically so a long answer doesn't just cut off.
        //
        // Deferred to the next tick (setTimeout 0) rather than called
        // synchronously here — see
        // docs/project-improvement/VOICE_RECOGNITION_ACCURACY_PLAN.md §1:
        // Chrome can still consider the recognizer "stopping" for a moment
        // after onend fires, and calling start() synchronously inside
        // onend intermittently throws InvalidStateError ("recognition has
        // already started"). That was being silently swallowed by the
        // catch below, which ended the recording early with no restart —
        // the exact "word/segment lost at the restart boundary" failure
        // mode the plan describes. Yielding one tick first gives Chrome a
        // moment to finish tearing down before start() is called again.
        setTimeout(() => {
          if (!this.shouldRestart) return; // stop()/manual stop raced us here
          try {
            this.recognition.start();
            this.isListening = true;
            this._resetSilenceTimer();
          } catch (e) {
            console.warn('[RecognitionEngine] Could not restart:', e);
          }
        }, 0);
      }
    };
  }

  _resetSilenceTimer() {
    clearTimeout(this.silenceTimer);
    this.silenceTimer = setTimeout(() => {
      if (this.isListening) {
        this.shouldRestart = false;
        this.isListening   = false;
        try { this.recognition.stop(); } catch (e) {}

        if (this.onSilenceCallback) {
          // In resume mode, merge previous + new transcript
          const fullText = this.isResumeMode
            ? `${this.previousTranscript} ${this.finalTranscript}`.trim()
            : this.finalTranscript.trim();
          this.onSilenceCallback(fullText);
        }
      }
    }, this.silenceDuration);
  }

  /**
   * Start fresh recording
   */
  start(onResult, onSilence) {
    if (!this.supported) {
      console.warn('[RecognitionEngine] start() called but Speech Recognition is not supported.');
      return;
    }
    this.onResultCallback  = onResult;
    this.onSilenceCallback = onSilence;
    this.finalTranscript   = '';
    this.previousTranscript = '';
    this.isResumeMode      = false;
    this.shouldRestart     = true;

    if (!this.isListening) {
      try {
        this.recognition.start();
        this.isListening = true;
        this._resetSilenceTimer();
      } catch (e) {
        console.error('[RecognitionEngine] Start error:', e);
      }
    }
  }

  /**
   * Start in "continue" mode — preserves previous transcript and appends new speech.
   */
  startContinue(previousText, onResult, onSilence) {
    if (!this.supported) {
      console.warn('[RecognitionEngine] startContinue() called but Speech Recognition is not supported.');
      return;
    }
    this.onResultCallback  = onResult;
    this.onSilenceCallback = onSilence;
    this.previousTranscript = previousText || '';
    this.finalTranscript   = '';
    this.isResumeMode      = true;
    this.shouldRestart     = true;

    if (!this.isListening) {
      try {
        this.recognition.start();
        this.isListening = true;
        this._resetSilenceTimer();
      } catch (e) {
        console.error('[RecognitionEngine] Continue start error:', e);
      }
    }
  }

  /**
   * Stops recognition and returns the final transcript accumulated so far
   * (merging in `previousTranscript` when in resume/"continue" mode).
   *
   * IMPORTANT: the merge is computed and returned HERE, before any state is
   * reset — previously callers (see app.js manualStopRecording) called
   * stop() first and only afterwards read this.isResumeMode /
   * this.previousTranscript to build the merged text themselves. Since
   * stop() clears isResumeMode as one of its first actions, that read
   * always saw it as already false, so the previously-spoken text (from
   * before "Continue From Here" was clicked) was silently dropped and only
   * the newly-recorded segment survived. Returning the merged text from
   * stop() itself removes that ordering hazard entirely.
   */
  stop() {
    if (!this.supported) return '';
    clearTimeout(this.silenceTimer);

    const fullText = this.isResumeMode
      ? `${this.previousTranscript} ${this.finalTranscript}`.trim()
      : this.finalTranscript.trim();

    this.shouldRestart = false;
    this.isListening   = false;
    this.isResumeMode  = false;
    try { this.recognition.stop(); } catch (e) {}

    return fullText;
  }
}
