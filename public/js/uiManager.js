import { renderMarkdown } from './markdown.js';

export class UIManager {
  constructor() {
    this._cache = {};
    this._buildTechStackData();
    this._silenceTimer = null;
    this._silenceCountdown = 0;
    this._bindDelegatedListeners();
  }

  /**
   * Delegated click handlers for content this class renders via innerHTML
   * (the per-question breakdown accordion). Bound ONCE, here, on the two
   * static containers that host that markup — not per-render — so they
   * keep working across re-renders without re-attaching.
   *
   * Previously these were inline `onclick="..."` attributes baked into the
   * generated HTML. That's blocked in production by the app's own CSP
   * (`script-src 'self'`, no `'unsafe-inline'`, and helmet's default
   * `script-src-attr 'none'`) — see docs/audit/01-BACKLOG-P0-P3.md [P2-01].
   * The accordion silently did nothing in production; this is the fix.
   * Do NOT reintroduce inline handlers or relax the CSP to work around
   * this — delegated listeners are the correct fix, not a workaround.
   */
  _bindDelegatedListeners() {
    ['questions-breakdown', 'detail-questions-breakdown'].forEach((id) => {
      const container = this.el(id);
      if (!container) return;
      container.addEventListener('click', (event) => {
        const header = event.target.closest('.q-item-header');
        if (!header || !container.contains(header)) return;
        header.parentElement.classList.toggle('open');
      });
    });

    // Interview Level picker (see populateLevelPicker below) — the cards
    // are re-rendered via innerHTML once config loads, so click/keyboard
    // handling is delegated on the static #level-cards container (present
    // in index.html from load) rather than bound per-card, same reasoning
    // as the accordion header above.
    const levelContainer = this.el('level-cards');
    if (levelContainer) {
      levelContainer.addEventListener('click', (event) => {
        const card = event.target.closest('.level-card');
        if (!card || !levelContainer.contains(card)) return;
        this._selectLevelCard(levelContainer, card, { focus: false });
      });

      // Standard ARIA radiogroup keyboard pattern: arrow keys move focus
      // AND select in one step; Home/End jump to the first/last option.
      levelContainer.addEventListener('keydown', (event) => {
        const current = event.target.closest('.level-card');
        if (!current || !levelContainer.contains(current)) return;
        const cards = Array.from(levelContainer.querySelectorAll('.level-card'));
        const idx = cards.indexOf(current);
        if (idx === -1) return;

        let nextIdx = null;
        if (event.key === 'ArrowRight' || event.key === 'ArrowDown') {
          nextIdx = (idx + 1) % cards.length;
        } else if (event.key === 'ArrowLeft' || event.key === 'ArrowUp') {
          nextIdx = (idx - 1 + cards.length) % cards.length;
        } else if (event.key === 'Home') {
          nextIdx = 0;
        } else if (event.key === 'End') {
          nextIdx = cards.length - 1;
        } else {
          return; // not a key this widget handles — let it bubble normally
        }

        event.preventDefault();
        this._selectLevelCard(levelContainer, cards[nextIdx], { focus: true });
      });
    }
  }

  /**
   * Marks `card` as the selected option in the Interview Level radiogroup
   * and every other `.level-card` in `container` as unselected — updates
   * aria-checked, the roving tabindex (exactly one card is ever
   * tab-reachable at a time, per the ARIA radiogroup pattern), and the
   * `.selected` styling hook. `focus:true` is used for keyboard
   * navigation (the newly-selected card should also receive focus);
   * a mouse click already has focus on the clicked element, so that path
   * passes `focus:false` to avoid a redundant/jumpy focus call.
   */
  _selectLevelCard(container, card, { focus } = {}) {
    container.querySelectorAll('.level-card').forEach((el) => {
      const isSelected = el === card;
      el.classList.toggle('selected', isSelected);
      el.setAttribute('aria-checked', String(isSelected));
      el.tabIndex = isSelected ? 0 : -1;
    });
    this._selectedLevelId = card.dataset.levelId;
    if (focus) card.focus();
  }

  // ---- Element helper (cached) ----
  el(id) {
    if (!this._cache[id]) {
      this._cache[id] = document.getElementById(id);
    }
    return this._cache[id];
  }

  // ---- Panels ----
  showPanel(panelId) {
    const panels = ['auth-panel', 'setup-panel', 'interview-panel', 'loading-panel', 'completion-panel', 'history-panel', 'history-detail-panel'];
    panels.forEach(id => {
      const el = document.getElementById(id);
      if (!el) return;
      if (id === panelId) {
        el.classList.remove('hidden');
        el.classList.add('active');
      } else {
        el.classList.add('hidden');
        el.classList.remove('active');
      }
    });
  }

  // ---- Status indicator ----
  setStatus(statusClass, text) {
    const pulse = this.el('status-pulse');
    const label = this.el('status-text');
    if (!pulse || !label) return;
    pulse.className = `pulse ${statusClass}`;
    label.textContent = text;
  }

  // ---- Populate selects from API ----
  async populateSelects() {
    try {
      const [stacksRes, modelsRes] = await Promise.all([
        fetch('/api/interviews/tech-stacks'),
        fetch('/api/interviews/models'),
      ]);

      if (!stacksRes.ok || !modelsRes.ok) throw new Error('API not reachable');

      const stacksData = await stacksRes.json();
      const modelsData = await modelsRes.json();

      const techEl = this.el('tech-stack');
      const modelEl = this.el('ai-model');

      techEl.innerHTML = stacksData.data
        .map(s => `<option value="${s}">${s}</option>`)
        .join('');

      // Group models by provider using optgroups
      this._renderModelSelect(modelEl, modelsData.data);

      // Listen for tech stack changes to update icon
      techEl.addEventListener('change', (e) => this._updateStackIcon(e.target.value));

    } catch (err) {
      console.error('[UIManager] populateSelects error:', err);
      // Fallback options if API fails
      const techEl = this.el('tech-stack');
      if (techEl && techEl.options.length === 0) {
        const fallback = ['Node.js','React','Next.js','Python','Django','Java','Spring Boot','C#','.NET','Ruby on Rails','Go','Rust','PHP','Laravel','Vue.js','Angular','Svelte','MERN Stack','MEAN Stack','LAMP Stack','MySQL','Job Description','Resume'];
        techEl.innerHTML = fallback.map(s => `<option value="${s}">${s}</option>`).join('');
        techEl.addEventListener('change', (e) => this._updateStackIcon(e.target.value));
      }
      const modelEl = this.el('ai-model');
      if (modelEl && modelEl.options.length === 0) {
        modelEl.innerHTML = `
          <optgroup label="Google Gemini">
            <option value="gemini-3.5-flash">Gemini 3.5 Flash — Latest, fast</option>
            <option value="gemini-3.1-pro">Gemini 3.1 Pro — Premium reasoning</option>
            <option value="gemini-3-pro">Gemini 3 Pro — Stable multimodal</option>
            <option value="gemini-3-flash">Gemini 3 Flash — Agentic</option>
          </optgroup>
          <optgroup label="Groq">
            <option value="groq">Groq Llama — llama-3.3-70b-versatile</option>
          </optgroup>
          <optgroup label="NVIDIA">
            <option value="nvidia">NVIDIA Nemotron — nemotron-3-nano-omni-30b</option>
          </optgroup>
        `;
      }
    }
  }

