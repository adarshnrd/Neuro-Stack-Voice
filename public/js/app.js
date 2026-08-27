import { SpeechEngine } from './speechEngine.js';
import { RecognitionEngine } from './recognitionEngine.js';
import { SocketManager } from './socketManager.js';
import { UIManager } from './uiManager.js';
import { AuthManager } from './authManager.js';

// ============================================================
// STATE MACHINE STATES
// ============================================================
const STATE = {
  IDLE:        'idle',
  SETUP:       'setup',
  LOADING:     'loading',
  SPEAKING:    'speaking',
  LISTENING:   'listening',
  EDITING:     'editing',
  EVALUATING:  'evaluating',
  COMPLETE:    'complete',
};

class App {
  constructor() {
    this.ui         = new UIManager();
    this.speech     = new SpeechEngine();
    this.recognition = new RecognitionEngine();
    this.socket     = new SocketManager();
    this.auth       = new AuthManager();
    this.authMode   = 'login'; // 'login' | 'register'

    this.state              = STATE.IDLE;
    this.session            = null;
    this.questions          = [];
    this.currentQuestionIndex = 0;

    // Store per-question evaluations as they come in
    this.evaluationResults  = {};

    // Server config (fetched on init)
    this.serverConfig = {
      questionsPerInterview: 10,
      jdQuestionsPerInterview: 15,
      silenceTimeoutMs: 5000,
    };

    this.init();
  }

  // ---- Transition state ----
  setState(newState) {
    this.state = newState;
    const statusMap = {
      [STATE.IDLE]:       { status: 'idle',       text: 'Ready' },
      [STATE.SETUP]:      { status: 'idle',       text: 'Setting up' },
      [STATE.LOADING]:    { status: 'processing', text: 'Generating...' },
      [STATE.SPEAKING]:   { status: 'speaking',   text: 'Interviewer Speaking' },
      [STATE.LISTENING]:  { status: 'listening',  text: 'Listening to you' },
      [STATE.EDITING]:    { status: 'editing',    text: 'Review your answer' },
      [STATE.EVALUATING]: { status: 'processing', text: 'Evaluating...' },
      [STATE.COMPLETE]:   { status: 'complete',   text: 'Interview Complete' },
    };
    const s = statusMap[newState] || statusMap[STATE.IDLE];
    this.ui.setStatus(s.status, s.text);

    // Show/hide Stop Recording button
    const stopRecBtn = this.ui.el('btn-stop-recording');
    if (stopRecBtn) {
      if (newState === STATE.LISTENING) {
        stopRecBtn.classList.remove('hidden');
      } else {
        stopRecBtn.classList.add('hidden');
      }
    }
  }

  // ---- Init ----
  async init() {
    this._wireAuthForm();

    const user = await this.auth.fetchCurrentUser();
    if (user) {
      await this._onAuthenticated();
    } else {
      this.ui.showPanel('auth-panel');
    }
  }

