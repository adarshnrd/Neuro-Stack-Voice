import { SpeechEngine } from './speechEngine.js';
import { RecognitionEngine } from './recognitionEngine.js';
import { AudioRecorder } from './audioRecorder.js';
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

// ============================================================
// ANONYMOUS HISTORY (no login required)
// ============================================================
// The server never lets an anonymous caller list "all my sessions"
// (there's no userId to key that query on — see interview.routes.ts), so
// this browser keeps its own list of session ids it has created. Each id
// is an unguessable UUID the server already treats as a bearer capability
// for that one anonymous session (GET /api/interviews/:id works for
// anyone holding the id, same trust model as a share link), so this list
// is just "which of those links are mine" — not itself a secret, and
// fine to sit in localStorage.
const HISTORY_IDS_KEY = 'nsv_history_ids';
const MAX_REMEMBERED_SESSIONS = 100;

// The email box on the setup panel and the lookup box on the history panel
// share one remembered value per browser, purely a convenience so a
// returning visitor isn't asked to retype it every time (see
// docs/OPTIONAL_HISTORY_LOOKUP_PLAN.md — this is still unverified and
// still not an account; it just saves a step on this one browser).
const RETURNING_EMAIL_KEY = 'nsv_returning_email';

// Must match src/sockets/interview.socket.ts's MAX_ANSWER_LENGTH exactly —
// this is only the client-side UX guard (live counter, disabling submit);
// the server enforces the real ceiling independently and is the only copy
// of this number that actually matters for safety. See that file's comment
// for the token-budget reasoning behind the specific value.
const MAX_ANSWER_LENGTH = 4000;

class App {
  constructor() {
    this.ui     = new UIManager();
    this.speech = new SpeechEngine();
    this.auth   = new AuthManager();
    this.authMode = 'login'; // 'login' | 'register'

    this.state              = STATE.IDLE;
    this.session            = null;
    this.questions          = [];
    this.currentQuestionIndex = 0;

    // Store per-question evaluations as they come in (background — see the
    // answer:evaluated socket listener below). Evaluation is now decoupled
    // from answer submission/progression, so this may still be missing an
    // entry for the current or a recent question at any given moment;
    // the completion screen uses the server's canonical arrays instead of
    // this map (see showCompletion) for exactly that reason.
    this.evaluationResults  = {};
    // The user's own answer text per questionId, populated the moment each
    // answer is submitted (not when it's scored) — this is what lets the
    // interview move on immediately instead of waiting for AI evaluation.
    this.answers = {};

    // Number-of-questions control (see
    // docs/project-improvement/RESUME_MODE_PLAN.md §7.2) —
    // questionCountExplicit stays false until the user actually interacts
    // with the control, so startInterview()'s default behavior (per-stack
    // server defaults) is byte-for-byte what it was before this control
    // existed.
    this.questionCountExplicit = false;
    this.questionCountValue = null;

    // Resume mode's extracted profile (see analyzeResume()) — null until
    // POST /resume/analyze succeeds, and reset to null the moment the
    // resume textarea is edited afterward so a stale profile never
    // silently starts an interview that doesn't match what's pasted.
    this.resumeProfile = null;

    // Server config (fetched on init)
    this.serverConfig = {
      questionsPerInterview: 10,
      jdQuestionsPerInterview: 15,
      silenceTimeoutMs: 5000,
    };

    // Wire auth form NOW — before any engine that could throw, so login/register
    // always works even if Speech Recognition or Socket.IO is unavailable.
    this._wireAuthForm();

    // Engines that may not be available in all browsers / on cold boot:
    try {
      this.recognition = new RecognitionEngine();
    } catch (e) {
      console.warn('[App] Speech Recognition unavailable:', e.message);
      this.recognition = null;
    }

    // Records raw mic audio ALONGSIDE recognition, purely to let the
    // server improve the transcript before submit — see
    // docs/project-improvement/VOICE_RECOGNITION_ACCURACY_PLAN.md. Never
    // required for the app to function: every call site below already
    // treats a missing/unsupported recorder as "nothing to improve",
    // never as an error.
    try {
      this.audioRecorder = new AudioRecorder();
    } catch (e) {
      console.warn('[App] Audio recording unavailable:', e.message);
      this.audioRecorder = null;
    }
    // Bumped on every new recording take (start/retry/continue) and on
    // submit/restart/early-end — an in-flight transcript enhancement
    // captures the token at call time and checks it still matches before
    // writing into the edit box, so a slow server response from an
    // ABANDONED take can never clobber whatever the candidate is doing now.
    this._enhanceToken = 0;

    try {
      this.socket = new SocketManager();
    } catch (e) {
      console.warn('[App] SocketManager failed to init:', e.message);
      this.socket = null;
    }

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
      // Label reflects what's actually happening now: this state covers the
      // brief window between submitting an answer and the server's
      // 'answer:received' ack (fast — just persisting the answer), or the
      // final interview-wide evaluation after the last question. It is NOT
      // waiting on this answer's individual AI scoring anymore — that now
      // runs in the background (see the answer:received/answer:evaluated
      // socket listeners in app.js).
      [STATE.EVALUATING]: { status: 'processing', text: 'Submitting...' },
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
    // Note: _wireAuthForm() is called in the constructor before this, so auth UI
    // is always wired regardless of whether speech/socket engines succeeded.
    //
    // An account is optional, not a gate (see the anonymous-session
    // redesign this app is built around — interview.routes.ts's
    // attachUserIfPresent, and docs/OPTIONAL_HISTORY_LOOKUP_PLAN.md): a
    // real login just ties history to that account instead of to a
    // browser + optional email. So a visitor with no session goes
    // straight to the setup panel as a guest, exactly like one who has an
    // account — the auth panel is reached only via the header's "Sign in"
    // button, never forced on load.
    const user = await this.auth.fetchCurrentUser();
    if (user) {
      await this._onAuthenticated();
    } else {
      await this._continueAsGuest();
    }
  }

