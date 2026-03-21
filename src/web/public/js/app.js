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
        '<div class="session-name">' + escHtml(s.name) + '</div>' +
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
})();
