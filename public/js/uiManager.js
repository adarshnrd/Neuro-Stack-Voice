export class UIManager {
  constructor() {
    this._cache = {};
    this._buildTechStackData();
    this._silenceTimer = null;
    this._silenceCountdown = 0;
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
    const panels = ['setup-panel', 'interview-panel', 'loading-panel', 'completion-panel', 'history-panel', 'history-detail-panel'];
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
        const fallback = ['Node.js','React','Next.js','Python','Django','Java','Spring Boot','C#','.NET','Ruby on Rails','Go','Rust','PHP','Laravel','Vue.js','Angular','Svelte','MERN Stack','MEAN Stack','LAMP Stack','MySQL','Job Description'];
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
  showCompletion(summary, questions, evaluations, meta = {}) {
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

    // Feedback text
    const fbEl = this.el('final-feedback');
    if (fbEl) fbEl.textContent = feedback;

    // Build per-question breakdown
    this._buildBreakdown(questions, evaluations);
  }

  _buildBreakdown(questions, evaluations) {
    const container = this.el('questions-breakdown');
    if (!container) return;

    if (!questions || questions.length === 0) {
      container.innerHTML = '<p style="color:var(--text-3);text-align:center">No question data available</p>';
      return;
    }

    container.innerHTML = questions.map((q, idx) => {
      const qNum = idx + 1;
      const evalData = evaluations[q.id];
      const score = evalData?.score ?? '—';
      const feedback = evalData?.feedback ?? 'No feedback available for this question.';
      const betterAnswer = evalData?.betterAnswer ?? '';

      const scoreNum = typeof score === 'number' ? score : null;
      const badgeClass = scoreNum !== null
        ? (scoreNum >= 7 ? 'high' : scoreNum >= 4 ? 'medium' : 'low')
        : 'medium';

      const scoreDisplay = scoreNum !== null ? `${score}/10` : score;

      return `
        <div class="q-item ${!evalData ? 'q-skipped' : ''}" data-idx="${idx}">
          <div class="q-item-header" onclick="this.parentElement.classList.toggle('open')">
            <span class="q-num">Q${qNum}</span>
            <span class="q-text" title="${this._escHtml(q.question)}">${this._escHtml(q.question)}</span>
            <span class="q-score-badge ${evalData ? badgeClass : 'skipped'}">${evalData ? scoreDisplay : 'Skipped'}</span>
            <svg class="q-chevron" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="6 9 12 15 18 9"/></svg>
          </div>
          <div class="q-item-body">
            ${evalData ? `
              <div class="q-section-label">Feedback</div>
              <p class="q-feedback-text">${this._escHtml(feedback)}</p>
              ${betterAnswer ? `
                <div class="q-section-label" style="margin-top:12px">How to Answer Better</div>
                <div class="q-better-answer">${this._escHtml(betterAnswer)}</div>
              ` : ''}
            ` : `
              <p class="q-feedback-text" style="color:var(--text-3);font-style:italic">This question was not attempted.</p>
            `}
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

      return `
        <div class="history-card" data-session-id="${s.id}" onclick="window.app.viewHistoryDetail('${s.id}')">
          <div class="history-card-left">
            <div class="history-card-tech">${this._escHtml(s.techStack)}</div>
            <div class="history-card-date">${dateStr} at ${timeStr}</div>
            <div class="history-card-meta">${answered}/${total} questions • ${this._escHtml(s.provider || '')}</div>
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

    // Feedback
    const fbEl = this.el('detail-feedback');
    if (fbEl) fbEl.textContent = feedback;

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

    // Build question breakdown
    const container = this.el('detail-questions-breakdown');
    if (container && session.questions) {
      this._buildBreakdownInto(container, session.questions, evaluations);
    }
  }

  _buildBreakdownInto(container, questions, evaluations) {
    if (!questions || questions.length === 0) {
      container.innerHTML = '<p style="color:var(--text-3);text-align:center">No question data available</p>';
      return;
    }

    container.innerHTML = questions.map((q, idx) => {
      const qNum = idx + 1;
      const evalData = evaluations[q.id];
      const score = evalData?.score ?? '—';
      const feedback = evalData?.feedback ?? 'No feedback available for this question.';
      const betterAnswer = evalData?.betterAnswer ?? '';

      const scoreNum = typeof score === 'number' ? score : null;
      const badgeClass = scoreNum !== null
        ? (scoreNum >= 7 ? 'high' : scoreNum >= 4 ? 'medium' : 'low')
        : 'medium';

      const scoreDisplay = scoreNum !== null ? `${score}/10` : score;

      return `
        <div class="q-item ${!evalData ? 'q-skipped' : ''}" data-idx="${idx}">
          <div class="q-item-header" onclick="this.parentElement.classList.toggle('open')">
            <span class="q-num">Q${qNum}</span>
            <span class="q-text" title="${this._escHtml(q.question)}">${this._escHtml(q.question)}</span>
            <span class="q-score-badge ${evalData ? badgeClass : 'skipped'}">${evalData ? scoreDisplay : 'Skipped'}</span>
            <svg class="q-chevron" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="6 9 12 15 18 9"/></svg>
          </div>
          <div class="q-item-body">
            ${evalData ? `
              <div class="q-section-label">Feedback</div>
              <p class="q-feedback-text">${this._escHtml(feedback)}</p>
              ${betterAnswer ? `
                <div class="q-section-label" style="margin-top:12px">How to Answer Better</div>
                <div class="q-better-answer">${this._escHtml(betterAnswer)}</div>
              ` : ''}
            ` : `
              <p class="q-feedback-text" style="color:var(--text-3);font-style:italic">This question was not attempted.</p>
            `}
          </div>
        </div>
      `;
    }).join('');
  }
}