  /** Boots the app for a visitor with no account session — same setup flow an authenticated user gets, just with "Sign in" offered instead of an account email/Log out. */
  async _continueAsGuest() {
    this.ui.el('btn-signin')?.classList.remove('hidden');

    // The socket uses autoConnect:false (see socketManager.js) and the
    // server accepts anonymous handshakes (src/sockets/auth.ts) — but
    // nothing opens the connection until something calls connect(), and
    // this guest path is the ONLY boot path most visitors ever take now
    // that login is optional, not required. Missing this line here was a
    // real regression: submitting an answer, receiving its evaluation, and
    // ending the interview are all Socket.IO-only (no HTTP fallback), so
    // without a connected socket every one of those calls just queues on a
    // transport that never opens — the UI hangs on "Submitting answer..."
    // forever with no error, no timeout, nothing server-side to debug.
    if (this.socket) this.socket.connect();

    if (!this._appInitialized) {
      this._appInitialized = true;
      await this._initApp();
    } else {
      this.ui.showPanel('setup-panel');
      this.setState(STATE.SETUP);
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
          // Attach this browser's pre-account (anonymous) history to the
          // account that just logged in/registered, so it doesn't get
          // left behind. Best-effort — see _claimLocalHistory.
          await this._claimLocalHistory();
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

    // Sign in is an optional upgrade, reachable any time from the header —
    // not a gate the app starts behind. See init()/_continueAsGuest().
    const signinBtn = this.ui.el('btn-signin');
    if (signinBtn) {
      signinBtn.addEventListener('click', () => this.ui.showPanel('auth-panel'));
    }
    const authCancelBtn = this.ui.el('btn-auth-cancel');
    if (authCancelBtn) {
      authCancelBtn.addEventListener('click', () => {
        const errEl = this.ui.el('auth-error');
        if (errEl) errEl.classList.add('hidden');
        this.ui.showPanel('setup-panel');
        this.setState(STATE.SETUP);
      });
    }
  }

  async _logout() {
    await this.auth.logout();
    if (this.socket) this.socket.disconnect();
    this.restartApp();
    this.ui.el('account-email')?.classList.add('hidden');
    this.ui.el('btn-logout')?.classList.add('hidden');
    // History stays available (anonymous local + email lookup both work
    // without an account) — only the account-only affordances above hide.
    this.ui.el('btn-signin')?.classList.remove('hidden');
    // Straight back to the setup panel as a guest, not the auth panel —
    // signing out shouldn't force a re-login to keep using the app.
    await this._continueAsGuest();
  }

  /** Runs once, right after the user is confirmed authenticated (fresh session-check or a successful login/register). */
  async _onAuthenticated() {
    const emailEl = this.ui.el('account-email');
    if (emailEl && this.auth.user) {
      emailEl.textContent = this.auth.user.email;
      emailEl.classList.remove('hidden');
      this.ui.el('btn-logout')?.classList.remove('hidden');
    }
    this.ui.el('btn-signin')?.classList.add('hidden');

    if (this.socket) this.socket.connect();

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
    this.ui.populateLevelPicker(this.serverConfig.difficultyLevels);
    await this.speech.init(this.ui.el('voice-select'));

    // Set initial icon for first tech stack item
    this.ui.triggerTechStackChange();

    // Configure recognition engine with server-side silence timeout
    if (this.recognition) this.recognition.setSilenceTimeout(this.serverConfig.silenceTimeoutMs);

    // Button events
    this.ui.el('btn-start').addEventListener('click', () => this.startInterview());
    this.ui.el('btn-submit-answer').addEventListener('click', () => this.submitAnswer());
    this.ui.el('btn-retry-answer').addEventListener('click', () => this.retryRecording());
    this.ui.el('btn-continue-recording').addEventListener('click', () => this.continueRecording());
    this.ui.el('btn-undo-enhance')?.addEventListener('click', () => this._undoTranscriptEnhance());
    this.ui.el('btn-restart').addEventListener('click', () => this.restartApp());
    this.ui.el('btn-extend').addEventListener('click', () => this.extendInterview());

    // "Refresh overall feedback" — see RICH_EVALUATION_SCALE_PLAN.md §6.
    // Shown only when finalEvaluation.overallFeedbackStatus is 'stale'.
    const refreshFeedbackBtn = this.ui.el('btn-refresh-feedback');
    if (refreshFeedbackBtn) refreshFeedbackBtn.addEventListener('click', () => this.refreshOverallFeedback());
    const detailRefreshFeedbackBtn = this.ui.el('btn-detail-refresh-feedback');
    if (detailRefreshFeedbackBtn) detailRefreshFeedbackBtn.addEventListener('click', () => this.refreshHistoryDetailFeedback());

    // "How would I answer this?" — on-demand guidance for a question whose
    // scoring genuinely failed (see uiManager.js's isFailed branch). The
    // button is generated HTML (re-rendered every time the breakdown
    // updates), so this is delegated on the two containers that host it,
    // same reasoning as uiManager.js's own _bindDelegatedListeners for the
    // accordion header — an individually-attached listener would be lost
    // on the next re-render.
    const completionBreakdown = this.ui.el('questions-breakdown');
    if (completionBreakdown) completionBreakdown.addEventListener('click', (e) => {
      const btn = e.target.closest('.q-guidance-btn');
      if (!btn || !completionBreakdown.contains(btn)) return;
      this.getAnswerGuidance(this.session?.id, Number(btn.dataset.questionId), btn, 'questions-breakdown');
    });
    const detailBreakdown = this.ui.el('detail-questions-breakdown');
    if (detailBreakdown) detailBreakdown.addEventListener('click', (e) => {
      const btn = e.target.closest('.q-guidance-btn');
      if (!btn || !detailBreakdown.contains(btn)) return;
      this.getAnswerGuidance(this._historyDetailSessionId, Number(btn.dataset.questionId), btn, 'detail-questions-breakdown');
    });

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

    // Delegated click on each history card (bound once on the static list
    // container, not per-card) — previously an inline onclick="" baked into
    // uiManager.js's generated HTML, which production's CSP blocks
    // (script-src-attr 'none', no 'unsafe-inline' — see
    // docs/audit/01-BACKLOG-P0-P3.md [P2-01]). History cards never opened
    // in production; this replaces that with a real listener.
    const historyListEl = this.ui.el('history-list');
    if (historyListEl) {
      historyListEl.addEventListener('click', (event) => {
        const card = event.target.closest('.history-card');
        if (!card || !historyListEl.contains(card)) return;
        const sessionId = card.dataset.sessionId;
        if (sessionId) this.viewHistoryDetail(sessionId);
      });
    }

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

    // Save-for-later email field on the setup panel: prefill it with
    // whatever email this browser last used, and show a light confirmation
    // once it looks like a real address. See RETURNING_EMAIL_KEY.
    const returningEmailInput = this.ui.el('returning-email');
    if (returningEmailInput) {
      returningEmailInput.value = this._getRememberedEmail();
      returningEmailInput.addEventListener('input', () => this._updateReturningEmailHint());
      this._updateReturningEmailHint();
    }
    const gotoHistoryFromSetupBtn = this.ui.el('btn-goto-history-from-setup');
    if (gotoHistoryFromSetupBtn) {
      gotoHistoryFromSetupBtn.addEventListener('click', () => this.loadHistory());
    }

    // Email lookup box on the history panel — the single place that ever
    // asks for an email to find past interviews (see loadHistory() /
    // handleHistoryEmailLookup()).
    const historyLookupBtn = this.ui.el('btn-history-lookup');
    if (historyLookupBtn) {
      historyLookupBtn.addEventListener('click', () => this.handleHistoryEmailLookup());
    }
    const clearRememberedEmailBtn = this.ui.el('btn-clear-remembered-email');
    if (clearRememberedEmailBtn) {
      clearRememberedEmailBtn.addEventListener('click', () => {
        this._forgetEmail();
        const lookupInput = this.ui.el('history-lookup-email');
        if (lookupInput) lookupInput.value = '';
        this._renderHistoryEmailLookupBox();
        this._loadCombinedHistory();
      });
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

    // Resume textarea character count (see
    // docs/project-improvement/RESUME_MODE_PLAN.md §10.1)
    const resumeTextarea = this.ui.el('resume-textarea');
    if (resumeTextarea) {
      resumeTextarea.addEventListener('input', () => {
        const count = resumeTextarea.value.length;
        const countEl = this.ui.el('resume-char-count');
        if (countEl) countEl.textContent = count.toLocaleString();
        // The pasted text no longer matches whatever was last analyzed —
        // stop letting a stale profile silently start the interview.
        if (this.resumeProfile) {
          this.resumeProfile = null;
          this.ui.el('resume-analysis-summary')?.classList.add('hidden');
          this.ui.el('resume-analysis-status')?.classList.add('hidden');
        }
      });
    }

    const analyzeResumeBtn = this.ui.el('btn-analyze-resume');
    if (analyzeResumeBtn) {
      analyzeResumeBtn.addEventListener('click', () => this.analyzeResume());
    }

    // "Use this level" nudge inside the resume analysis summary — that
    // panel is re-rendered via innerHTML (uiManager.renderResumeAnalysis),
    // so this is delegated on the static container the same way the
    // history-card and accordion listeners elsewhere in this file are.
    const resumeSummaryEl = this.ui.el('resume-analysis-summary');
    if (resumeSummaryEl) {
      resumeSummaryEl.addEventListener('click', (event) => {
        const btn = event.target.closest('.btn-use-suggested-level');
        if (!btn || !resumeSummaryEl.contains(btn)) return;
        this.ui.selectLevelById(btn.dataset.levelId);
        btn.closest('.resume-level-nudge')?.remove();
      });
    }

    // Number-of-questions control (see RESUME_MODE_PLAN.md §7.2). Left
    // untouched, this changes nothing — startInterview() falls back to
    // exactly today's per-stack default. Clicking a preset or typing a
    // valid custom value marks the choice explicit and sends it for ANY
    // tech stack, including Resume and Job Description.
    const countOptionsEl = this.ui.el('question-count-options');
    if (countOptionsEl) {
      countOptionsEl.addEventListener('click', (event) => {
        const btn = event.target.closest('.count-option');
        if (!btn || !countOptionsEl.contains(btn)) return;
        this._selectQuestionCountOption(btn);
        const customInput = this.ui.el('question-count-custom');
        if (btn.dataset.count === 'custom') {
          customInput?.classList.remove('hidden');
          customInput?.focus();
          // Not explicit until a valid number is actually typed below.
          this.questionCountExplicit = false;
        } else {
          customInput?.classList.add('hidden');
          this.questionCountValue = Number(btn.dataset.count);
          this.questionCountExplicit = true;
        }
        this._updateQuestionCountDisplay();
      });
    }
    const countCustomInput = this.ui.el('question-count-custom');
    if (countCustomInput) {
      countCustomInput.addEventListener('input', () => {
        const n = Number(countCustomInput.value);
        this.questionCountExplicit = Number.isInteger(n) && n >= 1 && n <= 50;
        if (this.questionCountExplicit) this.questionCountValue = n;
        this._updateQuestionCountDisplay();
      });
    }

    // Tech stack change handler for JD/Resume visibility
    const techEl = this.ui.el('tech-stack');
    if (techEl) {
      techEl.addEventListener('change', () => this.onTechStackChange());
    }

    // Socket events (only wire if socket is available)
    //
    // Answer submission and its AI evaluation are decoupled server-side
    // (see interview.service.ts's submitAnswer/_evaluateAndPersist): the
    // server acks the answer immediately via 'answer:received', and the
    // scoring/feedback for it arrives separately, whenever the AI call
    // finishes, via 'answer:evaluated'. Progression to the next question
    // must happen on the FAST event, not the slow one — that's the whole
    // point of the change (previously the interview stalled on every
    // question waiting for the AI evaluation call, including retries and
    // fallback delays).
    if (this.socket) this.socket.on('answer:received', (data) => {
      console.log('[App] Answer received for Q' + data.questionId + ' — advancing');
      this.setState(STATE.IDLE);
      this.nextQuestion();
    });

    // Per the approved design, scoring that completes in the background
    // stays silent mid-interview (no live indicator) — just record it for
    // the completion/history views. The completion screen itself doesn't
    // even read this map (see showCompletion) since the server's bounded
    // wait in endSession already returns the canonical answers/evaluations
    // for every question; this is kept only in case future UI wants a
    // live indicator.
    if (this.socket) this.socket.on('answer:evaluated', (data) => {
      console.log('[App] Evaluation received for Q' + data.questionId, data.evaluation);
      this.evaluationResults[data.questionId] = data.evaluation;
    });

    if (this.socket) this.socket.on('interview:complete', (data) => {
      console.log('[App] Interview complete', data);
      this.showCompletion(data);
    });

    // A provider auto-switch happened mid-session while scoring an answer
    // (primary AI model didn't respond or errored, a fallback took over) —
    // surfaced once, quietly, as a toast rather than interrupting the
    // interview flow. reason === 'primary_timeout' means the first AI
    // simply never responded (our own ~120s request timeout — see
    // interview.service.ts's runWithProviderChain) rather than returning an
    // error, which reads better with different wording. Auto-dismisses
    // after 5s (vs. the default 4s) — this one's reassuring the candidate
    // mid-wait, worth a beat longer on screen.
    if (this.socket) this.socket.on('provider:switch', (data) => {
      const message = data.reason === 'primary_timeout'
        ? `The first AI didn't respond — reviewing with ${data.to} instead. Just a moment…`
        : `Switched to ${data.to} — ${data.from} was unavailable. Your interview continues normally.`;
      this._showToast(message, 'warning', 5000);
    });

    if (this.socket) this.socket.on('error', (err) => {
      console.error('[App] Socket error:', err);
      this._showToast('Error: ' + (err.message || 'Something went wrong'), 'error');
    });

    // Socket connection state changes
    if (this.socket) this.socket.on('disconnect', () => {
      this._showToast('Connection lost. Reconnecting...', 'warning');
    });
    if (this.socket) this.socket.on('reconnect', () => {
      this._showToast('Reconnected!', 'success');
    });
    if (this.socket) this.socket.on('reconnect_failed', () => {
      this._showToast('Unable to reconnect. Please refresh the page.', 'error');
    });

    // Server restarted (e.g. Render free-tier spin-down) — session is gone.
    window.addEventListener('socket:session-expired', () => {
      this._showToast('Server restarted — refreshing connection...', 'warning');
      // Re-connect with a fresh socket after a short delay
      setTimeout(() => {
        if (this.socket) this.socket.connect();
      }, 2000);
    });

    window.addEventListener('socket:reconnect-failed', () => {
      this._showToast('Connection lost. Please refresh the page.', 'error');
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
    const resumeGroup = this.ui.el('resume-input-group');
    const countDisplay = this.ui.el('question-count-display');

    if (jdGroup) jdGroup.classList.toggle('hidden', techStack !== 'Job Description');
    if (resumeGroup) resumeGroup.classList.toggle('hidden', techStack !== 'Resume');

    // The "N Questions" summary only reflects the per-stack default while
    // the number-of-questions control (below) hasn't been explicitly
    // touched — an explicit user choice always wins over a stack switch.
    if (!this.questionCountExplicit && countDisplay) {
      if (techStack === 'Job Description') {
        countDisplay.textContent = `${this.serverConfig.jdQuestionsPerInterview}+ Questions`;
      } else {
        countDisplay.textContent = `${this.serverConfig.questionsPerInterview} Questions`;
      }
    }
  }

  // ---- Number-of-questions control helpers ----
  _selectQuestionCountOption(activeBtn) {
    const container = this.ui.el('question-count-options');
    if (!container) return;
    container.querySelectorAll('.count-option').forEach((el) => {
      el.classList.toggle('selected', el === activeBtn);
    });
  }

  _updateQuestionCountDisplay() {
    const countDisplay = this.ui.el('question-count-display');
    const hint = this.ui.el('question-count-hint');
    if (this.questionCountExplicit && this.questionCountValue) {
      if (countDisplay) countDisplay.textContent = `${this.questionCountValue} Questions`;
      if (hint) hint.textContent = `${this.questionCountValue} question${this.questionCountValue === 1 ? '' : 's'} will be generated.`;
    } else {
      // No explicit choice (yet) — fall back to the per-stack default
      // text, same as before this control existed.
      this.onTechStackChange();
      if (hint) hint.textContent = 'Using the default for your tech stack.';
    }
  }

  // ---- Resume analysis (Resume mode pass 1 — see
  // docs/project-improvement/RESUME_MODE_PLAN.md §4.1/§9/§10.1) ----
  async analyzeResume() {
    const textarea = this.ui.el('resume-textarea');
    const statusEl = this.ui.el('resume-analysis-status');
    const btn = this.ui.el('btn-analyze-resume');
    if (!textarea || !statusEl || !btn) return;

    const resumeText = textarea.value.trim();
    if (!resumeText) {
      this._showToast('Please paste your resume text first.', 'warning');
      return;
    }
    if (resumeText.length > 10000) {
      this._showToast('Resume text must not exceed 10,000 characters.', 'warning');
      return;
    }

    statusEl.className = 'api-key-status validating';
    statusEl.textContent = '⏳ Analyzing your resume...';
    statusEl.classList.remove('hidden');
    this.ui.el('resume-analysis-summary')?.classList.add('hidden');

    btn.disabled = true;
    const originalHtml = btn.innerHTML;
    btn.innerHTML = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 12a9 9 0 1 1-6.219-8.56"/></svg> Analyzing...';

    try {
      // Reuse whatever AI model is currently selected — resume analysis
      // goes through the same provider-fallback chain as every other AI
      // call (see interviewService.analyzeResume), so this just keeps the
      // model consistent with the interview that follows it.
      const model = this.ui.el('ai-model')?.value || undefined;
      const userKey = this.ui.el('user-gemini-key')?.value?.trim() || undefined;
      const resp = await fetch('/api/interviews/resume/analyze', {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({ resumeText, model, userApiKey: userKey }),
      });
      const data = await resp.json();
      if (!data.success) throw new Error(data.error || 'Failed to analyze resume');

      this.resumeProfile = data.data;
      statusEl.className = 'api-key-status success';
      statusEl.textContent = '✓ Resume analyzed — review the summary below';

      this.ui.renderResumeAnalysis(this.resumeProfile, this.ui.getSelectedLevel());
      this.ui.el('resume-analysis-summary')?.classList.remove('hidden');

      if (data.providerSwitch) {
        this._showToast(
          `Switched to ${data.providerSwitch.to} — ${data.providerSwitch.from} was unavailable.`,
          'warning'
        );
      }
    } catch (e) {
      console.error('[App] Resume analysis error:', e);
      statusEl.className = 'api-key-status error';
      statusEl.textContent = '✗ ' + (e.message || 'Failed to analyze resume — please try again');
      this.resumeProfile = null;
    } finally {
      btn.disabled  = false;
      btn.innerHTML = originalHtml;
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
    const difficultyLevel = this.ui.getSelectedLevel();
    const body = { techStack, model, difficultyLevel };

    // Dynamic question count. An explicit choice from the
    // number-of-questions control (see onTechStackChange/analyzeResume
    // area above) always wins, for any tech stack — see
    // RESUME_MODE_PLAN.md §7.2. Left untouched, this is byte-for-byte
    // the same fallback as before that control existed: JD mode requests
    // its own larger default, every other stack (including Resume) sends
    // nothing and lets the server apply its own default/floor.
    if (this.questionCountExplicit && this.questionCountValue) {
      body.questionsCount = this.questionCountValue;
    } else if (techStack === 'Job Description') {
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

    // Resume profile — must already be analyzed (see analyzeResume()).
    // Only the extracted, PII-stripped profile is sent here; the raw
    // resume text itself never leaves the /resume/analyze call. See
    // RESUME_MODE_PLAN.md §5/§9.
    if (techStack === 'Resume') {
      if (!this.resumeProfile) {
        this._showToast('Please analyze your resume before starting.', 'warning');
        return;
      }
      body.resumeProfile = this.resumeProfile;
    }

    // User API key
    const userKey = this.ui.el('user-gemini-key')?.value?.trim();
    if (userKey) {
      body.userApiKey = userKey;
    }

    // Optional returning-visitor email (see the "Returning?" box on the
    // setup panel) — tags this new session so it shows up in a future
    // email-based history lookup. No account, no verification; purely a
    // convenience label. Leaving it blank starts fully anonymously, same
    // as always.
    const historyEmail = this.ui.el('returning-email')?.value?.trim();
    if (historyEmail) {
      body.historyEmail = historyEmail;
    }

    const questionCount = body.questionsCount || this.serverConfig.questionsPerInterview;
    const stackLabel = techStack === 'Job Description' ? 'JD-based'
      : techStack === 'Resume' ? 'resume-based'
      : techStack;

    this.setState(STATE.LOADING);
    this.ui.showPanel('loading-panel');
    this.ui.el('loading-title').textContent   = 'Generating Questions';
    this.ui.el('loading-subtitle').textContent = `AI is preparing ${questionCount} ${stackLabel} interview questions...`;

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
      this.answers              = {};

      // Remember this session locally so it shows up under History even
      // without an account — see the ANONYMOUS HISTORY note near STATE.
      this._rememberSessionId(this.session.id);

      // Remember the email itself too (if one was given), so this browser
      // doesn't have to ask again next time History is opened.
      if (historyEmail) this._rememberEmail(historyEmail);

      if (data.providerSwitch) {
        this._showToast(
          `Switched to ${data.providerSwitch.to} — ${data.providerSwitch.from} was unavailable. Your interview continues normally.`,
          'warning'
        );
      }

      if (this.socket) this.socket.joinSession(this.session.id);

      // Show interview panel with stack + level badges
      this.ui.el('interview-stack-badge').textContent = techStack;
      const levelBadgeEl = this.ui.el('interview-level-badge');
      if (levelBadgeEl) levelBadgeEl.textContent = this.ui.getLevelLabel(this.session.difficultyLevel);
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
      this.ui.el('loading-subtitle').textContent = "AI is scoring your answers — this can take a bit longer if we need to try a backup AI, but we'll wait for real results.";
      this.ui.showPanel('loading-panel');
      if (this.socket) this.socket.endSession(this.session.id);
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
    if (!this.recognition || !this.recognition.supported) {
      this._showToast('Speech Recognition is not available in this browser. Please use Chrome.', 'error');
      return;
    }
    // A fresh take starts — invalidate any transcript enhancement still
    // in flight from a previous (now-abandoned) take. See the field's
    // doc comment in the constructor.
    this._enhanceToken++;
    this.ui.hideEnhanceStatus();
    this.setState(STATE.LISTENING);
    this.ui.showLiveTranscript();
    this.ui.el('live-transcript').innerHTML = '<span class="placeholder-text">Listening... speak your answer</span>';
    this.ui.setWaveformActive(true);
    this.ui.showSilenceIndicator(this.serverConfig.silenceTimeoutMs);
    this.updateLiveCharCount('');

    // Fire-and-forget, in parallel with recognition — see
    // docs/project-improvement/VOICE_RECOGNITION_ACCURACY_PLAN.md. Never
    // blocks the (synchronous, already-working) Web Speech flow above;
    // a denied mic permission or unsupported browser just means no audio
    // is captured for the later enhancement step.
    if (this.audioRecorder) this.audioRecorder.start();

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
          if (this.audioRecorder) this.audioRecorder.discard();
          this.startListening();
          return;
        }
        // Show edit UI
        const text = finalText.trim();
        this.setState(STATE.EDITING);
        this.ui.showEditTranscript(text);
        this._enhanceTranscriptWithAudio(text);
      }
    );
  }

  // ---- Retry recording (from scratch) ----
  retryRecording() {
    if (this.audioRecorder) this.audioRecorder.discard();
    this.ui.showLiveTranscript();
    this.startListening();
  }

  // ---- Continue recording (append to existing transcript) ----
  continueRecording() {
    const existingText = this.ui.getEditedTranscript().trim();
    this._enhanceToken++;
    this.ui.hideEnhanceStatus();
    this.setState(STATE.LISTENING);
    this.ui.showLiveTranscript();
    this.ui.el('live-transcript').innerHTML = `
      <span class="final-text">${this.ui._escHtml(existingText)} </span>
      <span class="placeholder-text">Continue speaking...</span>
    `;
    this.ui.setWaveformActive(true);
    this.ui.showSilenceIndicator(this.serverConfig.silenceTimeoutMs);
    this.updateLiveCharCount(existingText);

    // Keeps whatever audio was already captured for `existingText` and
    // appends this segment to it — see AudioRecorder.startContinue's doc
    // comment for the one caveat (cross-session concatenation is
    // best-effort, not guaranteed-clean).
    if (this.audioRecorder) this.audioRecorder.startContinue();

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
        const text = finalText.trim();
        this.setState(STATE.EDITING);
        this.ui.showEditTranscript(text);
        this._enhanceTranscriptWithAudio(text);
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

    // This answer is final now — invalidate any transcript enhancement
    // still in flight so a late response can never write into the NEXT
    // question's (unrelated) edit box.
    this._enhanceToken++;
    this.ui.hideEnhanceStatus();

    const q = this.questions[this.currentQuestionIndex];

    // Record the user's own answer text locally right away — this is the
    // fast path now: the server persists it immediately and acks via
    // 'answer:received' (see the socket listener in _initApp), without
    // waiting for AI scoring. Keeping our own copy here means the
    // completion screen can show "what you answered" even before this
    // question's evaluation (or the server's canonical answers array)
    // comes back.
    this.answers[q.id] = text;

    this.setState(STATE.EVALUATING);
    this.ui.showLiveTranscript();
    this.ui.el('live-transcript').innerHTML = '<span class="placeholder-text"><em>Submitting answer...</em></span>';

    if (this.socket) this.socket.sendFinalAnswer(this.session.id, q.id, text);
  }

  // ---- Next question ----
  nextQuestion() {
    this.currentQuestionIndex++;
    this.askCurrentQuestion();
  }

  // ---- Show completion ----
  // `data` is the full 'interview:complete' socket payload: { summary,
  // answers, evaluations, providerSwitch? }. We use the server's answers/
  // evaluations arrays (not this.answers/this.evaluationResults) as the
  // source of truth here — endSession bounded-waits for any evaluations
  // still in flight and fills in "unavailable" placeholders for anything
  // that didn't finish in time (see interview.service.ts), so the server's
  // copy is always the complete, canonical picture; this browser's own
  // maps could be missing an entry if, say, the tab was slow to receive an
  // answer:evaluated event before the user clicked "End Interview".
  showCompletion(data) {
    this.setState(STATE.COMPLETE);
    this.speech.cancel();

    const answersById = {};
    (data.answers || []).forEach((a) => { answersById[a.questionId] = a.text; });

    const evaluationsById = {};
    (data.evaluations || []).forEach((e) => { evaluationsById[e.questionId] = e; });

    const answeredCount = (data.answers || []).length;
    const totalCount = this.questions.length;

    this.ui.showCompletion(data.summary, this.questions, evaluationsById, answersById, {
      answeredCount,
      totalCount,
      difficultyLevel: this.session?.difficultyLevel,
    });

    if (data.providerSwitch) {
      this._showToast(
        `Switched to ${data.providerSwitch.to} — ${data.providerSwitch.from} was unavailable. Your interview continues normally.`,
        'warning'
      );
    }
  }

  // ---- Refresh overall feedback (completion panel) ----
  // See RICH_EVALUATION_SCALE_PLAN.md §6: the score is always kept current
  // automatically, but the narrative only updates when explicitly asked —
  // this is that explicit ask, surfaced via the "stale" banner's button.
  async refreshOverallFeedback() {
    if (!this.session) return;
    const btn = this.ui.el('btn-refresh-feedback');
    if (btn) { btn.disabled = true; btn.textContent = 'Refreshing…'; }

    try {
      const resp = await fetch(`/api/interviews/${this.session.id}/refresh-feedback`, { method: 'POST' });
      const data = await resp.json();
      if (!data.success) throw new Error(data.error || 'Failed to refresh feedback');

      this.session = data.session;
      // Reuse showCompletion's rendering path — same shape (summary/
      // answers/evaluations) as the socket's 'interview:complete' payload.
      this.showCompletion({
        summary: data.session.finalEvaluation,
        answers: data.session.answers,
        evaluations: data.session.evaluations,
        providerSwitch: data.providerSwitch,
      });
    } catch (e) {
      console.error('[App] Refresh overall feedback error:', e);
      this._showToast('Could not refresh the overall feedback. Please try again.', 'error');
    } finally {
      if (btn) { btn.disabled = false; btn.textContent = 'Refresh overall feedback'; }
    }
  }

  // ---- Refresh overall feedback (history detail panel) ----
  async refreshHistoryDetailFeedback() {
    if (!this._historyDetailSessionId) return;
    const btn = this.ui.el('btn-detail-refresh-feedback');
    if (btn) { btn.disabled = true; btn.textContent = 'Refreshing…'; }

    try {
      const resp = await fetch(`/api/interviews/${this._historyDetailSessionId}/refresh-feedback`, { method: 'POST' });
      const data = await resp.json();
      if (!data.success) throw new Error(data.error || 'Failed to refresh feedback');

      this.ui.renderHistoryDetail(data.session);
    } catch (e) {
      console.error('[App] Refresh history detail feedback error:', e);
      this._showToast('Could not refresh the overall feedback. Please try again.', 'error');
    } finally {
      if (btn) { btn.disabled = false; btn.textContent = 'Refresh overall feedback'; }
    }
  }

  // ---- Answer guidance (for a question whose scoring genuinely failed) ----
  // `containerId` is 'questions-breakdown' (live completion page, where
  // `this.questions` is already known) or 'detail-questions-breakdown'
  // (history detail view, where the question list comes back on the
  // response instead). See uiManager.js's isFailed branch for the button
  // this responds to, and interviewService.getAnswerGuidance server-side.
  async getAnswerGuidance(sessionId, questionId, btnEl, containerId) {
    if (!sessionId || !Number.isFinite(questionId)) return;
    const originalText = btnEl ? btnEl.textContent : '';
    if (btnEl) { btnEl.disabled = true; btnEl.textContent = 'Getting guidance…'; }

    try {
      const resp = await fetch(`/api/interviews/${sessionId}/questions/${questionId}/guidance`, { method: 'POST' });
      const data = await resp.json();
      if (!data.success) throw new Error(data.error || 'Failed to get answer guidance');

      const evaluationsById = {};
      (data.session.evaluations || []).forEach((e) => { evaluationsById[e.questionId] = e; });
      const answersById = {};
      (data.session.answers || []).forEach((a) => { answersById[a.questionId] = a.text; });

      const questions = containerId === 'questions-breakdown' ? this.questions : (data.session.questions || []);
      this.ui.refreshBreakdown(containerId, questions, evaluationsById, answersById, questionId);

      if (data.providerSwitch) {
        this._showToast(
          `Switched to ${data.providerSwitch.to} — ${data.providerSwitch.from} was unavailable. Your interview continues normally.`,
          'warning'
        );
      }
    } catch (e) {
      console.error('[App] Get answer guidance error:', e);
      this._showToast('Still unable to reach any AI provider for guidance — please try again later.', 'error');
      if (btnEl) { btnEl.disabled = false; btnEl.textContent = originalText || 'How would I answer this?'; }
    }
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

      if (data.providerSwitch) {
        this._showToast(
          `Switched to ${data.providerSwitch.to} — ${data.providerSwitch.from} was unavailable. Your interview continues normally.`,
          'warning'
        );
      }

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
    this._enhanceToken++;
    if (this.audioRecorder) this.audioRecorder.discard();
    this.ui.hideEnhanceStatus();
    this.session              = null;
    this.questions            = [];
    this.currentQuestionIndex = 0;
    this.evaluationResults    = {};
    this.answers              = {};
    if (this.socket) this.socket.clearSession();

    const startBtn = this.ui.el('btn-start');
    startBtn.disabled  = false;
    startBtn.innerHTML = '<svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor"><polygon points="5 3 19 12 5 21 5 3"/></svg> Start Interview';

    this.ui.showPanel('setup-panel');
    this.setState(STATE.SETUP);
  }

  // ---- End Interview Early ----
  endInterviewEarly() {
    if (!this.session) return;

    // Use this.answers (populated the instant each answer is submitted),
    // not this.evaluationResults — with evaluation decoupled from
    // submission, evaluationResults can lag behind by design and would
    // undercount how many questions the user actually answered.
    const answered = Object.keys(this.answers).length;
    const total = this.questions.length;

    const msg = answered === 0
      ? 'You haven\'t answered any questions yet. Are you sure you want to end the interview?'
      : `You\'ve answered ${answered} of ${total} questions. End the interview now and get your results?`;

    if (!confirm(msg)) return;

    // Stop any active speech or recognition
    this._enhanceToken++;
    this.speech.cancel();
    if (this.recognition) this.recognition.stop();
    if (this.audioRecorder) this.audioRecorder.discard();
    this.ui.setWaveformActive(false);
    this.ui.hideSilenceIndicator();

    // Show loading
    this.setState(STATE.EVALUATING);
    this.ui.el('loading-title').textContent = 'Evaluating Performance';
    this.ui.el('loading-subtitle').textContent = answered > 0
      ? `AI is scoring your ${answered} answered question${answered > 1 ? 's' : ''} — this can take a bit longer if we need to try a backup AI, but we'll wait for real results.`
      : 'Wrapping up your interview...';
    this.ui.showPanel('loading-panel');

    if (this.socket) this.socket.endSession(this.session.id);
  }

  // ---- History ----
  /**
   * The single entry point for viewing history (the header's History
   * button, the "View your history" link on setup, and the detail panel's
   * back button all call this). Tries a real account session first; if
   * there isn't one, falls through to the combined anonymous + email view.
   */
  async loadHistory() {
    this.ui.showPanel('history-panel');
    this.setState(STATE.IDLE);
    this._renderHistoryEmailLookupBox();

    // Show loading state in list
    const listEl = this.ui.el('history-list');
    if (listEl) listEl.innerHTML = '<p style="text-align:center;color:var(--text-3);padding:40px">Loading history...</p>';

    try {
      const resp = await fetch('/api/interviews/history');
      if (resp.ok) {
        const data = await resp.json();
        if (data.success) {
          this.ui.renderHistoryList(data.data);
          return;
        }
      }
      // No account (401) or an otherwise-empty response — fall back to
      // this browser's own remembered anonymous sessions, merged with an
      // email lookup if we know one for this browser.
      await this._loadCombinedHistory();
    } catch (err) {
      console.error('[App] /history failed, falling back to local + email history:', err);
      await this._loadCombinedHistory();
    }
  }

  /**
   * No-account view: this browser's own remembered anonymous sessions,
   * merged with an email-based lookup when this browser already knows an
   * email (see RETURNING_EMAIL_KEY) — so the History button "just works"
   * on a repeat visit instead of asking again every time.
   */
  async _loadCombinedHistory() {
    const localSummaries = await this._fetchAnonymousHistorySummaries();
    const email = this._getRememberedEmail();
    const emailSummaries = email ? await this._fetchHistoryByEmail(email, { silent: true }) : [];
    this.ui.renderHistoryList(this._mergeHistorySummaries(localSummaries, emailSummaries));
  }

  /**
   * Anonymous-history fallback (see the ANONYMOUS HISTORY note near
   * STATE): fetches this browser's own remembered session ids one by one
   * via the same GET /:sessionId endpoint the detail view uses (it works
   * without an account for a session nobody has claimed), builds the
   * lighter summary shape renderHistoryList expects, and prunes any ids
   * that no longer resolve. Returns the summaries instead of rendering
   * them directly so loadHistory()/handleHistoryEmailLookup() can merge
   * them with an email-based lookup first.
   */
  async _fetchAnonymousHistorySummaries() {
    const ids = this._getRememberedSessionIds();
    if (ids.length === 0) return [];

    const sessions = await Promise.all(
      ids.map(async (id) => {
        try {
          const resp = await fetch(`/api/interviews/${id}`);
          if (!resp.ok) return null;
          const data = await resp.json();
          return data.success ? data.data : null;
        } catch {
          return null;
        }
      })
    );

    // Drop ids that no longer resolve (deleted, or claimed under a
    // different login than whichever is active now) so the local list
    // doesn't accumulate dead entries forever.
    this._pruneRememberedSessionIds(sessions.filter(Boolean).map((s) => s.id));

    return sessions
      .filter((s) => s && s.status === 'completed')
      .map((s) => ({
        id: s.id,
        techStack: s.techStack,
        model: s.model,
        provider: s.provider,
        overallScore: s.finalEvaluation?.overallScore ?? null,
        answeredCount: s.answeredCount ?? s.answers?.length ?? 0,
        totalQuestions: s.totalQuestions ?? s.questions?.length ?? 0,
        createdAt: s.createdAt,
        difficultyLevel: s.difficultyLevel,
      }));
  }

  /**
   * Returning-visitor history lookup by email — no account, no password.
   * See docs/OPTIONAL_HISTORY_LOOKUP_PLAN.md (Option B, explicitly chosen
   * without verification): typing any email that was used to start a past
   * interview returns every completed session tagged with it, in the same
   * summary shape as the anonymous-local list above so the two merge
   * cleanly. `silent` swallows failures (returns []) for the automatic
   * on-open lookup in loadHistory(); the manual "Find" button in the
   * history panel wants the error surfaced instead, so it leaves it off.
   */
  async _fetchHistoryByEmail(email, { silent = false } = {}) {
    try {
      const resp = await fetch('/api/interviews/history/lookup', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email }),
      });
      const data = await resp.json();
      if (!resp.ok || !data.success) {
        throw new Error(data.error || 'Failed to load history for that email.');
      }
      return data.data;
    } catch (err) {
      console.error('[App] Email history lookup failed:', err);
      if (silent) return [];
      throw err;
    }
  }