  // ---- Render model select with optgroups ----
  _renderModelSelect(selectEl, models) {
    // Group models by provider
    const groups = {};
    models.forEach(m => {
      const provider = m.provider || 'Other';
      if (!groups[provider]) groups[provider] = [];
      groups[provider].push(m);
    });

    let html = '';
    for (const [provider, groupModels] of Object.entries(groups)) {
      html += `<optgroup label="${this._escHtml(provider)}">`;
      groupModels.forEach(m => {
        html += `<option value="${m.id}">${m.name} — ${m.description}</option>`;
      });
      html += '</optgroup>';
    }

    selectEl.innerHTML = html;
  }

  // ============================================================
  // INTERVIEW LEVEL PICKER (see
  // docs/project-improvement/DIFFICULTY_LEVEL_PLAN.md)
  // ============================================================

  /** Same fallback role as populateSelects' hardcoded tech-stack/model
   *  arrays: used only if GET /api/interviews/config couldn't be reached
   *  at all, so the picker never renders empty. Kept in sync by hand with
   *  src/config/difficultyLevels.ts's labels/blurbs — the normal path
   *  always renders from the server's list instead of this one. */
  _fallbackLevels() {
    return [
      { id: 'trainee', label: 'Software Trainee', experience: '0–1 yrs', blurb: 'Do the fundamentals hold up? Explain a concept in your own words and apply it once.' },
      { id: 'software_engineer', label: 'Software Engineer', experience: '1–3 yrs', blurb: 'Can you build, debug and test real features, and avoid the common traps?' },
      { id: 'senior_engineer', label: 'Senior Software Engineer', experience: '4–8 yrs', blurb: 'Do you reason about trade-offs, performance and failure modes, and own a service end to end?' },
      { id: 'staff_engineer', label: 'Staff / Principal Engineer', experience: '8+ yrs', blurb: 'Can you hold a multi-system architecture in your head and make defensible calls under ambiguity?' },
    ];
  }

  /**
   * Renders the Interview Level radio-card group from the level list GET
   * /api/interviews/config serves (id/label/experience/blurb — see
   * interview.controller.ts's DIFFICULTY_LEVELS). Falls back to
   * _fallbackLevels() when `levels` is empty/unavailable so the picker is
   * never blank. `software_engineer` is preselected (matching the
   * server's own default when no level is sent at all) and marked
   * Recommended. Call this once, after config has loaded — click/keyboard
   * handling is already delegated in _bindDelegatedListeners, so
   * re-calling this later (there's no current reason to) would keep
   * working too.
   */
  populateLevelPicker(levels) {
    const container = this.el('level-cards');
    if (!container) return;

    const list = Array.isArray(levels) && levels.length > 0 ? levels : this._fallbackLevels();
    this._levels = list;

    const defaultId = list.some((l) => l.id === 'software_engineer') ? 'software_engineer' : list[0]?.id;
    this._selectedLevelId = defaultId;

    container.innerHTML = list.map((lvl) => {
      const isSelected = lvl.id === defaultId;
      return `
        <button type="button" class="level-card${isSelected ? ' selected' : ''}" role="radio"
                aria-checked="${isSelected}" tabindex="${isSelected ? '0' : '-1'}"
                data-level-id="${this._escHtml(lvl.id)}">
          <span class="level-card-top">
            <span class="level-card-label">${this._escHtml(lvl.label)}</span>
            ${lvl.id === 'software_engineer' ? '<span class="level-card-badge">Recommended</span>' : ''}
          </span>
          <span class="level-card-experience">${this._escHtml(lvl.experience)}</span>
          <span class="level-card-blurb">${this._escHtml(lvl.blurb)}</span>
        </button>
      `;
    }).join('');
  }

  /** The currently selected level's id, for the POST /start request body.
   *  Falls back to 'software_engineer' (the server's own default) if
   *  populateLevelPicker was never called or somehow selected nothing. */
  getSelectedLevel() {
    return this._selectedLevelId || 'software_engineer';
  }

  /** Display label for a level id — used everywhere a level badge is
   *  rendered (interview header, completion score, history rows/detail).
   *  Looks up the list populateLevelPicker last rendered from (the real
   *  server data, or the fallback); if a session was somehow started at a
   *  level not in that list (or before this feature existed and the id is
   *  missing/unrecognized), falls back to a readable title-cased version
   *  of the raw id rather than showing nothing. */
  getLevelLabel(id) {
    if (!id) return '';
    const known = (this._levels || this._fallbackLevels()).find((l) => l.id === id);
    if (known) return known.label;
    return String(id)
      .split('_')
      .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
      .join(' ');
  }

  /** Programmatically selects a level card by id — used by the resume
   *  analysis panel's "Use this level" nudge (see renderResumeAnalysis
   *  below). Mirrors the click-handling in _selectLevelCard without
   *  requiring a real click/keyboard event. No-op if the id isn't one of
   *  the currently-rendered cards. */
  selectLevelById(id) {
    const container = this.el('level-cards');
    if (!container || !id) return;
    const card = container.querySelector(`.level-card[data-level-id="${CSS.escape(String(id))}"]`);
    if (card) this._selectLevelCard(container, card, { focus: false });
  }

  // ============================================================
  // RESUME MODE (see docs/project-improvement/RESUME_MODE_PLAN.md)
  // ============================================================

  /**
   * Renders the extracted ResumeProfile (§4.1) into the read-only
   * '#resume-analysis-summary' panel right after POST /resume/analyze
   * returns. Purely a preview — nothing here is editable; if the
   * candidate wants different questions they edit the resume text and
   * re-analyze (app.js's resume-textarea input listener invalidates the
   * stored profile the moment the text changes, so a stale profile can
   * never silently start the interview).
   *
   * `currentLevelId` is the level currently selected on the Interview
   * Level picker — when the resume's own inferredLevel (advisory only,
   * see ResumeProfile's doc comment) differs from it, a small nudge
   * offers to switch, but never does so automatically (§8: the user's
   * explicit choice always wins).
   */
  renderResumeAnalysis(profile, currentLevelId) {
    const container = this.el('resume-analysis-summary');
    if (!container || !profile) return;

    const tagList = (skills, extraClass = '') =>
      (skills || []).map((s) => `<span class="resume-tag${extraClass}">${this._escHtml(s)}</span>`).join('');

    const projectsHtml = (profile.projects || []).slice(0, 6).map((p) => `
      <div class="resume-project-item">
        ${this._escHtml(p.summary || '')}
        ${p.technologies?.length ? `<span class="resume-project-tech">${this._escHtml(p.technologies.join(' · '))}</span>` : ''}
      </div>
    `).join('');

    const yearsText = typeof profile.yearsOfExperience === 'number'
      ? `${profile.yearsOfExperience} yr${profile.yearsOfExperience === 1 ? '' : 's'} of experience detected`
      : '';
    const domainsText = (profile.domains || []).join(', ');

    let levelNudgeHtml = '';
    if (profile.inferredLevel && profile.inferredLevel !== currentLevelId) {
      const suggestedLabel = this.getLevelLabel(profile.inferredLevel);
      levelNudgeHtml = `
        <div class="resume-level-nudge">
          <p>Your resume reads closer to <strong>${this._escHtml(suggestedLabel)}</strong> — questions will still match whichever level is selected above.</p>
          <button type="button" class="btn-secondary btn-use-suggested-level" data-level-id="${this._escHtml(profile.inferredLevel)}">Use this level</button>
        </div>
      `;
    }

    container.innerHTML = `
      ${profile.primarySkills?.length ? `
        <div class="resume-analysis-row">
          <span class="resume-analysis-label">Primary skills</span>
          <div class="resume-tag-list">${tagList(profile.primarySkills)}</div>
        </div>
      ` : ''}
      ${profile.secondarySkills?.length ? `
        <div class="resume-analysis-row">
          <span class="resume-analysis-label">Also familiar with</span>
          <div class="resume-tag-list">${tagList(profile.secondarySkills, ' secondary')}</div>
        </div>
      ` : ''}
      ${projectsHtml ? `
        <div class="resume-analysis-row">
          <span class="resume-analysis-label">Projects detected</span>
          ${projectsHtml}
        </div>
      ` : ''}
      ${(yearsText || domainsText) ? `
        <div class="resume-analysis-row">
          <span class="resume-analysis-label">Background</span>
          <span>${this._escHtml([yearsText, domainsText].filter(Boolean).join(' · '))}</span>
        </div>
      ` : ''}
      ${levelNudgeHtml}
    `;
  }

