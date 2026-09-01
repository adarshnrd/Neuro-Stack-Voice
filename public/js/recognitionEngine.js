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
        // Browser stopped recognition (e.g. timeout) — restart automatically
        try {
          this.recognition.start();
          this.isListening = true;
          this._resetSilenceTimer();
        } catch (e) {
          console.warn('[RecognitionEngine] Could not restart:', e);
        }
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

  stop() {
    if (!this.supported) return;
    this.shouldRestart = false;
    this.isListening   = false;
    this.isResumeMode  = false;
    clearTimeout(this.silenceTimer);
    try { this.recognition.stop(); } catch (e) {}
  }
}