  /** Merges two history-summary arrays by session id (later array wins on overlap) and sorts newest-first. */
  _mergeHistorySummaries(...lists) {
    const byId = new Map();
    for (const list of lists) {
      for (const s of list || []) {
        if (s && s.id) byId.set(s.id, s);
      }
    }
    return Array.from(byId.values()).sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
  }

  /**
   * Handles the "Find" button in the history panel's email-lookup box —
   * the one place left that ever asks for an email to look up history
   * (the setup panel's email field is save-only now, see
   * btn-goto-history-from-setup). On success the email is remembered so
   * future History opens skip straight to _loadCombinedHistory().
   */
  async handleHistoryEmailLookup() {
    const emailInput = this.ui.el('history-lookup-email');
    const statusEl = this.ui.el('history-lookup-status');
    const btn = this.ui.el('btn-history-lookup');
    const email = emailInput?.value?.trim();

    if (!email) {
      this._showToast('Enter the email you used before to find your history.', 'warning');
      return;
    }

    if (statusEl) {
      statusEl.className = 'api-key-status validating';
      statusEl.textContent = '⏳ Looking up your history...';
      statusEl.classList.remove('hidden');
    }
    if (btn) btn.disabled = true;

    try {
      const emailSummaries = await this._fetchHistoryByEmail(email);
      this._rememberEmail(email);
      const localSummaries = await this._fetchAnonymousHistorySummaries();
      this.ui.renderHistoryList(this._mergeHistorySummaries(localSummaries, emailSummaries));
      if (statusEl) statusEl.classList.add('hidden');
      this._renderHistoryEmailLookupBox();
    } catch (err) {
      if (statusEl) {
        statusEl.className = 'api-key-status error';
        statusEl.textContent = '✗ ' + (err.message || 'Failed to load history — please try again.');
        statusEl.classList.remove('hidden');
      }
    } finally {
      if (btn) btn.disabled = false;
    }
  }