  // ---- Trigger initial stack icon update ----
  triggerTechStackChange() {
    const techEl = this.el('tech-stack');
    if (techEl && techEl.value) {
      this._updateStackIcon(techEl.value);
    }
  }

  // ---- Update tech stack icon ----
  _updateStackIcon(stackName) {
    const iconEl = this.el('tech-stack-icon');
    if (!iconEl) return;
    const data = this._techStackData[stackName] || this._techStackData['default'];
    iconEl.innerHTML = data.svg;
    iconEl.style.boxShadow = `0 4px 20px ${data.glow}`;
    iconEl.style.borderColor = data.glow.replace('0.3', '0.6');
  }

  // ---- Transcript helpers ----
  resetTranscript() {
    const live = this.el('live-transcript');
    if (live) {
      live.innerHTML = '<span class="placeholder-text">Waiting for interviewer to finish speaking...</span>';
      live.classList.add('placeholder');
    }
    this.el('edit-transcript-container')?.classList.add('hidden');
    this.el('live-transcript-wrapper')?.classList.remove('hidden');
    this.setWaveformActive(false);
    this.hideSilenceIndicator();
  }

  showLiveTranscript() {
    this.el('edit-transcript-container')?.classList.add('hidden');
    this.el('live-transcript-wrapper')?.classList.remove('hidden');
  }

  updateTranscript(interim, final) {
    const live = this.el('live-transcript');
    if (!live) return;
    live.classList.remove('placeholder');
    live.innerHTML = `
      <span class="final-text">${this._escHtml(final)}</span><span class="interim-text">${this._escHtml(interim)}</span>
    `;
  }

  showEditTranscript(text) {
    this.el('live-transcript-wrapper')?.classList.add('hidden');
    const container = this.el('edit-transcript-container');
    if (container) container.classList.remove('hidden');
    const input = this.el('edit-transcript-input');
    if (input) {
      input.value = text;
      input.dispatchEvent(new Event('input'));
    }
  }

  getEditedTranscript() {
    return this.el('edit-transcript-input')?.value || '';
  }

  // ---- Transcript enhancement status (server-side ASR pass) — see
  // docs/project-improvement/VOICE_RECOGNITION_ACCURACY_PLAN.md and
  // app.js's _enhanceTranscriptWithAudio. Pure DOM helpers — app.js owns
  // when/what to show and what the Undo button should restore. ----

  /** Shows the status row with a spinner + message (e.g. "Improving transcript…"). */
  showEnhanceStatus(message) {
    const row = this.el('transcript-enhance-status');
    if (!row) return;
    row.classList.remove('hidden', 'is-done');
    const msgEl = this.el('transcript-enhance-message');
    if (msgEl) msgEl.textContent = message;
    this.el('btn-undo-enhance')?.classList.add('hidden');
  }

  /** Marks the status row "done" (hides the spinner, e.g. after a
   *  successful improvement) and optionally reveals the Undo button. */
  markEnhanceStatusDone(message, { showUndo = false } = {}) {
    const row = this.el('transcript-enhance-status');
    if (!row) return;
    row.classList.remove('hidden');
    row.classList.add('is-done');
    const msgEl = this.el('transcript-enhance-message');
    if (msgEl) msgEl.textContent = message;
    this.el('btn-undo-enhance')?.classList.toggle('hidden', !showUndo);
  }

  hideEnhanceStatus() {
    const row = this.el('transcript-enhance-status');
    if (!row) return;
    row.classList.add('hidden');
    row.classList.remove('is-done');
    this.el('btn-undo-enhance')?.classList.add('hidden');
  }

  setWaveformActive(active) {
    const waveform = this.el('waveform');
    if (!waveform) return;
    if (active) {
      waveform.classList.add('active');
    } else {
      waveform.classList.remove('active');
    }
  }

  // ---- Silence Indicator ----
  showSilenceIndicator(totalMs) {
    const indicator = this.el('silence-indicator');
    if (!indicator) return;
    indicator.classList.remove('hidden');
    this._silenceCountdown = Math.ceil(totalMs / 1000);
    this._updateSilenceCountdown();
  }

  resetSilenceIndicator(totalMs) {
    clearInterval(this._silenceTimer);
    this._silenceCountdown = Math.ceil(totalMs / 1000);
    this._updateSilenceCountdown();
  }

  hideSilenceIndicator() {
    clearInterval(this._silenceTimer);
    const indicator = this.el('silence-indicator');
    if (indicator) indicator.classList.add('hidden');
  }

  _updateSilenceCountdown() {
    const countdownEl = this.el('silence-countdown');
    const fillEl = this.el('silence-bar-fill');
    const totalSeconds = this._silenceCountdown;
    
    if (countdownEl) countdownEl.textContent = totalSeconds;
    if (fillEl) fillEl.style.width = '100%';

    clearInterval(this._silenceTimer);
    let remaining = totalSeconds;

    this._silenceTimer = setInterval(() => {
      remaining--;
      if (countdownEl) countdownEl.textContent = Math.max(0, remaining);
      if (fillEl) fillEl.style.width = `${(remaining / totalSeconds) * 100}%`;
      
      if (remaining <= 0) {
        clearInterval(this._silenceTimer);
      }
    }, 1000);
  }