  // ---- Auth form wiring (login/register panel) ----
  _wireAuthForm() {
    const form = this.ui.el('auth-form');
    const toggleBtn = this.ui.el('btn-auth-toggle');
    if (toggleBtn) {
      toggleBtn.addEventListener('click', () => {
        this.authMode = this.authMode === 'login' ? 'register' : 'login';
        const isLogin = this.authMode === 'login';
        this.ui.el('auth-heading').textContent = isLogin ? 'Sign In to Continue' : 'Create Your Account';
        this.ui.el('btn-auth-submit').textContent = isLogin ? 'Sign In' : 'Create Account';
        this.ui.el('auth-toggle-text').textContent = isLogin ? "Don't have an account?" : 'Already have an account?';
        toggleBtn.textContent = isLogin ? 'Create one' : 'Sign in';
        this.ui.el('auth-password').setAttribute(
          'autocomplete',
          isLogin ? 'current-password' : 'new-password'
        );
        const errEl = this.ui.el('auth-error');
        if (errEl) errEl.classList.add('hidden');
      });
    }

    if (form) {
      form.addEventListener('submit', async (e) => {
        e.preventDefault();
        const email = this.ui.el('auth-email').value.trim();
        const password = this.ui.el('auth-password').value;
        const errEl = this.ui.el('auth-error');
        const submitBtn = this.ui.el('btn-auth-submit');

        if (errEl) errEl.classList.add('hidden');
        if (submitBtn) submitBtn.disabled = true;

        try {
          if (this.authMode === 'login') {
            await this.auth.login(email, password);
          } else {
            await this.auth.register(email, password);
          }
          await this._onAuthenticated();
        } catch (err) {
          if (errEl) {
            errEl.textContent = err.message || 'Something went wrong. Please try again.';
            errEl.classList.remove('hidden');
          }
        } finally {
          if (submitBtn) submitBtn.disabled = false;
        }
      });
    }

    const logoutBtn = this.ui.el('btn-logout');
    if (logoutBtn) {
      logoutBtn.addEventListener('click', () => this._logout());
    }
  }

  async _logout() {
    await this.auth.logout();
    this.socket.disconnect();
    this.restartApp();
    this.ui.el('account-email')?.classList.add('hidden');
    this.ui.el('btn-logout')?.classList.add('hidden');
    this.ui.el('btn-history')?.classList.add('hidden');
    this.ui.showPanel('auth-panel');
  }

  /** Runs once, right after the user is confirmed authenticated (fresh session-check or a successful login/register). */
  async _onAuthenticated() {
    const emailEl = this.ui.el('account-email');
    if (emailEl && this.auth.user) {
      emailEl.textContent = this.auth.user.email;
      emailEl.classList.remove('hidden');
    }
    this.ui.el('btn-logout')?.classList.remove('hidden');
    this.ui.el('btn-history')?.classList.remove('hidden');

    this.socket.connect();

    if (!this._appInitialized) {
      this._appInitialized = true;
      await this._initApp();
    } else {
      this.ui.showPanel('setup-panel');
      this.setState(STATE.SETUP);
    }
  }