  /** Reflects whether this browser already has a remembered email into the history panel's lookup box — auto-filled and explained, or blank and asking, never both at once. */
  _renderHistoryEmailLookupBox() {
    const email = this._getRememberedEmail();
    const hintEl = this.ui.el('history-lookup-hint');
    const input = this.ui.el('history-lookup-email');
    const clearBtn = this.ui.el('btn-clear-remembered-email');

    if (email) {
      if (input) input.value = email;
      if (hintEl) hintEl.textContent = `Showing history for ${email}.`;
      if (clearBtn) clearBtn.classList.remove('hidden');
    } else {
      if (hintEl) hintEl.textContent = 'Have interviews from another device? Enter your email to find them.';
      if (clearBtn) clearBtn.classList.add('hidden');
    }
  }

  /** Live confirmation under the setup panel's email field — purely reassurance that this email will tag the upcoming interview, no lookup happens here. */
  _updateReturningEmailHint() {
    const input = this.ui.el('returning-email');
    const statusEl = this.ui.el('returning-email-status');
    if (!input || !statusEl) return;

    const val = input.value.trim();
    const looksValid = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(val);
    if (val && looksValid) {
      statusEl.className = 'api-key-status success';
      statusEl.textContent = "✓ We'll save this interview under this email so you can find it later.";
      statusEl.classList.remove('hidden');
    } else {
      statusEl.classList.add('hidden');
    }
  }