  // ---- Completion Panel ----
  // `answers` is a { questionId: answerText } map — see app.js's
  // showCompletion, which builds it from the server's canonical answers
  // array (endSession's bounded wait). Previously the app never showed the
  // user their own answer text anywhere; the breakdown only showed the
  // AI's score/feedback/betterAnswer.
  showCompletion(summary, questions, evaluations, answers = {}, meta = {}) {
    this.showPanel('completion-panel');

    const score = summary?.overallScore ?? 0;
    const feedback = summary?.overallFeedback ?? 'No feedback available.';

    // Update title based on whether interview was ended early
    const answeredCount = meta.answeredCount ?? questions.length;
    const totalCount = meta.totalCount ?? questions.length;
    const titleEl = this.el('completion-title');
    const subtitleEl = this.el('completion-subtitle');
    if (titleEl) {
      titleEl.textContent = answeredCount < totalCount ? 'Interview Ended Early' : 'Interview Complete!';
    }
    if (subtitleEl) {
      subtitleEl.textContent = answeredCount < totalCount
        ? `You answered ${answeredCount} of ${totalCount} questions. Here's your performance summary.`
        : "Here's your performance summary with AI-powered feedback";
    }

    // Stats
    const statAnswered = this.el('stat-answered');
    const statTotal = this.el('stat-total');
    const statCompletion = this.el('stat-completion');
    if (statAnswered) statAnswered.textContent = answeredCount;
    if (statTotal) statTotal.textContent = totalCount;
    if (statCompletion) statCompletion.textContent = totalCount > 0 ? Math.round((answeredCount / totalCount) * 100) + '%' : '0%';

    // Score number
    const scoreEl = this.el('final-score');
    if (scoreEl) scoreEl.textContent = score;

    // Score ring animation
    const ring = this.el('score-ring-progress');
    if (ring) {
      const circumference = 2 * Math.PI * 52; // r=52
      const offset = circumference - (score / 100) * circumference;
      // Apply gradient inline via SVG
      const svgEl = ring.closest('svg');
      if (svgEl && !svgEl.querySelector('defs')) {
        svgEl.insertAdjacentHTML('afterbegin', `
          <defs>
            <linearGradient id="score-grad" x1="0%" y1="0%" x2="100%" y2="100%">
              <stop offset="0%" stop-color="#10b981"/>
              <stop offset="100%" stop-color="#06b6d4"/>
            </linearGradient>
          </defs>
        `);
        ring.setAttribute('stroke', 'url(#score-grad)');
      }
      ring.style.strokeDasharray  = circumference;
      ring.style.strokeDashoffset = circumference; // Start at 0
      requestAnimationFrame(() => {
        setTimeout(() => {
          ring.style.strokeDashoffset = offset;
        }, 100);
      });
    }

    // Grade label
    const gradeEl = this.el('score-grade');
    if (gradeEl) {
      const { grade, cls } = this._getGrade(score);
      gradeEl.textContent = grade;
      gradeEl.className = `score-grade ${cls}`;
    }

    // Level badge — so a score is never read without knowing which
    // difficulty level it was earned against (see
    // docs/project-improvement/DIFFICULTY_LEVEL_PLAN.md). `meta` is built
    // by app.js's showCompletion from the session it already holds, since
    // the socket payload itself doesn't carry the level.
    const levelBadgeEl = this.el('completion-level-badge');
    if (levelBadgeEl) levelBadgeEl.textContent = meta.difficultyLevel ? this.getLevelLabel(meta.difficultyLevel) : '';

    // Feedback text — rendered as markdown so headings/lists/code/bold in
    // the AI's response actually display as structure, not raw ** and ```.
    const fbEl = this.el('final-feedback');
    if (fbEl) fbEl.innerHTML = renderMarkdown(feedback);

    // "Overall feedback was generated before a later answer finished
    // scoring" banner — see RICH_EVALUATION_SCALE_PLAN.md §6.
    this._renderFeedbackStatusBanner('final-feedback-status', summary);

    // Build per-question breakdown
    this._buildBreakdown(questions, evaluations, answers);
  }

  /**
   * Shows/hides the "overall feedback may be out of date" banner — see
   * RICH_EVALUATION_SCALE_PLAN.md §6. `overallScore` is always kept
   * current automatically as late evaluations land, but the narrative
   * text only updates via an explicit refresh — this banner is how the
   * user finds out there's a refresh worth doing. Absent/undefined
   * `overallFeedbackStatus` (sessions completed before this field existed,
   * or a fresh 'generated' state) never shows the banner.
   */
  _renderFeedbackStatusBanner(bannerId, summary) {
    const bannerEl = this.el(bannerId);
    if (!bannerEl) return;
    const isStale = summary?.overallFeedbackStatus === 'stale';
    bannerEl.classList.toggle('hidden', !isStale);
  }

  _buildBreakdown(questions, evaluations, answers = {}) {
    const container = this.el('questions-breakdown');
    if (!container) return;
    container.innerHTML = this._renderQuestionItems(questions, evaluations, answers);
  }