  // ---- Main app init (runs once, after the first successful authentication) ----
  async _initApp() {
    // Fetch server config first
    await this.fetchConfig();

    await this.ui.populateSelects();
    await this.speech.init(this.ui.el('voice-select'));

    // Set initial icon for first tech stack item
    this.ui.triggerTechStackChange();

    // Configure recognition engine with server-side silence timeout
    this.recognition.setSilenceTimeout(this.serverConfig.silenceTimeoutMs);

    // Button events
    this.ui.el('btn-start').addEventListener('click', () => this.startInterview());
    this.ui.el('btn-submit-answer').addEventListener('click', () => this.submitAnswer());
    this.ui.el('btn-retry-answer').addEventListener('click', () => this.retryRecording());
    this.ui.el('btn-continue-recording').addEventListener('click', () => this.continueRecording());
    this.ui.el('btn-restart').addEventListener('click', () => this.restartApp());
    this.ui.el('btn-extend').addEventListener('click', () => this.extendInterview());

    // End interview early
    const endBtn = this.ui.el('btn-end-interview');
    if (endBtn) endBtn.addEventListener('click', () => this.endInterviewEarly());

    // History buttons
    const historyBtn = this.ui.el('btn-history');
    if (historyBtn) historyBtn.addEventListener('click', () => this.loadHistory());
    const historyBackBtn = this.ui.el('btn-history-back');
    if (historyBackBtn) historyBackBtn.addEventListener('click', () => {
      this.ui.showPanel('setup-panel');
      this.setState(STATE.SETUP);
    });
    const detailBackBtn = this.ui.el('btn-detail-back');
    if (detailBackBtn) detailBackBtn.addEventListener('click', () => this.loadHistory());

    // Stop recording button
    const stopRecBtn = this.ui.el('btn-stop-recording');
    if (stopRecBtn) {
      stopRecBtn.addEventListener('click', () => this.manualStopRecording());
    }

    // Real-time validation on textarea input
    const editInput = this.ui.el('edit-transcript-input');
    if (editInput) {
      editInput.addEventListener('input', () => this.handleEditInput());
    }

    // API key validation button
    const validateBtn = this.ui.el('btn-validate-key');
    if (validateBtn) {
      validateBtn.addEventListener('click', () => this.validateApiKey());
    }

    // JD textarea character count
    const jdTextarea = this.ui.el('jd-textarea');
    if (jdTextarea) {
      jdTextarea.addEventListener('input', () => {
        const count = jdTextarea.value.length;
        const countEl = this.ui.el('jd-char-count');
        if (countEl) countEl.textContent = count.toLocaleString();
      });
    }

    // Tech stack change handler for JD visibility
    const techEl = this.ui.el('tech-stack');
    if (techEl) {
      techEl.addEventListener('change', () => this.onTechStackChange());
    }

    // Socket events
    this.socket.on('answer:evaluated', (data) => {
      console.log('[App] Evaluation received for Q' + data.questionId, data.evaluation);
      // Store the evaluation
      this.evaluationResults[data.questionId] = data.evaluation;
      // Move to next question
      this.setState(STATE.IDLE);
      this.nextQuestion();
    });

    this.socket.on('interview:complete', (data) => {
      console.log('[App] Interview complete', data);
      this.showCompletion(data.summary);
    });

    this.socket.on('error', (err) => {
      console.error('[App] Socket error:', err);
      this._showToast('Error: ' + (err.message || 'Something went wrong'), 'error');
    });

    // Socket connection state changes
    this.socket.on('disconnect', () => {
      this._showToast('Connection lost. Reconnecting...', 'warning');
    });
    this.socket.on('reconnect', () => {
      this._showToast('Reconnected!', 'success');
    });
    this.socket.on('reconnect_failed', () => {
      this._showToast('Unable to reconnect. Please refresh the page.', 'error');
    });

    this.setState(STATE.SETUP);
  }

  // ---- Fetch server config ----
  async fetchConfig() {
    try {
      const resp = await fetch('/api/interviews/config');
      const data = await resp.json();
      if (data.success) {
        this.serverConfig = data.data;
        // Update question count display
        const countDisplay = this.ui.el('question-count-display');
        if (countDisplay) {
          countDisplay.textContent = `${this.serverConfig.questionsPerInterview} Questions`;
        }
      }
    } catch (err) {
      console.warn('[App] Failed to fetch config, using defaults', err);
    }
  }

  // ---- Tech stack change ----
  onTechStackChange() {
    const techStack = this.ui.el('tech-stack').value;
    const jdGroup = this.ui.el('jd-input-group');
    const countDisplay = this.ui.el('question-count-display');

    if (jdGroup) {
      if (techStack === 'Job Description') {
        jdGroup.classList.remove('hidden');
        if (countDisplay) {
          countDisplay.textContent = `${this.serverConfig.jdQuestionsPerInterview}+ Questions`;
        }
      } else {
        jdGroup.classList.add('hidden');
        if (countDisplay) {
          countDisplay.textContent = `${this.serverConfig.questionsPerInterview} Questions`;
        }
      }
    }
  }