  // ---- Remembered email (localStorage) ----
  _getRememberedEmail() {
    try {
      return localStorage.getItem(RETURNING_EMAIL_KEY) || '';
    } catch (err) {
      console.warn('[App] Could not read remembered email:', err);
      return '';
    }
  }

  _rememberEmail(email) {
    try {
      localStorage.setItem(RETURNING_EMAIL_KEY, email);
    } catch (err) {
      console.warn('[App] Could not remember email:', err);
    }
  }

  _forgetEmail() {
    try {
      localStorage.removeItem(RETURNING_EMAIL_KEY);
    } catch (err) {
      console.warn('[App] Could not forget remembered email:', err);
    }
  }

  // ---- Anonymous-history local id list (localStorage) ----
  _getRememberedSessionIds() {
    try {
      const raw = localStorage.getItem(HISTORY_IDS_KEY);
      const ids = raw ? JSON.parse(raw) : [];
      return Array.isArray(ids) ? ids : [];
    } catch (err) {
      console.warn('[App] Could not read local history list:', err);
      return [];
    }
  }

  _rememberSessionId(id) {
    try {
      const ids = this._getRememberedSessionIds().filter((existing) => existing !== id);
      ids.unshift(id); // newest first
      localStorage.setItem(HISTORY_IDS_KEY, JSON.stringify(ids.slice(0, MAX_REMEMBERED_SESSIONS)));
    } catch (err) {
      console.warn('[App] Could not save session id to local history:', err);
    }
  }