  /**
   * Renders the per-question breakdown list shared by the completion panel
   * and the history detail panel. Each question is one of four states,
   * distinguished by whether the user answered it and where its background
   * evaluation currently stands (see RICH_EVALUATION_SCALE_PLAN.md §4's
   * status lifecycle):
   *
   *   1. Not attempted — no entry in `answers` at all: greyed out,
   *      "This question was not attempted."
   *   2. Still being scored — `answers` has the text and evalData.status
   *      is 'processing' (or, before this evaluation started at all, no
   *      entry yet). Shows the user's own answer with a "Scoring…" badge
   *      instead of pretending it failed.
   *   3. Scoring failed / timed out — `evalData.status === 'failed'` (or
   *      the legacy `unavailable: true` shape). "Not Scored" badge and the
   *      placeholder's explanatory text.
   *   4. Scored — shows the user's own answer alongside the AI's
   *      evaluation. Structured fields (summary/strengths/gaps/
   *      improvementAreas/studyPoints — see §3) render as separate
   *      labeled sections when present; a LEGACY row that only ever got
   *      the old single blended `feedback` field (no `summary`/
   *      `strengths` etc., saved before this change) still renders that
   *      one block under "Feedback", exactly as before — no migration
   *      needed for old interview history to stay readable.
   */
  _renderQuestionItems(questions, evaluations, answers = {}) {
    if (!questions || questions.length === 0) {
      return '<p style="color:var(--text-3);text-align:center">No question data available</p>';
    }

    return questions.map((q, idx) => {
      const qNum = idx + 1;
      const answerText = answers[q.id];
      const wasAnswered = typeof answerText === 'string' && answerText.length > 0;
      const evalData = evaluations[q.id];
      const isProcessing = wasAnswered && (!evalData || evalData.status === 'processing');
      const hasScore = evalData && typeof evalData.score === 'number' && evalData.status !== 'processing';
      const isFailed = wasAnswered && !isProcessing && (!hasScore || evalData?.status === 'failed' || evalData?.unavailable);
      // A row has the new structured shape if it carries ANY of the new
      // fields — a legacy row (saved before this change) only ever has
      // `feedback`/`betterAnswer`, never `summary`/`strengths`/`gaps`.
      const isStructured = !!evalData && (evalData.summary || evalData.strengths || evalData.gaps || evalData.improvementAreas || (evalData.studyPoints && evalData.studyPoints.length));

      const failureText = evalData?.feedback ?? 'No feedback available for this question.';
      const betterAnswer = evalData?.betterAnswer ?? '';

      const badgeClass = hasScore
        ? (evalData.score >= 7 ? 'high' : evalData.score >= 4 ? 'medium' : 'low')
        : 'medium';
      const badgeText = hasScore ? `${evalData.score}/10` : (isProcessing ? 'Scoring…' : (wasAnswered ? 'Not Scored' : 'Skipped'));
      const badgeStateClass = hasScore ? badgeClass : (isProcessing ? 'processing' : (wasAnswered ? 'unavailable' : 'skipped'));

      const itemStateClass = !wasAnswered ? 'q-skipped' : (!hasScore ? 'q-unavailable' : '');

      const answerBlock = wasAnswered ? `
        <div class="q-section-label">Your Answer</div>
        <div class="q-user-answer">${this._escHtml(answerText)}</div>
      ` : '';

      /** One labeled markdown-rendered section, or '' if the field is empty. */
      const section = (label, text) => (text && text.trim()) ? `
          <div class="q-section-label" style="margin-top:12px">${label}</div>
          <div class="q-feedback-text">${renderMarkdown(text)}</div>
        ` : '';

      let bodyContent;
      if (!wasAnswered) {
        bodyContent = `<p class="q-feedback-text" style="color:var(--text-3);font-style:italic">This question was not attempted.</p>`;
      } else if (isProcessing) {
        bodyContent = `
          ${answerBlock}
          <div class="q-section-label" style="margin-top:12px">Scoring</div>
          <p class="q-feedback-text" style="color:var(--text-3);font-style:italic">Still being scored — check back in a moment.</p>
        `;
      } else if (isFailed) {
        // Scoring genuinely failed (every configured AI provider tried and
        // failed) — offer standalone "how would I answer this" guidance as
        // a consolation, fetched on demand (see app.js's getAnswerGuidance)
        // and cached on the evaluation entry once fetched so it survives a
        // reload. Only shown in this failure state — a normally-scored
        // question already has `betterAnswer` from its own evaluation.
        const guidanceBlock = evalData?.guidance
          ? `
            <div class="q-section-label" style="margin-top:12px">How To Answer This</div>
            <div class="q-feedback-text">${renderMarkdown(evalData.guidance)}</div>
          `
          : `
            <button type="button" class="btn-link q-guidance-btn" data-question-id="${q.id}" style="margin-top:12px">How would I answer this?</button>
          `;
        bodyContent = `
          ${answerBlock}
          <div class="q-section-label" style="margin-top:12px">Scoring</div>
          <p class="q-feedback-text" style="color:var(--text-3);font-style:italic">${this._escHtml(failureText)}</p>
          ${guidanceBlock}
        `;
      } else if (isStructured) {
        const studyPointsHtml = (evalData.studyPoints && evalData.studyPoints.length) ? `
          <div class="q-section-label" style="margin-top:12px">Study Points</div>
          <div class="q-study-points">
            ${evalData.studyPoints.map((p) => `<span class="q-study-point-chip">${this._escHtml(p)}</span>`).join('')}
          </div>
        ` : '';
        bodyContent = `
          ${answerBlock}
          ${section('Summary', evalData.summary)}
          ${section('What Went Well', evalData.strengths)}
          ${section('What Was Missing', evalData.gaps)}
          ${section('How To Improve', evalData.improvementAreas)}
          ${betterAnswer ? `
            <div class="q-section-label" style="margin-top:12px">How to Answer Better</div>
            <div class="q-better-answer">${renderMarkdown(betterAnswer)}</div>
          ` : ''}
          ${studyPointsHtml}
        `;
      } else {
        // Legacy row — old single blended `feedback` field, no migration
        // performed, still fully readable.
        bodyContent = `
          ${answerBlock}
          <div class="q-section-label" style="margin-top:12px">Feedback</div>
          <div class="q-feedback-text">${renderMarkdown(failureText)}</div>
          ${betterAnswer ? `
            <div class="q-section-label" style="margin-top:12px">How to Answer Better</div>
            <div class="q-better-answer">${renderMarkdown(betterAnswer)}</div>
          ` : ''}
        `;
      }

      return `
        <div class="q-item ${itemStateClass}" data-idx="${idx}" data-question-id="${q.id}">
          <div class="q-item-header">
            <span class="q-num">Q${qNum}</span>
            <span class="q-text" title="${this._escHtml(q.question)}">${this._escHtml(q.question)}</span>
            <span class="q-score-badge ${badgeStateClass}">${badgeText}</span>
            <svg class="q-chevron" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="6 9 12 15 18 9"/></svg>
          </div>
          <div class="q-item-body">
            ${bodyContent}
          </div>
        </div>
      `;
    }).join('');
  }

  _getGrade(score) {
    if (score >= 85) return { grade: '🏆 Excellent', cls: 'grade-a' };
    if (score >= 70) return { grade: '✅ Good',      cls: 'grade-b' };
    if (score >= 50) return { grade: '⚡ Average',   cls: 'grade-c' };
    return              { grade: '📚 Needs Work',   cls: 'grade-d' };
  }

  _escHtml(str) {
    if (!str) return '';
    return String(str)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#039;');
  }