  // ---- Validate API key ----
  async validateApiKey() {
    const keyInput = this.ui.el('user-gemini-key');
    const statusEl = this.ui.el('api-key-status');
    if (!keyInput || !statusEl) return;

    const apiKey = keyInput.value.trim();
    if (!apiKey) {
      statusEl.className = 'api-key-status error';
      statusEl.textContent = '✗ Please enter an API key';
      statusEl.classList.remove('hidden');
      return;
    }

    statusEl.className = 'api-key-status validating';
    statusEl.textContent = '⏳ Validating...';
    statusEl.classList.remove('hidden');

    try {
      const resp = await fetch('/api/settings/api-key/validate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ provider: 'gemini', apiKey }),
      });
      const data = await resp.json();
      
      if (data.success && data.data.isValid) {
        statusEl.className = 'api-key-status success';
        statusEl.textContent = '✓ Valid API key — will be used for your interview';
      } else {
        statusEl.className = 'api-key-status error';
        statusEl.textContent = '✗ Invalid API key — please check and try again';
      }
    } catch (err) {
      statusEl.className = 'api-key-status error';
      statusEl.textContent = '✗ Validation failed — check your connection';
    }
  }

  // ---- Start interview ----
  async startInterview() {
    const techStack = this.ui.el('tech-stack').value;
    const model     = this.ui.el('ai-model').value;

    if (!techStack || !model) {
      this._showToast('Please select a tech stack and AI model.', 'warning');
      return;
    }

    // Build request body
    const body = { techStack, model };

    // Dynamic question count
    if (techStack === 'Job Description') {
      body.questionsCount = this.serverConfig.jdQuestionsPerInterview;
    }

    // JD text
    if (techStack === 'Job Description') {
      const jdText = this.ui.el('jd-textarea')?.value?.trim();
      if (!jdText) {
        this._showToast('Please paste a Job Description before starting.', 'warning');
        return;
      }
      body.jobDescription = jdText;
    }

    // User API key
    const userKey = this.ui.el('user-gemini-key')?.value?.trim();
    if (userKey) {
      body.userApiKey = userKey;
    }

    const questionCount = body.questionsCount || this.serverConfig.questionsPerInterview;

    this.setState(STATE.LOADING);
    this.ui.showPanel('loading-panel');
    this.ui.el('loading-title').textContent   = 'Generating Questions';
    this.ui.el('loading-subtitle').textContent = `AI is preparing ${questionCount} ${techStack === 'Job Description' ? 'JD-based' : techStack} interview questions...`;

    const startBtn = this.ui.el('btn-start');
    startBtn.disabled    = true;
    startBtn.innerHTML   = '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 12a9 9 0 1 1-6.219-8.56"/></svg> Generating...';

    try {
      const resp = await fetch('/api/interviews/start', {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify(body),
      });

      const data = await resp.json();
      if (!data.success) throw new Error(data.error || 'Failed to start');

      this.session              = data.session;
      this.questions            = data.session.questions;
      this.currentQuestionIndex = 0;
      this.evaluationResults    = {};

      this.socket.joinSession(this.session.id);

      // Show interview panel with stack badge
      this.ui.el('interview-stack-badge').textContent = techStack;
      this.ui.showPanel('interview-panel');
      this.askCurrentQuestion();

    } catch (e) {
      console.error('[App] Start interview error:', e);
      this._showToast('Failed to start interview: ' + e.message, 'error');
      this.ui.showPanel('setup-panel');
      this.setState(STATE.SETUP);
      startBtn.disabled  = false;
      startBtn.innerHTML = '<svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor"><polygon points="5 3 19 12 5 21 5 3"/></svg> Start Interview';
    }
  }

  // ---- Ask current question ----
  askCurrentQuestion() {
    if (this.currentQuestionIndex >= this.questions.length) {
      // All questions done — request final evaluation
      this.setState(STATE.EVALUATING);
      this.ui.el('loading-title').textContent   = 'Evaluating Performance';
      this.ui.el('loading-subtitle').textContent = 'AI is analyzing your complete interview...';
      this.ui.showPanel('loading-panel');
      this.socket.endSession(this.session.id);
      return;
    }

    const q = this.questions[this.currentQuestionIndex];
    const qNum = this.currentQuestionIndex + 1;
    const total = this.questions.length;

    // Update UI
    this.ui.el('question-counter').textContent = `Question ${qNum} / ${total}`;
    this.ui.el('progress-pct').textContent      = `${Math.round((qNum / total) * 100)}%`;
    this.ui.el('progress-fill').style.width     = `${(qNum / total) * 100}%`;
    this.ui.el('q-number-badge').textContent    = `Q${qNum}`;
    this.ui.el('current-question').textContent  = q.question;

    // Reset transcript area
    this.ui.resetTranscript();

    // Speak the question
    this.setState(STATE.SPEAKING);
    this.speech.speak(q.question, () => {
      if (this.state === STATE.SPEAKING) {
        this.startListening();
      }
    });
  }

  // ---- Start listening ----
  startListening() {
    this.setState(STATE.LISTENING);
    this.ui.showLiveTranscript();
    this.ui.el('live-transcript').innerHTML = '<span class="placeholder-text">Listening... speak your answer</span>';
    this.ui.setWaveformActive(true);
    this.ui.showSilenceIndicator(this.serverConfig.silenceTimeoutMs);
    this.updateLiveCharCount('');

    this.recognition.start(
      // onResult (interim updates)
      (result) => {
        if (result.final || result.interim) {
          this.ui.updateTranscript(result.interim, result.final);
          this.updateLiveCharCount(result.final);
        }
        // Reset silence indicator on speech
        this.ui.resetSilenceIndicator(this.serverConfig.silenceTimeoutMs);
      },
      // onSilence (auto-detected end)
      (finalText) => {
        this.ui.setWaveformActive(false);
        this.ui.hideSilenceIndicator();
        if (!finalText.trim()) {
          // No speech — keep listening
          this.startListening();
          return;
        }
        // Show edit UI
        this.setState(STATE.EDITING);
        this.ui.showEditTranscript(finalText.trim());
      }
    );
  }

  // ---- Retry recording (from scratch) ----
  retryRecording() {
    this.ui.showLiveTranscript();
    this.startListening();
  }

  // ---- Continue recording (append to existing transcript) ----
  continueRecording() {
    const existingText = this.ui.getEditedTranscript().trim();
    this.setState(STATE.LISTENING);
    this.ui.showLiveTranscript();
    this.ui.el('live-transcript').innerHTML = `
      <span class="final-text">${this.ui._escHtml(existingText)} </span>
      <span class="placeholder-text">Continue speaking...</span>
    `;
    this.ui.setWaveformActive(true);
    this.ui.showSilenceIndicator(this.serverConfig.silenceTimeoutMs);
    this.updateLiveCharCount(existingText);

    this.recognition.startContinue(
      existingText,
      // onResult
      (result) => {
        this.ui.updateTranscript(result.interim, result.final);
        this.updateLiveCharCount(result.final);
        this.ui.resetSilenceIndicator(this.serverConfig.silenceTimeoutMs);
      },
      // onSilence
      (finalText) => {
        this.ui.setWaveformActive(false);
        this.ui.hideSilenceIndicator();
        this.setState(STATE.EDITING);
        this.ui.showEditTranscript(finalText.trim());
      }
    );
  }

  // ---- Submit answer ----
  submitAnswer() {
    const text = this.ui.getEditedTranscript().trim();
    if (!text) {
      this._showToast('Answer cannot be empty. Please re-record or type your answer.', 'warning');
      return;
    }

    const q = this.questions[this.currentQuestionIndex];

    this.setState(STATE.EVALUATING);
    this.ui.showLiveTranscript();
    this.ui.el('live-transcript').innerHTML = '<span class="placeholder-text"><em>Submitting & evaluating answer...</em></span>';

    this.socket.sendFinalAnswer(this.session.id, q.id, text);
  }

  // ---- Next question ----
  nextQuestion() {
    this.currentQuestionIndex++;
    this.askCurrentQuestion();
  }

  // ---- Show completion ----
  showCompletion(summary) {
    this.setState(STATE.COMPLETE);
    this.speech.cancel();

    // Calculate how many questions were actually answered
    const answeredCount = Object.keys(this.evaluationResults).length;
    const totalCount = this.questions.length;

    // Build breakdown from stored per-question evaluations
    this.ui.showCompletion(summary, this.questions, this.evaluationResults, {
      answeredCount,
      totalCount,
    });
  }

  // ---- Extend interview ----
  async extendInterview() {
    if (!this.session) return;

    this.setState(STATE.LOADING);
    this.ui.showPanel('loading-panel');
    this.ui.el('loading-title').textContent = 'Generating More Questions';
    this.ui.el('loading-subtitle').textContent = 'AI is creating new unique questions (avoiding repeats)...';

    try {
      const resp = await fetch(`/api/interviews/${this.session.id}/extend`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ additionalCount: 5 })
      });

      const data = await resp.json();
      if (!data.success) throw new Error(data.error || 'Failed to extend');

      // Update session with new questions
      this.session = data.session;
      this.questions = data.session.questions;
      // currentQuestionIndex should already be at the first new question position

      this.ui.showPanel('interview-panel');
      this.askCurrentQuestion();
    } catch (e) {
      console.error('[App] Extend interview error:', e);
      this._showToast('Failed to extend interview: ' + e.message, 'error');
      this.ui.showPanel('completion-panel');
      this.setState(STATE.COMPLETE);
    }
  }

  // ---- Restart ----
  restartApp() {
    this.session              = null;
    this.questions            = [];
    this.currentQuestionIndex = 0;
    this.evaluationResults    = {};
    this.socket.clearSession();

    const startBtn = this.ui.el('btn-start');
    startBtn.disabled  = false;
    startBtn.innerHTML = '<svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor"><polygon points="5 3 19 12 5 21 5 3"/></svg> Start Interview';

    this.ui.showPanel('setup-panel');
    this.setState(STATE.SETUP);
  }

  // ---- End Interview Early ----
  endInterviewEarly() {
    if (!this.session) return;

    const answered = Object.keys(this.evaluationResults).length;
    const total = this.questions.length;

    const msg = answered === 0
      ? 'You haven\'t answered any questions yet. Are you sure you want to end the interview?'
      : `You\'ve answered ${answered} of ${total} questions. End the interview now and get your results?`;

    if (!confirm(msg)) return;

    // Stop any active speech or recognition
    this.speech.cancel();
    this.recognition.stop();
    this.ui.setWaveformActive(false);
    this.ui.hideSilenceIndicator();

    // Show loading
    this.setState(STATE.EVALUATING);
    this.ui.el('loading-title').textContent = 'Evaluating Performance';
    this.ui.el('loading-subtitle').textContent = answered > 0
      ? `AI is analyzing your ${answered} answered question${answered > 1 ? 's' : ''}...`
      : 'Wrapping up your interview...';
    this.ui.showPanel('loading-panel');

    this.socket.endSession(this.session.id);
  }

  // ---- History ----
  async loadHistory() {
    this.ui.showPanel('history-panel');
    this.setState(STATE.IDLE);

    // Show loading state in list
    const listEl = this.ui.el('history-list');
    if (listEl) listEl.innerHTML = '<p style="text-align:center;color:var(--text-3);padding:40px">Loading history...</p>';

    try {
      const resp = await fetch('/api/interviews/history');
      const data = await resp.json();
      if (data.success) {
        this.ui.renderHistoryList(data.data);
      } else {
        this.ui.renderHistoryList([]);
      }
    } catch (err) {
      console.error('[App] Failed to load history:', err);
      this.ui.renderHistoryList([]);
    }
  }

  async viewHistoryDetail(sessionId) {
    // Show loading
    this.ui.showPanel('history-detail-panel');
    const titleEl = this.ui.el('detail-title');
    if (titleEl) titleEl.textContent = 'Loading...';

    try {
      const resp = await fetch(`/api/interviews/${sessionId}`);
      const data = await resp.json();
      if (data.success) {
        this.ui.renderHistoryDetail(data.data);
      } else {
        this._showToast('Failed to load interview details.', 'error');
        this.loadHistory();
      }
    } catch (err) {
      console.error('[App] Failed to load session detail:', err);
      this._showToast('Failed to load interview details.', 'error');
      this.loadHistory();
    }
  }

  // ---- Manual Stop Recording ----
  manualStopRecording() {
    if (this.state !== STATE.LISTENING) return;

    this.recognition.stop();

    const text = this.recognition.isResumeMode
      ? `${this.recognition.previousTranscript} ${this.recognition.finalTranscript}`.trim()
      : this.recognition.finalTranscript.trim();

    this.ui.setWaveformActive(false);
    this.ui.hideSilenceIndicator();

    this.setState(STATE.EDITING);
    this.ui.showEditTranscript(text);
  }

  // ---- Update Live Character Count & Validation ----
  updateLiveCharCount(text = '') {
    const len = text.length;
    const charCountEl = this.ui.el('live-char-count');
    const warningEl = this.ui.el('live-validation-warning');
    const liveMeta = this.ui.el('live-meta');

    if (liveMeta) {
      if (len > 0) {
        liveMeta.classList.remove('hidden');
      } else {
        liveMeta.classList.add('hidden');
      }
    }

    if (charCountEl) {
      charCountEl.textContent = `${len.toLocaleString()} / 1,000 characters`;
      if (len > 1000) {
        charCountEl.style.color = 'var(--red)';
      } else {
        charCountEl.style.color = 'var(--text-2)';
      }
    }

    if (warningEl) {
      if (len > 1000) {
        warningEl.classList.remove('hidden');
      } else {
        warningEl.classList.add('hidden');
      }
    }
  }

  // ---- Handle Edit Input Validation ----
  handleEditInput() {
    const text = this.ui.getEditedTranscript();
    const len = text.length;
    const charCountEl = this.ui.el('edit-char-count');
    const warningEl = this.ui.el('edit-validation-warning');
    const submitBtn = this.ui.el('btn-submit-answer');
    const editInput = this.ui.el('edit-transcript-input');

    if (charCountEl) {
      charCountEl.textContent = `${len.toLocaleString()} / 1,000 characters`;
      if (len > 1000) {
        charCountEl.style.color = 'var(--red)';
      } else {
        charCountEl.style.color = 'var(--text-2)';
      }
    }

    if (warningEl) {
      if (len > 1000) {
        warningEl.classList.remove('hidden');
      } else {
        warningEl.classList.add('hidden');
      }
    }

    if (editInput) {
      if (len > 1000) {
        editInput.classList.add('error-border');
      } else {
        editInput.classList.remove('error-border');
      }
    }

    if (submitBtn) {
      if (len > 1000) {
        submitBtn.disabled = true;
        submitBtn.style.opacity = '0.5';
        submitBtn.style.cursor = 'not-allowed';
      } else {
        submitBtn.disabled = false;
        submitBtn.style.opacity = '1';
        submitBtn.style.cursor = 'pointer';
      }
    }
  }

  // ---- Toast notification ----
  _showToast(message, type = 'info') {
    // Remove any existing toast
    const existing = document.querySelector('.app-toast');
    if (existing) existing.remove();

    const toast = document.createElement('div');
    toast.className = `app-toast toast-${type}`;
    toast.textContent = message;
    document.body.appendChild(toast);

    // Trigger animation
    requestAnimationFrame(() => {
      toast.classList.add('visible');
    });

    // Auto-dismiss after 4 seconds
    setTimeout(() => {
      toast.classList.remove('visible');
      setTimeout(() => toast.remove(), 300);
    }, 4000);
  }
}

// Boot
document.addEventListener('DOMContentLoaded', () => {
  window.app = new App();
});