  _pruneRememberedSessionIds(validIds) {
    try {
      const validSet = new Set(validIds);
      const kept = this._getRememberedSessionIds().filter((id) => validSet.has(id));
      localStorage.setItem(HISTORY_IDS_KEY, JSON.stringify(kept));
    } catch (err) {
      console.warn('[App] Could not prune local history list:', err);
    }
  }

  /**
   * Attaches this browser's locally-remembered anonymous session ids to
   * the account that just logged in or registered (POST /claim), so
   * history built up before the account existed doesn't get orphaned.
   * Best-effort: a failure here doesn't block login — those sessions just
   * stay anonymous (still directly reachable by id) until a future login
   * retries the claim, since _rememberSessionId never clears the local
   * list on failure.
   */
  async _claimLocalHistory() {
    const ids = this._getRememberedSessionIds();
    if (ids.length === 0) return;
    try {
      await fetch('/api/interviews/claim', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sessionIds: ids }),
      });
    } catch (err) {
      console.warn('[App] Failed to claim local history for this account:', err);
    }
  }

  async viewHistoryDetail(sessionId) {
    // Show loading
    this.ui.showPanel('history-detail-panel');
    const titleEl = this.ui.el('detail-title');
    if (titleEl) titleEl.textContent = 'Loading...';
    // Tracked for refreshHistoryDetailFeedback() — see §6's manual refresh action.
    this._historyDetailSessionId = sessionId;

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
    if (!this.recognition) return;

    // stop() itself computes and returns the merged text (previous segment
    // + current one, when continuing) — do not read
    // this.recognition.previousTranscript/isResumeMode after calling
    // stop(), since stop() resets isResumeMode to false as part of
    // stopping, so that state would already be cleared by the time it's read.
    const text = this.recognition.stop();

    this.ui.setWaveformActive(false);
    this.ui.hideSilenceIndicator();

    this.setState(STATE.EDITING);
    this.ui.showEditTranscript(text);
    this._enhanceTranscriptWithAudio(text);
  }

  // ---- Transcript enhancement (server-side ASR pass on recorded audio) ----
  // See docs/project-improvement/VOICE_RECOGNITION_ACCURACY_PLAN.md. Runs
  // AFTER the Web Speech transcript is already showing in the edit box —
  // this only ever improves what's there, it never blocks or delays the
  // existing flow, and any failure (unsupported browser, mic denied,
  // every configured provider down, a slow/timed-out request) just means
  // the candidate keeps the Web Speech text they already had. `fallbackText`
  // is exactly what's in the edit box at the moment this is called; the
  // enhancement is applied only if the box still shows that same text when
  // the result comes back — see _enhanceToken's doc comment in the
  // constructor for how an abandoned take (retry / continue / submit /
  // restart / early-end) is prevented from writing into the wrong place.
  async _enhanceTranscriptWithAudio(fallbackText) {
    if (!this.audioRecorder || !this.audioRecorder.supported) return;
    if (!this.session) return;
    const q = this.questions[this.currentQuestionIndex];
    if (!q) return;

    const token = this._enhanceToken;
    const sessionId = this.session.id;
    const questionId = q.id;
    const expected = fallbackText.trim();

    let recorded;
    try {
      recorded = await this.audioRecorder.stop();
    } catch (e) {
      console.warn('[App] Audio recorder stop failed:', e);
      return;
    }
    if (token !== this._enhanceToken) return; // take abandoned while we awaited
    if (!recorded || !recorded.blob || recorded.blob.size === 0) return;
    // Don't clobber a manual edit made while we were still recording/stopping.
    if (this.ui.getEditedTranscript().trim() !== expected) return;

    this.ui.showEnhanceStatus('Improving transcript…');

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 20000);
    let resp;
    try {
      resp = await fetch(`/api/interviews/${sessionId}/questions/${questionId}/transcribe`, {
        method: 'POST',
        headers: { 'Content-Type': recorded.mimeType },
        body: recorded.blob,
        signal: controller.signal,
      });
    } catch (e) {
      // Network error, timeout/abort, etc. — quietly keep the existing text.
      if (token === this._enhanceToken) this.ui.hideEnhanceStatus();
      return;
    } finally {
      clearTimeout(timeoutId);
    }

    if (token !== this._enhanceToken) return; // abandoned while the request was in flight
    if (this.state !== STATE.EDITING) return;
    if (this.ui.getEditedTranscript().trim() !== expected) {
      this.ui.hideEnhanceStatus();
      return;
    }
    if (!resp.ok) {
      this.ui.hideEnhanceStatus();
      return;
    }

    let data;
    try {
      data = await resp.json();
    } catch (e) {
      this.ui.hideEnhanceStatus();
      return;
    }

    const result = data && data.data;
    if (!result || result.provider === 'none' || !result.transcript || !result.transcript.trim()) {
      this.ui.hideEnhanceStatus();
      return;
    }

    const improved = result.transcript.trim();
    if (improved === expected) {
      // Server agreed with what was already there — nothing to change.
      this.ui.hideEnhanceStatus();
      return;
    }

    this._preEnhanceText = fallbackText;
    this.ui.showEditTranscript(improved);

    const providerLabel =
      result.provider === 'groq' ? 'Groq Whisper' : result.provider === 'gemini' ? 'Gemini' : result.provider;
    const note = result.lowConfidence
      ? `Transcript improved (${providerLabel}) — please double-check technical terms.`
      : `Transcript improved (${providerLabel}).`;
    this.ui.markEnhanceStatusDone(note, { showUndo: true });
  }

  _undoTranscriptEnhance() {
    if (this._preEnhanceText === undefined) return;
    this.ui.showEditTranscript(this._preEnhanceText);
    this._preEnhanceText = undefined;
    this.ui.hideEnhanceStatus();
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
      charCountEl.textContent = `${len.toLocaleString()} / ${MAX_ANSWER_LENGTH.toLocaleString()} characters`;
      if (len > MAX_ANSWER_LENGTH) {
        charCountEl.style.color = 'var(--red)';
      } else {
        charCountEl.style.color = 'var(--text-2)';
      }
    }

    if (warningEl) {
      if (len > MAX_ANSWER_LENGTH) {
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
      charCountEl.textContent = `${len.toLocaleString()} / ${MAX_ANSWER_LENGTH.toLocaleString()} characters`;
      if (len > MAX_ANSWER_LENGTH) {
        charCountEl.style.color = 'var(--red)';
      } else {
        charCountEl.style.color = 'var(--text-2)';
      }
    }

    if (warningEl) {
      if (len > MAX_ANSWER_LENGTH) {
        warningEl.classList.remove('hidden');
      } else {
        warningEl.classList.add('hidden');
      }
    }

    if (editInput) {
      if (len > MAX_ANSWER_LENGTH) {
        editInput.classList.add('error-border');
      } else {
        editInput.classList.remove('error-border');
      }
    }

    if (submitBtn) {
      if (len > MAX_ANSWER_LENGTH) {
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
  _showToast(message, type = 'info', durationMs = 4000) {
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

    // Auto-dismiss after durationMs (default 4s; some messages ask for longer)
    setTimeout(() => {
      toast.classList.remove('visible');
      setTimeout(() => toast.remove(), 300);
    }, durationMs);
  }
}

// Boot
document.addEventListener('DOMContentLoaded', () => {
  window.app = new App();
});