  // ============================================================
  // TECH STACK SVG ICONS
  // ============================================================
  _buildTechStackData() {
    this._techStackData = {
      'Node.js': {
        glow: 'rgba(51,153,51,0.3)',
        svg: `<svg viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg">
          <path d="M12 1.85L2 7.2v9.6l10 5.35 10-5.35V7.2L12 1.85zM6 15.5V8.5l6 3.25 6-3.25v7l-6 3.25L6 15.5z" fill="#339933" opacity="0.8"/>
        </svg>`
      },
      'React': {
        glow: 'rgba(97,218,251,0.3)',
        svg: `<svg viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
          <ellipse cx="12" cy="12" rx="10" ry="3.5" stroke="#61DAFB" stroke-width="1.3"/>
          <ellipse cx="12" cy="12" rx="10" ry="3.5" transform="rotate(60 12 12)" stroke="#61DAFB" stroke-width="1.3"/>
          <ellipse cx="12" cy="12" rx="10" ry="3.5" transform="rotate(120 12 12)" stroke="#61DAFB" stroke-width="1.3"/>
          <circle cx="12" cy="12" r="2.2" fill="#61DAFB"/>
        </svg>`
      },
      'Next.js': {
        glow: 'rgba(255,255,255,0.2)',
        svg: `<svg viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
          <circle cx="12" cy="12" r="10.5" fill="#000" stroke="rgba(255,255,255,0.6)" stroke-width="1"/>
          <path d="M15.5 16.2L9 7.8H7.5V16.2H9V10.1l5.7 7.2c.3-.3.6-.7.8-1.1z" fill="white"/>
          <rect x="14.5" y="7.8" width="1.5" height="5" fill="white"/>
        </svg>`
      },
      'Python': {
        glow: 'rgba(55,118,171,0.35)',
        svg: `<svg viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
          <path d="M12 2C8.5 2 8 3.2 8 5v2h4v1H5.5C3.5 8 2.5 9 2.5 12c0 3 1 4.5 3 4.5H7v-2.5C7 12.5 8.2 11.5 9.5 11.5h5C16 11.5 17 10.5 17 9V5.5C17 3.5 15.5 2 12 2zm-1.5 2c.6 0 1 .4 1 1s-.4 1-1 1-1-.4-1-1 .4-1 1-1z" fill="#3776AB"/>
          <path d="M12 22c3.5 0 4-1.2 4-3v-2h-4v-1h6.5c2 0 3-1 3-4 0-3-1-4.5-3-4.5H17v2.5c0 1.5-1.2 2.5-2.5 2.5h-5C8 12.5 7 13.5 7 15v3.5C7 20.5 8.5 22 12 22zm1.5-2c-.6 0-1-.4-1-1s.4-1 1-1 1 .4 1 1-.4 1-1 1z" fill="#FFE052"/>
        </svg>`
      },
      'Django': {
        glow: 'rgba(9,46,32,0.5)',
        svg: `<svg viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg">
          <rect width="24" height="24" rx="6" fill="#092E20"/>
          <text x="5" y="17" font-family="sans-serif" font-size="12" font-weight="bold" fill="white">Dj</text>
        </svg>`
      },
      'Java': {
        glow: 'rgba(248,152,32,0.3)',
        svg: `<svg viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
          <path d="M8.5 17.5C8.5 19 10 20 12 20s3.5-1 3.5-2.5H8.5z" fill="#f89820"/>
          <path d="M15 14c0 1-2 1.8-4 1.8s-4-.8-4-1.8H15z" fill="#007396"/>
          <path d="M16 9.5c0-1.2-1.5-2.5-4-2.5C9 7 7 9 7 11c0 2 2 3.5 4 3.5 2.5 0 4-1 5-2.5a2 2 0 0 0 .5-2z" fill="#007396"/>
          <path d="M11 2s1.5 2-1 5c0 0 2.5-1.5 1-5zm-2 1.5s1.5 2-1 5c0 0 2.5-1.5 1-5z" fill="#f89820"/>
        </svg>`
      },
      'Spring Boot': {
        glow: 'rgba(109,179,63,0.3)',
        svg: `<svg viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
          <circle cx="12" cy="12" r="10" stroke="#6DB33F" stroke-width="1.5" fill="rgba(109,179,63,0.08)"/>
          <path d="M15 9.5a4.5 4.5 0 0 1-4.5 4.5 4.5 4.5 0 0 1-4.5-4.5c0-1 .5-2 1.2-3.5C8.7 8 10 9 10 9s.5-2 2-3.5C13.5 7 15 8.5 15 9.5z" fill="#6DB33F"/>
        </svg>`
      },
      'C#': {
        glow: 'rgba(23,134,0,0.3)',
        svg: `<svg viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
          <path d="M12 2.5L3.5 7.5v9l8.5 5 8.5-5v-9L12 2.5z" fill="rgba(23,134,0,0.15)" stroke="#178600" stroke-width="1.3"/>
          <path d="M10.5 15.5A3.5 3.5 0 0 1 7 12a3.5 3.5 0 0 1 3.5-3.5c1.3 0 2.4.7 3 1.7l-1.3.8c-.3-.6-.9-1-1.7-1-1 0-1.8.9-1.8 2s.8 2 1.8 2c.8 0 1.4-.4 1.7-1l1.3.8A3.5 3.5 0 0 1 10.5 15.5z" fill="#178600"/>
          <path d="M15.5 11h-1v-1h1v-1.5h1.5V10h1v1h-1v1.5H15.5V11zm0 2h-1v-1h1V10.5h1.5V12h1v1h-1v1.5H15.5V13z" fill="#178600"/>
        </svg>`
      },
      '.NET': {
        glow: 'rgba(81,43,212,0.3)',
        svg: `<svg viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
          <circle cx="12" cy="12" r="10" fill="#512BD4"/>
          <path d="M6.5 9h2v6h-2V9zm5 0h-2v6h2v-2.5h1.2c.9 0 1.8-.7 1.8-2V11.5c0-1.4-.9-2.5-1.8-2.5H11.5zm1.2 2.5c.2 0 .3.2.3.5s-.1.5-.3.5h-1.2v-1h1.2zm2.8 0h2v-2.5h2V9H15v6h4.5v-1.5H17v-1h1.5V11h-1.5v-.5h2v-1h-2V9zm.5-1.5L17 10h-1v-.5l1-1.5h1z" fill="white"/>
        </svg>`
      },
      'Ruby on Rails': {
        glow: 'rgba(204,0,0,0.3)',
        svg: `<svg viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
          <path d="M12 2L3 7.5v9L12 22l9-5.5v-9L12 2z" fill="rgba(204,0,0,0.15)" stroke="#CC0000" stroke-width="1.3"/>
          <path d="M8 9l4-2.5 4 2.5" stroke="#CC0000" stroke-width="1.5" stroke-linecap="round"/>
          <path d="M8 15l4 2.5 4-2.5" stroke="#CC0000" stroke-width="1.5" stroke-linecap="round"/>
          <path d="M8 9v6M16 9v6" stroke="#CC0000" stroke-width="1.5" stroke-linecap="round"/>
        </svg>`
      },
      'Go': {
        glow: 'rgba(0,173,216,0.3)',
        svg: `<svg viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
          <circle cx="5" cy="12" r="1.5" fill="#00ADD8"/>
          <circle cx="19" cy="12" r="1.5" fill="#00ADD8"/>
          <text x="4" y="16.5" font-family="sans-serif" font-size="10" font-weight="bold" fill="#00ADD8">Go</text>
        </svg>`
      },
      'Rust': {
        glow: 'rgba(228,55,23,0.3)',
        svg: `<svg viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
          <circle cx="12" cy="12" r="9" stroke="#E43717" stroke-width="1.5"/>
          <circle cx="12" cy="12" r="4" stroke="#E43717" stroke-width="1.5"/>
          <path d="M12 3v2M12 19v2M3 12h2M19 12h2" stroke="#E43717" stroke-width="1.5" stroke-linecap="round"/>
          <path d="M5.6 5.6l1.4 1.4M17 17l1.4 1.4M5.6 18.4l1.4-1.4M17 7l1.4-1.4" stroke="#E43717" stroke-width="1.5" stroke-linecap="round"/>
        </svg>`
      },
      'PHP': {
        glow: 'rgba(119,123,180,0.3)',
        svg: `<svg viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
          <ellipse cx="12" cy="12" rx="10" ry="6" fill="#777BB4" opacity="0.9"/>
          <text x="5.5" y="16" font-family="sans-serif" font-size="9" font-weight="bold" fill="white">PHP</text>
        </svg>`
      },
      'Laravel': {
        glow: 'rgba(255,45,32,0.3)',
        svg: `<svg viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
          <path d="M22 9.5l-4.5-7.5H7L3 8l4 3.5L5.5 14 9 17l4-2 4 2 4-5-1.5-2z" fill="rgba(255,45,32,0.1)" stroke="#FF2D20" stroke-width="1"/>
          <path d="M11 9l2 2-2 4" stroke="#FF2D20" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/>
          <path d="M13 9l2 2-2 4" stroke="#FF2D20" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" opacity="0.5"/>
        </svg>`
      },
      'Vue.js': {
        glow: 'rgba(79,192,141,0.3)',
        svg: `<svg viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
          <path d="M12 19.5L21.5 4H17L12 12 7 4H2.5L12 19.5z" fill="#41B883"/>
          <path d="M12 19.5L17.5 9.5H14L12 13 10 9.5H6.5L12 19.5z" fill="#35495E"/>
        </svg>`
      },
      'Angular': {
        glow: 'rgba(221,0,49,0.3)',
        svg: `<svg viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
          <path d="M12 2.5L3.5 5.5 5 18l7 4 7-4 1.5-12.5L12 2.5z" fill="#DD0031"/>
          <path d="M12 4.5l5.5 10H15L13.5 11h-3L9 14.5H6.5l5.5-10z" fill="white"/>
          <path d="M10.5 11h3l-1.5-3.5L10.5 11z" fill="#DD0031"/>
        </svg>`
      },
      'Svelte': {
        glow: 'rgba(255,62,0,0.3)',
        svg: `<svg viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
          <path d="M19.5 7.5C18 4 14 2.5 10 4.5L5.5 9c-1.5 2-1.5 4.5-.5 6.5.5 1 1.2 2 2.2 2.5-.2.8-.1 1.7.5 2.5 1.5 2 4.5 2.5 7 1L19 17c1.5-2 1.5-4.5.5-6.5-.5-1-1.2-2-2.2-2.5.2-.8.1-1.7-.5-2.5h.7z" fill="#FF3E00" opacity="0.15"/>
          <path d="M19.5 7.5C18 4 14 2.5 10 4.5L5.5 9c-1.5 2-1.5 4.5-.5 6.5.5 1 1.2 2 2.2 2.5-.2.8-.1 1.7.5 2.5 1.5 2 4.5 2.5 7 1L19 17c1.5-2 1.5-4.5.5-6.5-.5-1-1.2-2-2.2-2.5.2-.8.1-1.7-.5-2.5z" stroke="#FF3E00" stroke-width="1.5"/>
          <path d="M10 14c1.5-1.5 4-2 6-1-1-1.5-3-2-5-1.5l-4 2c-1.5 1-2 3-1 4.5C7.5 15.5 8.5 15 10 14z" fill="#FF3E00"/>
        </svg>`
      },
      'MERN Stack': {
        glow: 'rgba(6,182,212,0.3)',
        svg: `<svg viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
          <circle cx="12" cy="12" r="10" stroke="url(#m1)" stroke-width="1.5"/>
          <text x="5.5" y="15" font-family="sans-serif" font-size="7.5" font-weight="bold" fill="url(#m1)">MERN</text>
          <defs>
            <linearGradient id="m1" x1="2" y1="2" x2="22" y2="22">
              <stop stop-color="#06B6D4"/><stop offset="1" stop-color="#8B5CF6"/>
            </linearGradient>
          </defs>
        </svg>`
      },
      'MEAN Stack': {
        glow: 'rgba(16,185,129,0.3)',
        svg: `<svg viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
          <circle cx="12" cy="12" r="10" stroke="url(#m2)" stroke-width="1.5"/>
          <text x="5" y="15" font-family="sans-serif" font-size="7" font-weight="bold" fill="url(#m2)">MEAN</text>
          <defs>
            <linearGradient id="m2" x1="2" y1="2" x2="22" y2="22">
              <stop stop-color="#10B981"/><stop offset="1" stop-color="#06B6D4"/>
            </linearGradient>
          </defs>
        </svg>`
      },
      'LAMP Stack': {
        glow: 'rgba(245,158,11,0.3)',
        svg: `<svg viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
          <path d="M12 2a6 6 0 0 0-6 6c0 2.3 1.2 4.3 3 5.5.5.4.9 1 1 1.5l.7 3.2c.1.4.5.8 1 .8h.6c.5 0 .9-.4 1-.8l.7-3.2c.1-.5.5-1.1 1-1.5 1.8-1.2 3-3.2 3-5.5a6 6 0 0 0-6-6z" fill="#F59E0B" opacity="0.9"/>
          <path d="M10 19.5h4M11 21h2" stroke="#F59E0B" stroke-width="1.5" stroke-linecap="round"/>
        </svg>`
      },
      'MySQL': {
        glow: 'rgba(0,117,143,0.3)',
        svg: `<svg viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
          <path d="M12 2C7.58 2 4 3.79 4 6v12c0 2.21 3.58 4 8 4s8-1.79 8-4V6c0-2.21-3.58-4-8-4z" fill="rgba(0,117,143,0.12)" stroke="#00758F" stroke-width="1.2"/>
          <ellipse cx="12" cy="6" rx="8" ry="4" fill="rgba(0,117,143,0.2)" stroke="#00758F" stroke-width="1.2"/>
          <path d="M4 12c0 2.21 3.58 4 8 4s8-1.79 8-4" stroke="#00758F" stroke-width="1.2"/>
          <path d="M4 17c0 2.21 3.58 4 8 4s8-1.79 8-4" stroke="#00758F" stroke-width="1.2" opacity="0.6"/>
          <text x="7" y="11" font-family="sans-serif" font-size="4" font-weight="bold" fill="#00758F">SQL</text>
        </svg>`
      },
      'Job Description': {
        glow: 'rgba(139,92,246,0.3)',
        svg: `<svg viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
          <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" fill="rgba(139,92,246,0.1)" stroke="#8B5CF6" stroke-width="1.3"/>
          <polyline points="14 2 14 8 20 8" stroke="#8B5CF6" stroke-width="1.3"/>
          <line x1="16" y1="13" x2="8" y2="13" stroke="#8B5CF6" stroke-width="1.3"/>
          <line x1="16" y1="17" x2="8" y2="17" stroke="#8B5CF6" stroke-width="1.3"/>
          <polyline points="10 9 9 9 8 9" stroke="#8B5CF6" stroke-width="1.3"/>
        </svg>`
      },
      // See docs/project-improvement/RESUME_MODE_PLAN.md §2 — same
      // document-shaped glyph as 'Job Description' (both are "paste text,
      // AI reads it") but in cyan rather than purple so the two modes
      // stay visually distinct at a glance.
      'Resume': {
        glow: 'rgba(6,182,212,0.3)',
        svg: `<svg viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
          <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" fill="rgba(6,182,212,0.1)" stroke="#06B6D4" stroke-width="1.3"/>
          <polyline points="14 2 14 8 20 8" stroke="#06B6D4" stroke-width="1.3"/>
          <circle cx="9.5" cy="13" r="1.6" stroke="#06B6D4" stroke-width="1.2"/>
          <path d="M6.8 18c.4-1.6 1.6-2.5 2.7-2.5s2.3.9 2.7 2.5" stroke="#06B6D4" stroke-width="1.2" stroke-linecap="round"/>
          <line x1="14.5" y1="12" x2="17" y2="12" stroke="#06B6D4" stroke-width="1.2"/>
          <line x1="14.5" y1="15" x2="17" y2="15" stroke="#06B6D4" stroke-width="1.2"/>
        </svg>`
      },
      'default': {
        glow: 'rgba(148,163,184,0.2)',
        svg: `<svg viewBox="0 0 24 24" fill="none" stroke="#94a3b8" stroke-width="1.5" xmlns="http://www.w3.org/2000/svg">
          <rect x="3" y="3" width="18" height="18" rx="4"/>
          <path d="M9 9h6M9 12h6M9 15h4"/>
        </svg>`
      }
    };
  }

