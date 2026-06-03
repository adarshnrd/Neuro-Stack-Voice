export class SpeechEngine {
  constructor() {
    this.synth    = window.speechSynthesis;
    this.voice    = null;
    this.isSpeaking = false;
    this._utterance = null;
    this._keepAliveTimer = null;
  }

  async init(selectElement) {
    return new Promise((resolve) => {
      const populate = () => {
        const voices = this.synth.getVoices();
        if (!voices.length) return;

        selectElement.innerHTML = voices
          .filter(v => v.lang.startsWith('en'))
          .map(v => `<option value="${v.name}">${v.name} (${v.lang})</option>`)
          .join('');

        // Prefer a high-quality English voice
        const preferred = [
          'Google US English',
          'Google UK English Female',
          'Microsoft Aria Online',
          'Samantha',
        ];
        
        let chosen = null;
        for (const name of preferred) {
          chosen = voices.find(v => v.name.includes(name));
          if (chosen) break;
        }
        if (!chosen) {
          chosen = voices.find(v => v.lang === 'en-US') || voices.find(v => v.lang.startsWith('en'));
        }

        if (chosen) {
          this.voice = chosen;
          selectElement.value = chosen.name;
        }

        selectElement.addEventListener('change', (e) => {
          this.voice = this.synth.getVoices().find(v => v.name === e.target.value) || null;
        });

        resolve();
      };

      // Chrome loads voices asynchronously
      if (this.synth.getVoices().length > 0) {
        populate();
      } else {
        this.synth.addEventListener('voiceschanged', populate, { once: true });
        // Fallback timeout in case event doesn't fire
        setTimeout(populate, 1500);
      }
    });
  }

  speak(text, onEnd) {
    this.cancel();
    this.isSpeaking = true;

    // Chrome bug fix: cancel then wait a tick before speaking
    setTimeout(() => {
      const utterance = new SpeechSynthesisUtterance(text);
      utterance.voice  = this.voice;
      utterance.rate   = 0.92;
      utterance.pitch  = 1.0;
      utterance.volume = 1.0;

      utterance.onend = () => {
        this._clearKeepAlive();
        this.isSpeaking = false;
        this._utterance = null;
        if (onEnd) onEnd();
      };

      utterance.onerror = (e) => {
        this._clearKeepAlive();
        // Suppress 'interrupted' — it's normal when we cancel
        if (e.error !== 'interrupted' && e.error !== 'canceled') {
          console.error('[SpeechEngine] Error:', e.error);
        }
        this.isSpeaking = false;
        this._utterance = null;
        if (onEnd) onEnd();
      };

      this._utterance = utterance;
      this.synth.speak(utterance);

      // Chrome workaround: Chrome pauses speechSynthesis after ~15s.
      // Calling pause() + resume() periodically keeps it alive.
      this._startKeepAlive();
    }, 50);
  }

  /**
   * Chrome workaround: Chrome's speechSynthesis auto-pauses after ~15 seconds.
   * This timer forces a pause/resume cycle every 10s to keep the utterance alive.
   */
  _startKeepAlive() {
    this._clearKeepAlive();
    this._keepAliveTimer = setInterval(() => {
      if (this.synth.speaking && !this.synth.paused) {
        this.synth.pause();
        this.synth.resume();
      }
    }, 10_000);
  }

  _clearKeepAlive() {
    if (this._keepAliveTimer) {
      clearInterval(this._keepAliveTimer);
      this._keepAliveTimer = null;
    }
  }

  cancel() {
    this._clearKeepAlive();
    this.synth.cancel();
    this.isSpeaking = false;
    this._utterance = null;
  }
}
