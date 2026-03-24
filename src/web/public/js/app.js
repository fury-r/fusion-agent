/* UI application logic - vanilla JS for browser compatibility */
(function () {
  const socket = io();
  let currentSessionId = null;

  // Navigation
  document.querySelectorAll('.nav-item').forEach(function (link) {
    link.addEventListener('click', function (e) {
      e.preventDefault();
      const page = link.getAttribute('data-page');
      showPage(page);
      document.querySelectorAll('.nav-item').forEach(function (l) { l.classList.remove('active'); });
      link.classList.add('active');
    });
  });

  function showPage(name) {
    document.querySelectorAll('.page').forEach(function (p) { p.classList.remove('active'); });
    const page = document.getElementById('page-' + name);
    if (page) page.classList.add('active');
  }

  // Toast notifications
  function showToast(message, type) {
    const toast = document.getElementById('toast');
    toast.textContent = message;
    toast.className = 'toast ' + (type || '');
    setTimeout(function () { toast.className = 'toast hidden'; }, 3000);
  }

  // --- Sessions ---
  function loadSessions() {
    fetch('/api/sessions')
      .then(function (r) { return r.json(); })
      .then(function (data) { renderSessions(data.sessions || []); })
      .catch(function (err) {
        document.getElementById('sessions-list').innerHTML =
          '<div class="loading">Error loading sessions: ' + err.message + '</div>';
      });
  }

  function renderSessions(sessions) {
    const container = document.getElementById('sessions-list');
    if (!sessions.length) {
      container.innerHTML = '<div class="empty-state"><h2>No sessions yet</h2><p>Start a session from the CLI with <code>ai-agent chat</code></p></div>';
      return;
    }
    container.innerHTML = sessions.map(function (s) {
      const statusClass = 'status-' + s.status;
      const turns = (s.turns || []).length;
      const updated = new Date(s.updatedAt).toLocaleString();
      return '<div class="session-card" data-id="' + s.id + '">' +
        '<div class="session-card-header">' +
        '<div class="session-status ' + statusClass + '"></div>' +
        '<div>' +
        '<div class="session-name">' + (s.config.speckit === 'debugger' ? '🔍 ' : '') + escHtml(s.name) + '</div>' +
        '<div class="session-meta">' + turns + ' turns · Updated ' + updated + '</div>' +
        '</div>' +
        '</div>' +
        '<div class="session-tags">' +
        '<span class="tag">' + escHtml(s.config.provider) + '</span>' +
        '<span class="tag">' + escHtml(s.config.model || 'default') + '</span>' +
        (s.config.speckit ? '<span class="tag">' + escHtml(s.config.speckit) + '</span>' : '') +
        '</div>' +
        '</div>';
    }).join('');

    document.querySelectorAll('.session-card').forEach(function (card) {
      card.addEventListener('click', function () {
        openSession(card.getAttribute('data-id'));
      });
    });
  }

  function openSession(id) {
    currentSessionId = id;
    fetch('/api/sessions/' + id)
      .then(function (r) { return r.json(); })
      .then(function (data) { renderSessionDetail(data); })
      .catch(function (err) { showToast('Error: ' + err.message, 'error'); });
  }

  function renderSessionDetail(session) {
    if (session.config && session.config.speckit === 'debugger') {
      renderDebuggerDetail(session);
      return;
    }
    document.getElementById('session-detail-title').textContent = session.name;
    showPage('session-detail');

    const guardrails = (session.config.guardrails || []);
    const turns = (session.turns || []);

    const html =
      '<div class="session-info">' +
      infoItem('ID', session.id) +
      infoItem('Status', session.status) +
      infoItem('Provider', session.config.provider) +
      infoItem('Model', session.config.model || 'default') +
      infoItem('Speckit', session.config.speckit || '—') +
      infoItem('Created', new Date(session.createdAt).toLocaleString()) +
      '</div>' +

      (guardrails.length ? '<div class="guardrails-section"><div class="section-title">Guardrails (' + guardrails.length + ')</div>' +
        guardrails.map(function (g) {
          return '<div class="guardrail-item"><div class="guardrail-type">' + escHtml(g.type) + '</div>' +
            (g.description || '') + ' ' + JSON.stringify(g.value) + '</div>';
        }).join('') + '</div>' : '') +

      '<div class="turns-section"><div class="section-title">Conversation (' + turns.length + ' turns)</div>' +
      (turns.length === 0 ? '<div class="loading">No conversation yet</div>' :
        turns.map(function (t) {
          const fileChanges = (t.fileChanges || []);
          return '<div class="turn-item">' +
            '<div class="turn-header">' + new Date(t.timestamp).toLocaleString() +
            (t.usage ? ' · ' + t.usage.totalTokens + ' tokens' : '') + '</div>' +
            '<div class="turn-messages">' +
            '<div class="message"><div class="message-role user">You</div>' +
            '<div class="message-content">' + escHtml(t.userMessage) + '</div></div>' +
            '<div class="message"><div class="message-role assistant">Assistant</div>' +
            '<div class="message-content">' + escHtml(t.assistantMessage.slice(0, 800)) +
            (t.assistantMessage.length > 800 ? '…' : '') + '</div></div>' +
            (fileChanges.length ? '<div class="file-changes"><div class="file-change-title">Files changed:</div>' +
              fileChanges.map(function (fc) { return '<div class="file-change-item">' + escHtml(fc.filePath) + '</div>'; }).join('') +
              '</div>' : '') +
            '</div></div>';
        }).join('')) +
      '</div>';

    document.getElementById('session-detail-content').innerHTML = html;

    // Subscribe to real-time updates
    socket.emit('subscribe:session', currentSessionId);
  }

  function infoItem(label, value) {
    return '<div class="session-info-item"><label>' + label + '</label><span>' + escHtml(String(value)) + '</span></div>';
  }

  document.getElementById('back-btn').addEventListener('click', function () {
    if (currentSessionId) socket.emit('unsubscribe:session', currentSessionId);
    currentSessionId = null;
    showPage('sessions');
    loadSessions();
  });

  document.getElementById('refresh-btn').addEventListener('click', loadSessions);

  document.getElementById('export-btn').addEventListener('click', function () {
    if (currentSessionId) {
      window.location.href = '/api/sessions/' + currentSessionId + '/export';
    }
  });

  document.getElementById('delete-btn').addEventListener('click', function () {
    if (!currentSessionId) return;
    if (!confirm('Delete this session? This cannot be undone.')) return;
    fetch('/api/sessions/' + currentSessionId, { method: 'DELETE' })
      .then(function (r) { return r.json(); })
      .then(function () {
        showToast('Session deleted', 'success');
        document.getElementById('back-btn').click();
      })
      .catch(function (err) { showToast('Error: ' + err.message, 'error'); });
  });

  // --- Settings ---
  function loadSettings() {
    fetch('/api/settings')
      .then(function (r) { return r.json(); })
      .then(function (data) {
        const f = document.getElementById('settings-form');
        if (data.provider) f.provider.value = data.provider;
        if (data.model) f.model.value = data.model;
        if (data.port) f.port.value = data.port;
        if (data.logLevel) f.logLevel.value = data.logLevel;
      });
  }

  document.getElementById('settings-form').addEventListener('submit', function (e) {
    e.preventDefault();
    const f = e.target;
    const body = {
      provider: f.provider.value,
      model: f.model.value,
      port: parseInt(f.port.value) || 3000,
      logLevel: f.logLevel.value,
    };
    fetch('/api/settings', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    })
      .then(function () { showToast('Settings saved', 'success'); })
      .catch(function (err) { showToast('Error: ' + err.message, 'error'); });
  });

  // Real-time session update
  socket.on('session:updated', function (data) {
    if (data.sessionId === currentSessionId) {
      openSession(currentSessionId);
    }
  });

  function escHtml(str) {
    return String(str)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  // Init
  loadSessions();
  loadSettings();

  // ============================================================
  // VIBE CODER
  // ============================================================

  var vibeSessionId = null;
  var vibeStreaming = false;
  var vibeChatBubble = null;   // current streaming assistant bubble element
  var autoRules = [];
  var vibePageActive = false;

  // ---- Page lifecycle ----------------------------------------

  function onVibePageEnter() {
    document.querySelector('.main-content').classList.add('vibe-mode');
    if (!vibeSessionId) {
      startVibeSession();
    }
  }

  function onVibePageLeave() {
    document.querySelector('.main-content').classList.remove('vibe-mode');
  }

  // ---- Tab switching -----------------------------------------

  function switchVibeTab(tab) {
    document.querySelectorAll('.vibe-tab-content').forEach(function (el) {
      el.classList.toggle('active', el.id === 'vibe-tab-' + tab);
    });
    document.querySelectorAll('.vibe-tab-btn').forEach(function (btn) {
      btn.classList.toggle('active', btn.getAttribute('data-tab') === tab);
    });
  }

  // ---- Session management ------------------------------------

  function startVibeSession() {
    var nameInput = document.getElementById('vibe-session-name');
    var dirInput = document.getElementById('vibe-project-dir');
    var payload = {};
    if (nameInput && nameInput.value.trim()) payload.sessionName = nameInput.value.trim();
    if (dirInput && dirInput.value.trim()) payload.projectDir = dirInput.value.trim();
    socket.emit('vibe:start', payload);
    clearVibeChat();
  }

  function clearVibeChat() {
    document.getElementById('vibe-messages').innerHTML = '';
    vibeChatBubble = null;
    vibeStreaming = false;
    document.getElementById('vibe-send-btn').disabled = false;
  }

  // ---- Chat --------------------------------------------------

  function sendVibeChat() {
    if (!vibeSessionId) { showToast('Start a session first', 'error'); return; }
    var input = document.getElementById('vibe-input');
    var msg = input.value.trim();
    if (!msg) return;
    input.value = '';
    appendUserMessage(msg);
    vibeChatBubble = appendAssistantBubble();
    vibeStreaming = true;
    document.getElementById('vibe-send-btn').disabled = true;
    socket.emit('vibe:chat', { sessionId: vibeSessionId, message: msg });
  }

  function appendUserMessage(text) {
    var msgs = document.getElementById('vibe-messages');
    var div = document.createElement('div');
    div.className = 'vibe-msg vibe-msg-user';
    div.innerHTML = '<div class="vibe-msg-bubble">' + escHtml(text).replace(/\n/g, '<br>') + '</div>';
    msgs.appendChild(div);
    msgs.scrollTop = msgs.scrollHeight;
  }

  function appendAssistantBubble() {
    var msgs = document.getElementById('vibe-messages');
    var div = document.createElement('div');
    div.className = 'vibe-msg vibe-msg-assistant';
    div.innerHTML = '<div class="vibe-msg-bubble streaming"></div>';
    msgs.appendChild(div);
    msgs.scrollTop = msgs.scrollHeight;
    return div.querySelector('.vibe-msg-bubble');
  }

  // ---- Message renderer (code-block aware) -------------------

  function renderMessageContent(text) {
    var parts = [];
    var regex = /```([^\n]*)\n([\s\S]*?)```/g;
    var lastIndex = 0;
    var match;
    while ((match = regex.exec(text)) !== null) {
      if (match.index > lastIndex) {
        parts.push({ type: 'text', content: text.slice(lastIndex, match.index) });
      }
      parts.push({ type: 'code', lang: match[1], content: match[2] });
      lastIndex = regex.lastIndex;
    }
    if (lastIndex < text.length) {
      parts.push({ type: 'text', content: text.slice(lastIndex) });
    }
    return parts.map(function (part) {
      if (part.type === 'code') {
        var header = part.lang
          ? '<div class="code-header">' + escHtml(part.lang) + '</div>'
          : '';
        return '<div class="code-block">' + header +
          '<pre><code>' + escHtml(part.content) + '</code></pre></div>';
      }
      return part.content.split('\n').map(function (line) {
        return line ? '<p>' + escHtml(line) + '</p>' : '<br>';
      }).join('');
    }).join('');
  }

  // ---- File chips --------------------------------------------

  function addFileChip(panelId, filePath, stepNumber) {
    var panel = document.getElementById(panelId);
    if (!panel) return;
    var chip = document.createElement('div');
    chip.className = 'file-chip';
    chip.textContent = (stepNumber != null ? '[' + stepNumber + '] ' : '') + filePath;
    chip.title = filePath;
    panel.appendChild(chip);
  }

  // ---- Session info mini-card --------------------------------

  function updateVibeSessionInfo(session) {
    var info = document.getElementById('vibe-session-info');
    info.innerHTML =
      '<div class="panel-section"><div class="section-label">Name</div>' +
        '<div class="info-value">' + escHtml(session.name || '—') + '</div></div>' +
      '<div class="panel-section"><div class="section-label">Provider</div>' +
        '<div class="info-value">' + escHtml((session.config && session.config.provider) || '—') + '</div></div>' +
      '<div class="panel-section"><div class="section-label">Model</div>' +
        '<div class="info-value">' + escHtml((session.config && session.config.model) || '—') + '</div></div>' +
      '<div class="panel-section"><div class="section-label">Directory</div>' +
        '<div class="info-value">' + escHtml((session.config && session.config.projectDir) || '—') + '</div></div>';
  }

  // ---- Status pill -------------------------------------------

  var VALID_STATUSES = { 'idle': true, 'running': true, 'waiting-hil': true, 'completed': true, 'stopped': true, 'timed-out': true };

  function setVibeStatus(status) {
    var pill = document.getElementById('vibe-status-pill');
    var safeStatus = VALID_STATUSES[status] ? status : 'idle';
    pill.className = 'status-pill status-' + safeStatus;
    pill.textContent = safeStatus;
  }

  // ---- Autonomous rules editor --------------------------------

  function renderAutoRules() {
    var list = document.getElementById('auto-rules-list');
    list.innerHTML = autoRules.map(function (rule, idx) {
      return '<div class="rule-item">' +
        '<span class="rule-text">' + escHtml(rule.description) + '</span>' +
        '<button class="btn-icon btn-icon-danger remove-rule-btn" data-idx="' + idx + '" title="Remove rule">×</button>' +
        '</div>';
    }).join('');
    list.querySelectorAll('.remove-rule-btn').forEach(function (btn) {
      btn.addEventListener('click', function () {
        autoRules.splice(parseInt(btn.getAttribute('data-idx')), 1);
        renderAutoRules();
      });
    });
  }

  function addAutoRule() {
    var input = document.getElementById('new-rule-input');
    var text = input.value.trim();
    if (!text) return;
    autoRules.push({ id: 'rule-' + Date.now(), description: text });
    input.value = '';
    renderAutoRules();
  }

  // ---- Autonomous run/stop ------------------------------------

  function runAutonomous() {
    if (!vibeSessionId) { showToast('Start a session first', 'error'); return; }
    var reqFile = document.getElementById('auto-req-file').value.trim();
    var reqContent = document.getElementById('auto-req-content').value.trim();
    if (!reqFile && !reqContent) {
      showToast('Provide a requirements file path or paste requirements', 'error');
      return;
    }
    var timeLimitVal = parseInt(document.getElementById('auto-time-limit').value) || 0;
    var maxStepsVal = parseInt(document.getElementById('auto-max-steps').value) || 0;
    var config = { rules: autoRules.slice() };
    if (reqFile) config.requirementsFile = reqFile;
    if (reqContent) config.requirementsContent = reqContent;
    if (timeLimitVal > 0) config.timeLimitSeconds = timeLimitVal;
    if (maxStepsVal > 0) config.maxSteps = maxStepsVal;
    socket.emit('vibe:start-autonomous', { sessionId: vibeSessionId, config: config });
    document.getElementById('auto-run-btn').disabled = true;
    document.getElementById('auto-stop-btn').classList.remove('hidden');
    document.getElementById('auto-steps-list').innerHTML = '';
    document.getElementById('auto-current-output').textContent = '';
    document.getElementById('auto-files-panel').innerHTML = '';
  }

  // ---- HIL modal ---------------------------------------------

  function showHilModal(data) {
    var request = data.request || {};
    document.getElementById('hil-reason').textContent = request.reason || '';
    document.getElementById('hil-confusion').textContent = request.confusionSummary || '';
    var ul = document.getElementById('hil-recent-steps');
    ul.innerHTML = (request.recentSteps || []).map(function (s) {
      return '<li>' + escHtml(typeof s === 'string' ? s : JSON.stringify(s)) + '</li>';
    }).join('');
    document.getElementById('hil-guidance').value = '';
    document.getElementById('hil-modal').classList.remove('hidden');
  }

  // ---- Socket event listeners --------------------------------

  socket.on('vibe:ready', function (session) {
    vibeSessionId = session.id || session.sessionId;
    setVibeStatus('idle');
    var nameInput = document.getElementById('vibe-session-name');
    if (nameInput && !nameInput.value.trim()) {
      nameInput.value = session.name || '';
    }
    updateVibeSessionInfo(session);
    if (session.turns && session.turns.length) {
      clearVibeChat();
      session.turns.forEach(function (turn) {
        appendUserMessage(turn.userMessage || '');
        var bubble = appendAssistantBubble();
        bubble.classList.remove('streaming');
        bubble.innerHTML = renderMessageContent(turn.assistantMessage || '');
      });
    }
  });

  socket.on('vibe:chunk', function (data) {
    if (data.stepNumber != null) {
      // Autonomous mode: append to current-output pre
      var out = document.getElementById('auto-current-output');
      if (out) {
        out.textContent += data.chunk;
        out.scrollTop = out.scrollHeight;
      }
    } else {
      // Chat mode: stream into bubble (textContent, replaced on turn-complete)
      if (vibeChatBubble) {
        vibeChatBubble.textContent += data.chunk;
        var msgs = document.getElementById('vibe-messages');
        if (msgs) msgs.scrollTop = msgs.scrollHeight;
      }
    }
  });

  socket.on('vibe:turn-complete', function (data) {
    vibeStreaming = false;
    document.getElementById('vibe-send-btn').disabled = false;
    if (vibeChatBubble) {
      vibeChatBubble.classList.remove('streaming');
      var fullText = (data.turn && data.turn.assistantMessage) || vibeChatBubble.textContent;
      vibeChatBubble.innerHTML = renderMessageContent(fullText);
      vibeChatBubble = null;
    }
    var files = data.appliedFiles || [];
    var panel = document.getElementById('vibe-files-panel');
    files.forEach(function (f) {
      var chip = document.createElement('div');
      chip.className = 'file-chip';
      chip.textContent = typeof f === 'string' ? f : (f.filePath || '');
      chip.title = chip.textContent;
      panel.appendChild(chip);
    });
    var msgs = document.getElementById('vibe-messages');
    if (msgs) msgs.scrollTop = msgs.scrollHeight;
  });

  socket.on('vibe:file-changed', function (data) {
    if (data.stepNumber != null) {
      addFileChip('auto-files-panel', data.filePath, data.stepNumber);
    } else {
      addFileChip('vibe-files-panel', data.filePath, null);
    }
  });

  socket.on('vibe:step-complete', function (data) {
    var step = data.step || {};
    var list = document.getElementById('auto-steps-list');
    var item = document.createElement('div');
    item.className = 'auto-step-item';
    var filesCount = (step.filesChanged || []).length;
    var summary = (step.response || '').slice(0, 80) +
      (step.response && step.response.length > 80 ? '…' : '');
    item.innerHTML =
      '<span class="step-number">#' + escHtml(String(step.stepNumber || '?')) + '</span>' +
      '<span class="step-summary">' + escHtml(summary) + '</span>' +
      (filesCount
        ? '<span class="step-files">' + filesCount + ' file' + (filesCount !== 1 ? 's' : '') + '</span>'
        : '');
    list.appendChild(item);
    list.scrollTop = list.scrollHeight;
    document.getElementById('auto-current-output').textContent = '';
  });

  socket.on('vibe:autonomous-status', function (data) {
    setVibeStatus(data.status);
    if (data.status === 'stopped' || data.status === 'completed' || data.status === 'timed-out') {
      document.getElementById('auto-run-btn').disabled = false;
      document.getElementById('auto-stop-btn').classList.add('hidden');
    }
  });

  socket.on('vibe:autonomous-complete', function (data) {
    var steps = (data.steps || []).length;
    showToast('Autonomous run complete! ' + steps + ' step' + (steps !== 1 ? 's' : ''), 'success');
    setVibeStatus('completed');
  });

  socket.on('vibe:hil-request', function (data) {
    showHilModal(data);
    setVibeStatus('waiting-hil');
  });

  socket.on('vibe:error', function (data) {
    if (vibeStreaming && vibeChatBubble) {
      vibeChatBubble.classList.remove('streaming');
      vibeChatBubble.classList.add('error');
      vibeChatBubble = null;
      vibeStreaming = false;
      document.getElementById('vibe-send-btn').disabled = false;
    }
    showToast((data && data.message) || 'Vibe Coder error', 'error');
  });

  // ---- DOM wiring --------------------------------------------

  function initVibeUI() {
    // New session
    document.getElementById('vibe-new-session-btn').addEventListener('click', function () {
      vibeSessionId = null;
      startVibeSession();
    });

    // Tab buttons
    document.querySelectorAll('.vibe-tab-btn').forEach(function (btn) {
      btn.addEventListener('click', function () { switchVibeTab(btn.getAttribute('data-tab')); });
    });

    // Send
    document.getElementById('vibe-send-btn').addEventListener('click', sendVibeChat);
    document.getElementById('vibe-input').addEventListener('keydown', function (e) {
      if (e.ctrlKey && e.key === 'Enter') { e.preventDefault(); sendVibeChat(); }
    });

    // Inject context
    document.getElementById('vibe-context-btn').addEventListener('click', function () {
      if (!vibeSessionId) { showToast('Start a session first', 'error'); return; }
      socket.emit('vibe:inject-context', { sessionId: vibeSessionId });
      showToast('Context injected', 'success');
    });

    // Rules
    document.getElementById('add-rule-btn').addEventListener('click', addAutoRule);
    document.getElementById('new-rule-input').addEventListener('keydown', function (e) {
      if (e.key === 'Enter') { e.preventDefault(); addAutoRule(); }
    });

    // Run / Stop autonomous
    document.getElementById('auto-run-btn').addEventListener('click', runAutonomous);
    document.getElementById('auto-stop-btn').addEventListener('click', function () {
      if (vibeSessionId) socket.emit('vibe:stop-autonomous', { sessionId: vibeSessionId });
    });

    // HIL modal submit
    document.getElementById('hil-submit-btn').addEventListener('click', function () {
      var guidance = document.getElementById('hil-guidance').value.trim();
      if (!guidance) { showToast('Please provide guidance', 'error'); return; }
      if (vibeSessionId) {
        socket.emit('vibe:hil-response', { sessionId: vibeSessionId, guidance: guidance });
      }
      document.getElementById('hil-modal').classList.add('hidden');
      setVibeStatus('running');
    });

    // Dismiss HIL modal on backdrop click
    document.getElementById('hil-modal').addEventListener('click', function (e) {
      if (e.target === this) this.classList.add('hidden');
    });

    // Navigation lifecycle hooks
    var vibeNavLink = document.querySelector('[data-page="vibe-coder"]');
    if (vibeNavLink) {
      vibeNavLink.addEventListener('click', function () {
        vibePageActive = true;
        onVibePageEnter();
      });
    }
    document.querySelectorAll('.nav-item:not([data-page="vibe-coder"])').forEach(function (link) {
      link.addEventListener('click', function () {
        if (vibePageActive) {
          vibePageActive = false;
          onVibePageLeave();
        }
      });
    });
  }

  initVibeUI();

  // ============================================================
  // LIVE DEBUGGER
  // ============================================================

  var dbgActiveModal = { sessionId: null, turnId: null };

  function renderDebuggerDetail(session) {
    currentSessionId = session.id;
    document.querySelector('.main-content').classList.add('debugger-mode');
    showPage('debugger-detail');

    document.getElementById('dbg-session-title').textContent = '🔍 ' + session.name;
    document.getElementById('dbg-session-id-badge').textContent = session.id.slice(0, 8) + '…';
    var statusBadge = document.getElementById('dbg-session-status-badge');
    statusBadge.textContent = session.status;
    var SAFE_STATUSES = { active: true, idle: true, running: true, completed: true, paused: true, stopped: true, error: true };
    statusBadge.className = 'status-pill status-' + (SAFE_STATUSES[session.status] ? session.status : 'idle');

    // Reset subscribe button
    var subBtn = document.getElementById('dbg-subscribe-btn');
    subBtn.textContent = 'Subscribe Live';
    subBtn.disabled = false;
    document.getElementById('dbg-live-dot').classList.add('hidden');

    // Populate log feed
    var logFeed = document.getElementById('dbg-log-feed');
    logFeed.innerHTML = '';
    (session.turns || []).forEach(function (turn) {
      var meta = turn.debuggerMeta || {};
      (meta.matchedLogLines || []).forEach(function (line) {
        logFeed.appendChild(makeDbgLogLine(line, null, true));
      });
    });

    // Populate analysis cards (newest first)
    var analysisList = document.getElementById('dbg-analysis-list');
    analysisList.innerHTML = '';
    var turns = (session.turns || []).slice().reverse();
    if (turns.length === 0) {
      analysisList.innerHTML = '<div class="loading">No analysis yet</div>';
    } else {
      turns.forEach(function (turn, idx) {
        analysisList.appendChild(makeAnalysisCard(turn, turns.length - idx, session.id));
      });
    }

    // Populate info panel
    document.getElementById('dbg-info-panel').innerHTML = renderDbgInfoPanel(session);

    // Subscribe to session-level updates
    socket.emit('subscribe:session', session.id);
  }

  function makeDbgLogLine(line, timestamp, isMatched) {
    var div = document.createElement('div');
    div.className = 'dbg-log-line' + (isMatched ? ' log-matched' : '');
    var html = '';
    if (timestamp) {
      html += '<span class="log-ts">' + escHtml(new Date(timestamp).toLocaleTimeString()) + '</span>';
    }
    html += escHtml(line);
    div.innerHTML = html;
    return div;
  }

  function makeAnalysisCard(turn, number, sessionId) {
    var meta = turn.debuggerMeta || {};
    var card = document.createElement('div');
    card.className = 'analysis-card';
    card.setAttribute('data-turn-id', turn.id);

    var promptSentAt = meta.promptSentAt ? new Date(meta.promptSentAt).toLocaleString() : '—';
    var duration = '';
    if (meta.promptSentAt && meta.responseReceivedAt) {
      duration = (new Date(meta.responseReceivedAt) - new Date(meta.promptSentAt)) + 'ms';
    }

    var headerHtml =
      '<div class="analysis-header">' +
        '<div class="analysis-header-left">' +
          '<span>Analysis #' + escHtml(String(number)) + '</span>' +
          '<span class="analysis-timestamp">' + escHtml(promptSentAt) + '</span>' +
          (duration ? '<span class="analysis-duration">' + escHtml(duration) + '</span>' : '') +
        '</div>' +
        '<button class="analysis-prompt-toggle">▶ Prompt</button>' +
      '</div>';

    var promptHtml =
      '<div class="analysis-prompt">' + escHtml(turn.userMessage || '') + '</div>';

    var bodyHtml =
      '<div class="analysis-body">' + renderMessageContent(turn.assistantMessage || '') + '</div>';

    var footerBadges = '';
    if (meta.notificationSent) footerBadges += '<span class="badge-notified">🔔 Notified</span>';
    if (meta.fixApplied) footerBadges += '<span class="badge-fix-applied">🔧 Fix Applied</span>';
    if (meta.jiraKey) {
      footerBadges += '<a href="#" class="badge-jira">🎫 ' + escHtml(meta.jiraKey) + '</a>';
    }
    if (meta.gitFixUrl) {
      footerBadges += '<a href="' + escHtml(meta.gitFixUrl) + '" target="_blank" rel="noopener noreferrer" class="badge-git">🔗 Git Fix</a>';
    }

    var footerHtml =
      '<div class="analysis-footer">' +
        footerBadges +
        '<button class="dbg-action-btn dbg-jira-btn">🎫 Create Jira Ticket</button>' +
        '<button class="dbg-action-btn dbg-git-btn">⚙ Apply Git Fix</button>' +
      '</div>';

    card.innerHTML = headerHtml + promptHtml + bodyHtml + footerHtml;

    card.querySelector('.analysis-prompt-toggle').addEventListener('click', function () {
      card.classList.toggle('expanded');
      this.textContent = card.classList.contains('expanded') ? '▼ Prompt' : '▶ Prompt';
    });

    card.querySelector('.dbg-jira-btn').addEventListener('click', function () {
      openJiraModal(sessionId, turn.id, turn.assistantMessage || '');
    });

    card.querySelector('.dbg-git-btn').addEventListener('click', function () {
      openGitModal(sessionId, turn.id);
    });

    return card;
  }

  function renderDbgInfoPanel(session) {
    var guardrails = (session.config && session.config.guardrails) || [];
    var html =
      '<div class="section-label dbg-panel-label">Session Info</div>' +
      '<div style="padding:10px 0">' +
        '<div class="dbg-info-section">' +
          '<div class="dbg-info-row"><strong>ID:</strong> ' + escHtml(session.id) + '</div>' +
          '<div class="dbg-info-row"><strong>Status:</strong> ' + escHtml(session.status) + '</div>' +
          '<div class="dbg-info-row"><strong>Provider:</strong> ' + escHtml((session.config && session.config.provider) || '—') + '</div>' +
          '<div class="dbg-info-row"><strong>Model:</strong> ' + escHtml((session.config && session.config.model) || 'default') + '</div>' +
          '<div class="dbg-info-row"><strong>Created:</strong> ' + escHtml(new Date(session.createdAt).toLocaleString()) + '</div>' +
          '<div class="dbg-info-row"><strong>Updated:</strong> ' + escHtml(new Date(session.updatedAt).toLocaleString()) + '</div>' +
        '</div>';

    if (guardrails.length) {
      html +=
        '<div class="dbg-info-section">' +
          '<div class="section-label">Guardrails (' + guardrails.length + ')</div>' +
          guardrails.map(function (g) {
            return '<div class="guardrail-item">' +
              '<div class="guardrail-type">' + escHtml(g.type || '') + '</div>' +
              escHtml(g.description || '') +
            '</div>';
          }).join('') +
        '</div>';
    }

    html += '</div>';
    return html;
  }

  function openJiraModal(sessionId, turnId, analysisText) {
    dbgActiveModal.sessionId = sessionId;
    dbgActiveModal.turnId = turnId;
    var firstLine = (analysisText || '').split('\n')[0].replace(/^#+\s*/, '').slice(0, 120);
    document.getElementById('jira-summary').value = firstLine;
    document.getElementById('jira-modal').classList.remove('hidden');
  }

  function openGitModal(sessionId, turnId) {
    dbgActiveModal.sessionId = sessionId;
    dbgActiveModal.turnId = turnId;
    document.getElementById('git-modal').classList.remove('hidden');
  }

  function updateCardJira(turnId, jiraKey) {
    var card = document.querySelector('.analysis-card[data-turn-id="' + turnId + '"]');
    if (!card) return;
    var footer = card.querySelector('.analysis-footer');
    if (!footer) return;
    var existing = footer.querySelector('.badge-jira');
    if (existing) existing.remove();
    var badge = document.createElement('a');
    badge.href = '#';
    badge.className = 'badge-jira';
    badge.textContent = '🎫 ' + jiraKey;
    footer.insertBefore(badge, footer.firstChild);
  }

  function updateCardGit(turnId, gitUrl) {
    var card = document.querySelector('.analysis-card[data-turn-id="' + turnId + '"]');
    if (!card) return;
    var footer = card.querySelector('.analysis-footer');
    if (!footer) return;
    var existing = footer.querySelector('.badge-git');
    if (existing) existing.remove();
    var badge = document.createElement('a');
    badge.href = gitUrl || '#';
    badge.className = 'badge-git';
    badge.target = '_blank';
    badge.rel = 'noopener noreferrer';
    badge.textContent = '🔗 Git Fix';
    footer.insertBefore(badge, footer.firstChild);
  }

  // Real-time debugger socket events
  socket.on('debugger:log', function (data) {
    var feed = document.getElementById('dbg-log-feed');
    if (!feed || data.sessionId !== currentSessionId) return;
    var line = makeDbgLogLine(data.line || '', data.timestamp || null, false);
    line.style.opacity = '0';
    line.style.transition = 'opacity 0.2s';
    feed.appendChild(line);
    setTimeout(function () { line.style.opacity = '1'; }, 10);
    feed.scrollTop = feed.scrollHeight;
  });

  socket.on('debugger:analysis', function (data) {
    var list = document.getElementById('dbg-analysis-list');
    if (!list || data.sessionId !== currentSessionId) return;
    var pseudoTurn = {
      id: 'rt-' + Date.now(),
      userMessage: data.prompt || '',
      assistantMessage: data.analysis || '',
      debuggerMeta: data.meta || {},
    };
    var emptyMsg = list.querySelector('.loading');
    if (emptyMsg) emptyMsg.remove();
    var existingCount = list.querySelectorAll('.analysis-card').length;
    var card = makeAnalysisCard(pseudoTurn, existingCount + 1, currentSessionId);
    card.style.opacity = '0';
    card.style.transition = 'opacity 0.3s';
    list.insertBefore(card, list.firstChild);
    setTimeout(function () { card.style.opacity = '1'; }, 10);
    // Also append matched log lines to feed
    var feed = document.getElementById('dbg-log-feed');
    if (feed && data.meta && data.meta.matchedLogLines) {
      data.meta.matchedLogLines.forEach(function (line) {
        feed.appendChild(makeDbgLogLine(line, null, true));
      });
      feed.scrollTop = feed.scrollHeight;
    }
  });

  socket.on('debugger:error', function (data) {
    if (data.sessionId !== currentSessionId) return;
    showToast((data.message || 'Debugger error'), 'error');
  });

  function initDebuggerUI() {
    // Back button
    document.getElementById('dbg-back-btn').addEventListener('click', function () {
      if (currentSessionId) {
        socket.emit('unsubscribe:session', currentSessionId);
        socket.emit('unsubscribe:debugger', currentSessionId);
      }
      currentSessionId = null;
      document.querySelector('.main-content').classList.remove('debugger-mode');
      showPage('sessions');
      loadSessions();
    });

    // Subscribe Live button
    document.getElementById('dbg-subscribe-btn').addEventListener('click', function () {
      if (!currentSessionId) return;
      socket.emit('subscribe:debugger', currentSessionId);
      this.textContent = '● Live';
      this.disabled = true;
      document.getElementById('dbg-live-dot').classList.remove('hidden');
    });

    // Remove debugger-mode when navigating via sidebar
    document.querySelectorAll('.nav-item').forEach(function (link) {
      link.addEventListener('click', function () {
        document.querySelector('.main-content').classList.remove('debugger-mode');
      });
    });

    // Jira modal
    document.getElementById('jira-modal-close').addEventListener('click', function () {
      document.getElementById('jira-modal').classList.add('hidden');
    });
    document.getElementById('jira-cancel-btn').addEventListener('click', function () {
      document.getElementById('jira-modal').classList.add('hidden');
    });
    document.getElementById('jira-modal').addEventListener('click', function (e) {
      if (e.target === this) this.classList.add('hidden');
    });

    document.getElementById('jira-submit-btn').addEventListener('click', function () {
      var sessionId = dbgActiveModal.sessionId;
      var turnId = dbgActiveModal.turnId;
      if (!sessionId) return;

      var jiraConfig = {
        baseUrl: document.getElementById('jira-base-url').value.trim(),
        email: document.getElementById('jira-email').value.trim(),
        apiToken: document.getElementById('jira-api-token').value.trim(),
        projectKey: document.getElementById('jira-project-key').value.trim(),
        issueType: document.getElementById('jira-issue-type').value.trim() || 'Bug',
      };
      var labelsVal = document.getElementById('jira-labels').value.trim();
      if (labelsVal) {
        jiraConfig.labels = labelsVal.split(',').map(function (l) { return l.trim(); }).filter(Boolean);
      }

      var body = {
        jiraConfig: jiraConfig,
        summary: document.getElementById('jira-summary').value.trim(),
        priority: document.getElementById('jira-priority').value,
      };
      if (turnId) body.turnId = turnId;

      fetch('/api/debugger/' + sessionId + '/jira', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      })
        .then(function (r) { return r.json(); })
        .then(function (data) {
          document.getElementById('jira-modal').classList.add('hidden');
          showToast('Jira ticket created' + (data.key ? ': ' + data.key : ''), 'success');
          if (data.key && turnId) updateCardJira(turnId, data.key);
        })
        .catch(function (err) { showToast('Error: ' + err.message, 'error'); });
    });

    // Git modal
    document.getElementById('git-modal-close').addEventListener('click', function () {
      document.getElementById('git-modal').classList.add('hidden');
    });
    document.getElementById('git-cancel-btn').addEventListener('click', function () {
      document.getElementById('git-modal').classList.add('hidden');
    });
    document.getElementById('git-modal').addEventListener('click', function (e) {
      if (e.target === this) this.classList.add('hidden');
    });

    document.getElementById('git-submit-btn').addEventListener('click', function () {
      var sessionId = dbgActiveModal.sessionId;
      var turnId = dbgActiveModal.turnId;
      if (!sessionId) return;

      var gitConfig = {
        repoPath: document.getElementById('git-repo-path').value.trim(),
      };
      var token = document.getElementById('git-token').value.trim();
      if (token) gitConfig.token = token;
      var remoteUrl = document.getElementById('git-remote-url').value.trim();
      if (remoteUrl) gitConfig.remoteUrl = remoteUrl;
      var branch = document.getElementById('git-branch').value.trim();
      if (branch) gitConfig.branch = branch;
      var apiBaseUrl = document.getElementById('git-api-base-url').value.trim();
      if (apiBaseUrl) gitConfig.apiBaseUrl = apiBaseUrl;
      var guardrailsText = document.getElementById('git-guardrails').value.trim();
      if (guardrailsText) {
        gitConfig.guardrails = guardrailsText.split('\n').map(function (l) { return l.trim(); }).filter(Boolean);
      }

      var body = { gitConfig: gitConfig };
      var commitMsg = document.getElementById('git-commit-message').value.trim();
      if (commitMsg) body.commitMessage = commitMsg;
      var prTitle = document.getElementById('git-pr-title').value.trim();
      if (prTitle) body.prTitle = prTitle;
      var baseBranch = document.getElementById('git-base-branch').value.trim();
      if (baseBranch) body.baseBranch = baseBranch;
      if (turnId) body.turnId = turnId;

      fetch('/api/debugger/' + sessionId + '/git-fix', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      })
        .then(function (r) { return r.json(); })
        .then(function (data) {
          document.getElementById('git-modal').classList.add('hidden');
          var url = data.pullRequestUrl || data.commitSha || '';
          showToast('Git fix applied' + (url ? ': ' + url : ''), 'success');
          if (turnId) updateCardGit(turnId, url);
        })
        .catch(function (err) { showToast('Error: ' + err.message, 'error'); });
    });
  }

  initDebuggerUI();
})();