  // ============================================================
  // HISTORY
  // ============================================================
  renderHistoryList(sessions) {
    const container = this.el('history-list');
    if (!container) return;

    if (!sessions || sessions.length === 0) {
      container.innerHTML = `
        <div class="history-empty">
          <svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="var(--text-3)" stroke-width="1.5">
            <circle cx="12" cy="12" r="10"/>
            <polyline points="12 6 12 12 16 14"/>
          </svg>
          <h3>No Interviews Yet</h3>
          <p>Complete an interview to see it here. Your history will be saved so you can review your performance over time.</p>
        </div>
      `;
      return;
    }

    container.innerHTML = sessions.map(s => {
      const date = new Date(s.createdAt);
      const dateStr = date.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
      const timeStr = date.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' });
      const score = s.overallScore ?? '—';
      const scoreNum = typeof score === 'number' ? score : null;
      const badgeClass = scoreNum !== null
        ? (scoreNum >= 70 ? 'high' : scoreNum >= 50 ? 'medium' : 'low')
        : 'medium';
      const answered = s.answeredCount ?? 0;
      const total = s.totalQuestions ?? 0;
      // Anonymous-history entries (from this browser's own localStorage
      // list, before a full session detail is fetched) may not carry a
      // level at all — same "don't show a blank pill" treatment as the
      // badges elsewhere.
      const levelLabel = s.difficultyLevel ? this.getLevelLabel(s.difficultyLevel) : '';

      return `
        <div class="history-card" data-session-id="${s.id}">
          <div class="history-card-left">
            <div class="history-card-tech">${this._escHtml(s.techStack)}</div>
            <div class="history-card-date">${dateStr} at ${timeStr}</div>
            <div class="history-card-meta">${answered}/${total} questions${levelLabel ? ` • <span class="history-card-level">${this._escHtml(levelLabel)}</span>` : ''} • ${this._escHtml(s.provider || '')}</div>
          </div>
          <div class="history-card-right">
            <span class="history-score-badge ${badgeClass}">${scoreNum !== null ? score : '—'}</span>
          </div>
        </div>
      `;
    }).join('');
  }

  renderHistoryDetail(session) {
    this.showPanel('history-detail-panel');

    const titleEl = this.el('detail-title');
    if (titleEl) titleEl.textContent = `${session.techStack} Interview`;

    const score = session.finalEvaluation?.overallScore ?? 0;
    const feedback = session.finalEvaluation?.overallFeedback ?? 'No feedback available.';

    // Score
    const scoreEl = this.el('detail-score');
    if (scoreEl) scoreEl.textContent = score;

    // Ring animation
    const ring = this.el('detail-score-ring');
    if (ring) {
      const circumference = 2 * Math.PI * 52;
      const offset = circumference - (score / 100) * circumference;
      const svgEl = ring.closest('svg');
      if (svgEl && !svgEl.querySelector('defs')) {
        svgEl.insertAdjacentHTML('afterbegin', `
          <defs>
            <linearGradient id="detail-score-grad" x1="0%" y1="0%" x2="100%" y2="100%">
              <stop offset="0%" stop-color="#10b981"/>
              <stop offset="100%" stop-color="#06b6d4"/>
            </linearGradient>
          </defs>
        `);
        ring.setAttribute('stroke', 'url(#detail-score-grad)');
      }
      ring.style.strokeDasharray = circumference;
      ring.style.strokeDashoffset = circumference;
      requestAnimationFrame(() => {
        setTimeout(() => { ring.style.strokeDashoffset = offset; }, 100);
      });
    }

    // Grade
    const gradeEl = this.el('detail-grade');
    if (gradeEl) {
      const { grade, cls } = this._getGrade(score);
      gradeEl.textContent = grade;
      gradeEl.className = `score-grade ${cls}`;
    }

    // Level badge — session.difficultyLevel is always present on a full
    // session record (see SessionData.difficultyLevel / resolveDifficultyLevel).
    const levelBadgeEl = this.el('detail-level-badge');
    if (levelBadgeEl) levelBadgeEl.textContent = session.difficultyLevel ? this.getLevelLabel(session.difficultyLevel) : '';

    // Feedback — rendered as markdown, same as the completion panel.
    const fbEl = this.el('detail-feedback');
    if (fbEl) fbEl.innerHTML = renderMarkdown(feedback);

    // Same "may be out of date" banner as the completion panel — see §6.
    this._renderFeedbackStatusBanner('detail-feedback-status', session.finalEvaluation);

    // Stats
    const answered = session.answeredCount ?? session.answers?.length ?? 0;
    const total = session.totalQuestions ?? session.questions?.length ?? 0;
    const saEl = this.el('detail-stat-answered');
    const stEl = this.el('detail-stat-total');
    const techEl = this.el('detail-stat-tech');
    if (saEl) saEl.textContent = answered;
    if (stEl) stEl.textContent = total;
    if (techEl) techEl.textContent = session.techStack;

    // Build evaluations map from session data
    const evaluations = {};
    if (session.evaluations) {
      (Array.isArray(session.evaluations) ? session.evaluations : []).forEach(e => {
        evaluations[e.questionId] = e;
      });
    }

    // Build answers map from session data — same "show the user's own
    // answer" treatment as the completion panel (see _renderQuestionItems).
    const answers = {};
    if (session.answers) {
      (Array.isArray(session.answers) ? session.answers : []).forEach(a => {
        answers[a.questionId] = a.text;
      });
    }

    // Build question breakdown
    const container = this.el('detail-questions-breakdown');
    if (container && session.questions) {
      this._buildBreakdownInto(container, session.questions, evaluations, answers);
    }
  }

  _buildBreakdownInto(container, questions, evaluations, answers = {}) {
    container.innerHTML = this._renderQuestionItems(questions, evaluations, answers);
  }

  /**
   * Re-renders just the per-question breakdown in place — e.g. after
   * app.js fetches on-demand answer guidance for a previously-failed
   * question — without touching the rest of the panel (score, banner,
   * etc.). `containerId` is 'questions-breakdown' (live completion page)
   * or 'detail-questions-breakdown' (history detail view); both host the
   * same markup (see _bindDelegatedListeners). Re-opens the card that
   * triggered the refresh, if any, since a full innerHTML replace would
   * otherwise silently collapse it back closed.
   */
  refreshBreakdown(containerId, questions, evaluations, answers = {}, reopenQuestionId) {
    const container = this.el(containerId);
    if (!container) return;
    container.innerHTML = this._renderQuestionItems(questions, evaluations, answers);
    if (reopenQuestionId !== undefined && reopenQuestionId !== null) {
      const item = container.querySelector(`.q-item[data-question-id="${reopenQuestionId}"]`);
      if (item) item.classList.add('open');
    }
  }
}
