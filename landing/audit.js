/* ============================================================
   CERBERUS-X — Local Audit Console Logic
   Live backend wiring (/api/state, /api/pipeline, /api/upload, DELETE /api/files/<name>, /api/query)
   Default Semantic Offline PyVis Evidence Graph & Uploaded Files Manager
   ============================================================ */

(function () {
  'use strict';

  function esc(str) {
    return String(str == null ? '' : str)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  function formatBytes(bytes) {
    var val = Number(bytes) || 0;
    if (val < 1024) return val.toFixed(1) + ' B';
    if (val < 1024 * 1024) return (val / 1024).toFixed(1) + ' KB';
    return (val / (1024 * 1024)).toFixed(1) + ' MB';
  }

  function middleTruncate(name, maxLen) {
    var text = String(name || '');
    if (text.length <= maxLen) return text;
    var keep = maxLen - 3;
    var head = Math.ceil(keep * 0.58);
    var tail = Math.floor(keep * 0.42);
    return text.slice(0, head) + '...' + text.slice(text.length - tail);
  }

  function fileTypeIconSvg(ext) {
    var code = String(ext || '').toUpperCase();
    if (code === 'CSV' || code === 'PARQUET' || code === 'TSV') {
      return (
        '<svg viewBox="0 0 24 24" aria-hidden="true">' +
        '<rect x="3" y="3" width="18" height="18" rx="1"/>' +
        '<line x1="3" y1="9" x2="21" y2="9"/>' +
        '<line x1="3" y1="15" x2="21" y2="15"/>' +
        '<line x1="9" y1="3" x2="9" y2="21"/>' +
        '</svg>'
      );
    }
    if (code === 'PNG' || code === 'JPG' || code === 'JPEG' || code === 'WEBP' || code === 'BMP') {
      return (
        '<svg viewBox="0 0 24 24" aria-hidden="true">' +
        '<rect x="3" y="3" width="18" height="18" rx="1"/>' +
        '<circle cx="8.5" cy="8.5" r="1.5"/>' +
        '<polyline points="21 15 16 10 5 21"/>' +
        '</svg>'
      );
    }
    return (
      '<svg viewBox="0 0 24 24" aria-hidden="true">' +
      '<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/>' +
      '<polyline points="14 2 14 8 20 8"/>' +
      '</svg>'
    );
  }

  var state = {
    selectedDataset: 'synthetic_traps',
    indexedDataset: 'synthetic_traps',
    needsReindex: false,
    presets: [],
    lastResult: null,
    activeGraphHtml: ''
  };

  /* DOM refs */
  var elStatDataset = document.getElementById('statDataset');
  var elStatTotal = document.getElementById('statTotal');
  var elStatClean = document.getElementById('statClean');
  var elStatQuarantined = document.getElementById('statQuarantined');
  var elStatOllama = document.getElementById('statOllama');
  var elRawCount = document.getElementById('rawFileCount');

  var btnTraps = document.getElementById('btnCorpusTraps');
  var btnRaw = document.getElementById('btnCorpusRaw');
  var uploadZone = document.getElementById('uploadZone');
  var fileUploadInput = document.getElementById('fileUploadInput');
  var uploadedFilesList = document.getElementById('uploadedFilesList');
  var uploadedBoxCount = document.getElementById('uploadedBoxCount');
  var addMoreFilesBtn = document.getElementById('addMoreFilesBtn');
  var uploadFeedback = document.getElementById('uploadFeedback');
  var reindexNotice = document.getElementById('reindexNotice');

  var ollamaBadge = document.getElementById('ollamaBadge');
  var llmModelName = document.getElementById('llmModelName');
  var useLlmToggle = document.getElementById('useLlmToggle');
  var runPipelineBtn = document.getElementById('runPipelineBtn');
  var runPipelineText = document.getElementById('runPipelineText');
  var pipelineFeedback = document.getElementById('pipelineFeedback');
  var securityList = document.getElementById('securityList');

  var presetBar = document.getElementById('presetBar');
  var queryForm = document.getElementById('queryForm');
  var queryInput = document.getElementById('queryInput');
  var analyzeBtn = document.getElementById('analyzeBtn');
  var analyzeText = document.getElementById('analyzeText');

  var verdictBadge = document.getElementById('verdictBadge');
  var verdictAnswer = document.getElementById('verdictAnswer');
  var verdictCites = document.getElementById('verdictCites');
  var verdictQNote = document.getElementById('verdictQNote');
  var confGateTag = document.getElementById('confGateTag');
  var confPctNum = document.getElementById('confPctNum');
  var confMeterFill = document.getElementById('confMeterFill');
  var confMeterDot = document.getElementById('confMeterDot');

  var countConflicts = document.getElementById('countConflicts');
  var countVisual = document.getElementById('countVisual');
  var trustedSourcesList = document.getElementById('trustedSourcesList');
  var conflictsList = document.getElementById('conflictsList');
  var quarantinedSection = document.getElementById('quarantinedSection');
  var quarantinedList = document.getElementById('quarantinedList');
  var visualProofGrid = document.getElementById('visualProofGrid');

  var showFullGraphToggle = document.getElementById('showFullGraphToggle');
  var evidenceGraphFrame = document.getElementById('evidenceGraphFrame');
  var rawJsonPre = document.getElementById('rawJsonPre');
  var copyJsonBtn = document.getElementById('copyJsonBtn');

  var execVeil = document.getElementById('execVeil');
  var execModeLabel = document.getElementById('execModeLabel');
  var execTimer = document.getElementById('execTimer');
  var execStageTitle = document.getElementById('execStageTitle');
  var execStageDetail = document.getElementById('execStageDetail');
  var execStepEls = document.querySelectorAll('.exec-step');

  var veilTimerId = null;
  var veilPollId = null;
  var veilShownAt = 0;

  function setVeilStep(activeStep) {
    execStepEls.forEach(function (el) {
      var n = Number(el.getAttribute('data-exec-step') || 0);
      el.classList.toggle('is-active', n === activeStep);
      el.classList.toggle('is-done', activeStep > 0 && n < activeStep);
    });
  }

  function showExecutionVeil(opts) {
    if (!execVeil) return;
    var mode = (opts && opts.mode) || 'pipeline';
    var startMs = performance.now();
    veilShownAt = startMs;

    if (execModeLabel) {
      execModeLabel.textContent = mode === 'pipeline' ? 'Running Offline Pipeline' : 'Verifying Audit Query';
    }
    if (execStageTitle) {
      execStageTitle.innerHTML = mode === 'pipeline'
        ? 'Auditing <span class="font-serif-accent">evidence</span> pipeline'
        : 'Tracing <span class="font-serif-accent">verified</span> subgraph';
    }
    if (execStageDetail) {
      execStageDetail.textContent = (opts && opts.detail) || (
        mode === 'pipeline'
          ? 'SHA-256 · Pre-LLM forensics · Entity resolution · NetworkX trust propagation'
          : '2-hop BFS graph lookup · Conflict evaluation · Deterministic 65% gate'
      );
    }
    if (execTimer) execTimer.textContent = '00.0s';
    setVeilStep(mode === 'pipeline' ? 1 : 3);

    execVeil.hidden = false;
    requestAnimationFrame(function () {
      execVeil.classList.add('is-active');
    });

    if (veilTimerId) clearInterval(veilTimerId);
    veilTimerId = setInterval(function () {
      var secs = ((performance.now() - startMs) / 1000).toFixed(1).padStart(4, '0');
      if (execTimer) execTimer.textContent = secs + 's';
    }, 100);

    if (veilPollId) clearInterval(veilPollId);
    if (mode === 'pipeline') {
      veilPollId = setInterval(async function () {
        try {
          var p = await apiJson('/api/progress');
          if (p && p.active && p.stage) {
            setVeilStep(p.stage);
            if (execStageDetail && p.detail) execStageDetail.textContent = p.detail;
            if (execStageTitle && p.title) {
              var words = String(p.title).split(' ');
              if (words.length >= 2) {
                execStageTitle.innerHTML = esc(words[0]) + ' <span class="font-serif-accent">' + esc(words[1]) + '</span> ' + esc(words.slice(2).join(' '));
              } else {
                execStageTitle.textContent = p.title;
              }
            }
          }
        } catch (_e) { /* ignore transient poll errors */ }
      }, 320);
    }
  }

  async function hideExecutionVeil() {
    if (veilTimerId) {
      clearInterval(veilTimerId);
      veilTimerId = null;
    }
    if (veilPollId) {
      clearInterval(veilPollId);
      veilPollId = null;
    }
    if (!execVeil || execVeil.hidden) return;

    var minVisibleMs = 340;
    var elapsed = performance.now() - veilShownAt;
    if (elapsed < minVisibleMs) {
      await new Promise(function (resolve) { setTimeout(resolve, minVisibleMs - elapsed); });
    }

    execVeil.classList.remove('is-active');
    setTimeout(function () {
      if (execVeil && !execVeil.classList.contains('is-active')) {
        execVeil.hidden = true;
      }
    }, 280);
  }

  async function apiJson(url, options) {
    var resp = await fetch(url, options || {});
    var data = await resp.json();
    if (!resp.ok) {
      throw new Error(data.error || ('Request failed: ' + resp.status));
    }
    return data;
  }

  function updateReindexNotice() {
    var mismatch = state.selectedDataset !== state.indexedDataset;
    var show = mismatch || Boolean(state.needsReindex);
    if (reindexNotice) {
      reindexNotice.hidden = !show;
    }
  }

  function renderUploadedFiles(files) {
    var list = Array.isArray(files) ? files : [];
    elRawCount.textContent = String(list.length);
    if (uploadedBoxCount) {
      uploadedBoxCount.textContent = String(list.length);
    }

    if (!list.length) {
      uploadedFilesList.innerHTML = '<div class="uploaded-files-empty">No uploaded files in data/raw/</div>';
      return;
    }

    uploadedFilesList.innerHTML = list.map(function (item) {
      var fname = String(item.name || '');
      var display = middleTruncate(fname, 28);
      var sizeLabel = formatBytes(item.size_bytes);
      var extLabel = String(item.ext || '').toUpperCase();
      return (
        '<div class="uploaded-file-row" data-filename="' + esc(fname) + '">' +
        '<span class="uploaded-file-row__icon">' + fileTypeIconSvg(extLabel) + '</span>' +
        '<div class="uploaded-file-row__meta">' +
        '<span class="uploaded-file-row__name" title="' + esc(fname) + '">' + esc(display) + '</span>' +
        '<span class="uploaded-file-row__size">' + esc(sizeLabel) + '</span>' +
        '</div>' +
        '<button type="button" class="uploaded-file-row__remove" data-remove-file="' + esc(fname) + '" aria-label="Remove ' + esc(fname) + '" title="Remove ' + esc(fname) + '">&times;</button>' +
        '</div>'
      );
    }).join('');

    uploadedFilesList.querySelectorAll('.uploaded-file-row__remove').forEach(function (btn) {
      btn.addEventListener('click', function () {
        var name = btn.getAttribute('data-remove-file');
        if (name) removeUploadedFile(name, btn);
      });
    });
  }

  function renderState(data, preserveSelection) {
    state.presets = data.presets || [];
    state.indexedDataset = data.indexed_dataset || 'synthetic_traps';
    if (!preserveSelection) {
      state.selectedDataset = data.selected_dataset || state.indexedDataset || 'synthetic_traps';
    }
    state.needsReindex = Boolean(data.needs_reindex);

    btnTraps.classList.toggle('is-active', state.selectedDataset === 'synthetic_traps');
    btnRaw.classList.toggle('is-active', state.selectedDataset === 'data/raw');

    elStatDataset.textContent = data.corpus_label || 'Not indexed';
    elStatTotal.textContent = String(data.total_files || 0);
    elStatClean.textContent = String(data.clean_count || 0);
    elStatQuarantined.textContent = String(data.quarantined_count || 0);

    llmModelName.textContent = data.llm_model || 'qwen2.5:3b';
    if (data.ollama_ready) {
      elStatOllama.textContent = 'Ollama (' + (data.llm_model || 'qwen2.5:3b') + ')';
      ollamaBadge.textContent = 'OLLAMA: ' + String(data.llm_model || 'QWEN2.5:3B').toUpperCase() + ' READY';
      ollamaBadge.classList.add('is-ready');
      useLlmToggle.disabled = false;
    } else {
      elStatOllama.textContent = 'Deterministic Offline';
      ollamaBadge.textContent = 'DETERMINISTIC OFFLINE (NO OLLAMA)';
      ollamaBadge.classList.remove('is-ready');
      useLlmToggle.checked = false;
      useLlmToggle.disabled = true;
    }

    renderUploadedFiles(data.raw_files || []);
    renderSecurityChecks(data.docs || []);
    renderPresets(state.presets);
    updateReindexNotice();
  }

  function renderSecurityChecks(docs) {
    if (!docs.length) {
      securityList.innerHTML = '<div class="empty-note">No ingested documents yet. Click Run Offline Pipeline.</div>';
      return;
    }

    securityList.innerHTML = docs.map(function (doc) {
      var flagsHtml = (doc.flags || []).map(function (f) {
        var label = f.display + (f.count > 1 ? ' (' + f.count + ')' : '');
        return '<span class="security-chip">' + esc(label) + '</span>';
      }).join('');
      if (!flagsHtml) {
        flagsHtml = '<span class="security-chip">No flags</span>';
      }

      var statusCls = doc.quarantined ? 'status-chip status-chip--solid' : 'status-chip status-chip--outline';
      var statusLabel = doc.quarantined ? 'QUARANTINED' : 'CLEAN';
      var cardCls = doc.quarantined ? 'security-card is-quarantined' : 'security-card';

      return (
        '<div class="' + cardCls + '">' +
        '<div class="security-card__row1">' +
        '<span class="security-card__name">' + esc(doc.file_name) + '</span>' +
        '<span class="security-card__prior">' + Number(doc.trust_prior).toFixed(2) + '</span>' +
        '</div>' +
        '<div class="security-card__row2">' +
        '<span class="' + statusCls + '">' + statusLabel + '</span>' +
        '<span class="security-chip">' + esc(doc.modality) + '</span>' +
        flagsHtml +
        '</div>' +
        '</div>'
      );
    }).join('');
  }

  function renderPresets(presets) {
    if (!presets.length) return;
    var currentQ = queryInput.value.trim();
    presetBar.innerHTML = presets.map(function (p) {
      var isActive = currentQ === p.query.trim();
      return (
        '<button type="button" class="preset-btn' + (isActive ? ' is-active' : '') + '" ' +
        'data-query="' + esc(p.query) + '" title="' + esc(p.query) + '">' +
        esc(p.label) +
        '</button>'
      );
    }).join('');

    presetBar.querySelectorAll('.preset-btn').forEach(function (btn) {
      btn.addEventListener('click', function () {
        queryInput.value = btn.getAttribute('data-query') || '';
        runQuery();
      });
    });
  }

  function updateConfidenceMeter(pct, status) {
    var clamped = Math.max(0, Math.min(100, Number(pct) || 0));
    confPctNum.textContent = clamped + '%';

    if (status === 'TAMPER_DETECTED') {
      confGateTag.textContent = 'BLOCKED PRE-LLM';
      confGateTag.className = 'conf-head__tag conf-head__tag--solid';
    } else if (clamped >= 65) {
      confGateTag.textContent = 'PASS >= 65%';
      confGateTag.className = 'conf-head__tag conf-head__tag--solid';
    } else {
      confGateTag.textContent = 'BELOW 65% GATE';
      confGateTag.className = 'conf-head__tag';
    }

    confMeterFill.style.width = clamped + '%';
    confMeterDot.style.left = clamped + '%';
  }

  function syncGraphIframe() {
    if (evidenceGraphFrame && state.activeGraphHtml) {
      evidenceGraphFrame.srcdoc = state.activeGraphHtml;
    }
  }

  function renderVerdictResult(res) {
    state.lastResult = res;

    verdictBadge.textContent = res.status;
    verdictBadge.className = 'verdict-status-badge ' + (
      (res.status === 'VERIFIED' || res.status === 'CONFLICT_RESOLVED')
        ? 'verdict-status-badge--solid'
        : 'verdict-status-badge--outline'
    );

    verdictAnswer.textContent = res.answer;

    verdictCites.innerHTML = (res.citations || []).map(function (c) {
      return '<span class="cite-pill">[' + c.index + '] ' + esc(c.file_name) + ' &middot; ' + esc(c.location) + '</span>';
    }).join('');

    var qFiles = (res.quarantined_sources || []).map(function (s) { return s.file_name; });
    verdictQNote.textContent = qFiles.length
      ? 'Pre-LLM forensics quarantined untrusted file(s): ' + qFiles.join(', ')
      : '';

    updateConfidenceMeter(res.confidence_pct, res.status);

    countConflicts.textContent = String((res.counts && res.counts.conflicts_citations) || 0);
    countVisual.textContent = String((res.counts && res.counts.visual_proof) || 0);

    var cits = res.citations || [];
    trustedSourcesList.innerHTML = cits.length
      ? cits.map(function (c) {
        return (
          '<div class="ev-card">' +
          '<div class="ev-card__head">' +
          '<span class="ev-card__title">[' + c.index + '] ' + esc(c.file_name) + '</span>' +
          '<span class="security-chip">' + esc(c.location) + '</span>' +
          '</div>' +
          '<p class="ev-card__quote">' + esc(c.quote) + '</p>' +
          '</div>'
        );
      }).join('')
      : '<div class="empty-note">No clean corroborating citations for this verdict.</div>';

    var conflicts = res.conflicts || [];
    conflictsList.innerHTML = conflicts.length
      ? conflicts.map(function (e) {
        var badgeCls = e.edge_type === 'CONTRADICTS'
          ? 'status-chip status-chip--solid'
          : (e.edge_type === 'SUPERSEDES' ? 'status-chip status-chip--outline' : 'security-chip');
        return (
          '<div class="ev-card">' +
          '<div class="ev-card__head">' +
          '<span class="' + badgeCls + '">' + esc(e.display_type) + '</span>' +
          '<div class="ev-card__meta-group">' +
          '<span class="security-chip">' + esc(e.detector) + '</span>' +
          '<span class="security-chip">conf ' + Number(e.confidence).toFixed(2) + '</span>' +
          '</div>' +
          '</div>' +
          '<p class="ev-card__reason">' + esc(e.reason) + '</p>' +
          '</div>'
        );
      }).join('')
      : '<div class="empty-note">' + (
        (res.status === 'TAMPER_DETECTED' || !cits.length)
          ? 'Blocked before comparison — no trusted sources available.'
          : 'All trusted sources agree — no conflicts or updates found.'
      ) + '</div>';

    var qSources = res.quarantined_sources || [];
    if (qSources.length) {
      quarantinedSection.style.display = 'block';
      quarantinedList.innerHTML = qSources.map(function (s) {
        var badges = (s.flags || []).map(function (f) {
          return '<span class="security-chip">' + esc(f.display + (f.count > 1 ? ' (' + f.count + ')' : '')) + '</span>';
        }).join('');
        return (
          '<div class="ev-card ev-card--quarantined">' +
          '<div class="ev-card__head">' +
          '<span class="ev-card__title">' + esc(s.file_name) + '</span>' +
          '<div class="ev-card__meta-group">' +
          '<span class="security-chip">' + esc(s.modality) + '</span>' +
          '<span class="security-chip">trust ' + Number(s.trust_prior).toFixed(2) + '</span>' +
          '</div>' +
          '</div>' +
          '<div class="ev-card__meta-group" style="margin-bottom:8px;">' +
          '<span class="status-chip status-chip--solid">' + esc(s.top_severity) + '</span>' +
          badges +
          '</div>' +
          '<p class="ev-card__reason">' + esc(s.summary_line) + '</p>' +
          '</div>'
        );
      }).join('');
    } else {
      quarantinedSection.style.display = 'none';
    }

    renderVisualProofs(res.visual_proofs || []);

    state.activeGraphHtml = res.graph_html || '';
    if (!document.getElementById('paneGraph').hidden) {
      syncGraphIframe();
    }

    rawJsonPre.textContent = JSON.stringify(res.raw_json || res, null, 2);
    renderPresets(state.presets);
  }

  function renderVisualProofs(proofs) {
    if (!proofs.length) {
      visualProofGrid.innerHTML = '<div class="empty-note">No visual or tabular proof artifacts matched this query.</div>';
      return;
    }

    visualProofGrid.innerHTML = proofs.map(function (p) {
      var qTag = p.quarantined ? '<span class="status-chip status-chip--solid">QUARANTINED</span>' : '<span class="status-chip status-chip--outline">CITED PROOF</span>';
      if (p.kind === 'table') {
        var headers = (p.columns || []).map(function (c) { return '<th>' + esc(c) + '</th>'; }).join('');
        var rowsHtml = (p.rows || []).map(function (row, rIdx) {
          var cls = rIdx === p.highlight_row ? ' class="is-highlight"' : '';
          var cells = row.map(function (val) { return '<td>' + esc(val) + '</td>'; }).join('');
          return '<tr' + cls + '>' + cells + '</tr>';
        }).join('');
        return (
          '<article class="proof-card proof-card--full">' +
          '<div class="proof-card__head">' +
          '<div><span class="proof-card__title">' + esc(p.file_name) + '</span> <span class="security-chip">' + esc(p.location) + '</span></div>' +
          qTag +
          '</div>' +
          '<div class="proof-table-wrap"><table class="proof-table"><thead><tr>' + headers + '</tr></thead><tbody>' + rowsHtml + '</tbody></table></div>' +
          '</article>'
        );
      }

      return (
        '<article class="proof-card">' +
        '<div class="proof-card__head">' +
        '<div><span class="proof-card__title">' + esc(p.file_name) + '</span> <span class="security-chip">' + esc(p.location) + '</span></div>' +
        qTag +
        '</div>' +
        '<img class="proof-card__img" src="' + esc(p.data_uri) + '" alt="Visual proof from ' + esc(p.file_name) + '">' +
        '</article>'
      );
    }).join('');
  }

  /* ==========================================================
     FILE UPLOAD, DELETE & PIPELINE ACTIONS
     ========================================================== */
  async function handleFileUploadList(fileList) {
    var files = Array.from(fileList || []);
    if (!files.length) return;
    uploadFeedback.textContent = 'Saving ' + files.length + ' file(s) to data/raw...';

    try {
      var encodedFiles = await Promise.all(files.map(function (file) {
        return new Promise(function (resolve, reject) {
          var reader = new FileReader();
          reader.onload = function () {
            resolve({ name: file.name, content_b64: String(reader.result || '') });
          };
          reader.onerror = function () { reject(new Error('Failed to read ' + file.name)); };
          reader.readAsDataURL(file);
        });
      }));

      // Automatically switch selected folder to data/raw when user uploads documents
      state.selectedDataset = 'data/raw';
      var res = await apiJson('/api/upload', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          files: encodedFiles,
          selected_dataset: state.selectedDataset
        })
      });

      uploadFeedback.textContent = 'Saved ' + (res.saved ? res.saved.length : 0) + ' file(s) to data/raw.';
      fileUploadInput.value = '';
      renderState(res.state, true);
    } catch (err) {
      uploadFeedback.textContent = 'Upload failed: ' + err.message;
    }
  }

  async function removeUploadedFile(fileName, btnEl) {
    if (btnEl) btnEl.disabled = true;
    try {
      var res = await apiJson(
        '/api/files/' + encodeURIComponent(fileName) + '?selected=' + encodeURIComponent(state.selectedDataset),
        { method: 'DELETE' }
      );
      uploadFeedback.textContent = 'Removed ' + res.deleted + ' from data/raw. Stored: ' + res.raw_file_count + ' file(s).';
      renderState(res.state, true);
    } catch (err) {
      uploadFeedback.textContent = 'Delete failed: ' + err.message;
      if (btnEl) btnEl.disabled = false;
    }
  }

  async function runQuery(withVeil) {
    var q = queryInput.value.trim();
    if (!q) return;
    analyzeBtn.disabled = true;
    analyzeText.textContent = 'Analyzing...';

    var showVeil = withVeil !== false;
    if (showVeil) {
      showExecutionVeil({
        mode: 'query',
        detail: useLlmToggle.checked
          ? 'Evaluating 2-hop dossier + local Ollama qwen2.5:3b scribe...'
          : 'Evaluating 2-hop dossier · Deterministic 65% abstention check...'
      });
    }

    try {
      var res = await apiJson('/api/query', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          query: q,
          use_llm: Boolean(useLlmToggle.checked),
          show_full_graph: Boolean(showFullGraphToggle.checked)
        })
      });
      renderVerdictResult(res);
    } catch (err) {
      verdictBadge.textContent = 'ERROR';
      verdictAnswer.textContent = err.message || 'Unable to execute query.';
    } finally {
      analyzeBtn.disabled = false;
      analyzeText.textContent = 'Analyze';
      if (showVeil) {
        await hideExecutionVeil();
      }
    }
  }

  btnTraps.addEventListener('click', function () {
    state.selectedDataset = 'synthetic_traps';
    btnTraps.classList.add('is-active');
    btnRaw.classList.remove('is-active');
    updateReindexNotice();
  });

  btnRaw.addEventListener('click', function () {
    state.selectedDataset = 'data/raw';
    btnRaw.classList.add('is-active');
    btnTraps.classList.remove('is-active');
    updateReindexNotice();
  });

  fileUploadInput.addEventListener('change', function () {
    handleFileUploadList(fileUploadInput.files);
  });

  if (addMoreFilesBtn) {
    addMoreFilesBtn.addEventListener('click', function () {
      fileUploadInput.click();
    });
  }

  if (uploadZone) {
    ['dragenter', 'dragover'].forEach(function (evName) {
      uploadZone.addEventListener(evName, function (e) {
        e.preventDefault();
        e.stopPropagation();
        uploadZone.classList.add('is-dragover');
      });
    });
    ['dragleave', 'drop'].forEach(function (evName) {
      uploadZone.addEventListener(evName, function (e) {
        e.preventDefault();
        e.stopPropagation();
        uploadZone.classList.remove('is-dragover');
      });
    });
    uploadZone.addEventListener('drop', function (e) {
      if (e.dataTransfer && e.dataTransfer.files) {
        handleFileUploadList(e.dataTransfer.files);
      }
    });
  }

  runPipelineBtn.addEventListener('click', async function () {
    runPipelineBtn.disabled = true;
    runPipelineText.textContent = 'Running Forensics & Graph...';
    pipelineFeedback.textContent = '';
    showExecutionVeil({ mode: 'pipeline' });

    try {
      var res = await apiJson('/api/pipeline', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          corpus: state.selectedDataset,
          use_llm: Boolean(useLlmToggle.checked)
        })
      });
      renderState(res.state, false);
      var s = res.summary || {};
      pipelineFeedback.textContent = 'Indexed ' + (s.doc_count || 0) + ' docs -> ' + (s.claim_count || 0) + ' claims, ' + (s.epistemic_edge_count || 0) + ' edges.';
      if (queryInput.value.trim()) {
        await runQuery(false);
      }
    } catch (err) {
      pipelineFeedback.textContent = 'Pipeline error: ' + err.message;
    } finally {
      runPipelineBtn.disabled = false;
      runPipelineText.textContent = 'Run Offline Pipeline';
      await hideExecutionVeil();
    }
  });

  queryForm.addEventListener('submit', function (e) {
    e.preventDefault();
    runQuery();
  });

  showFullGraphToggle.addEventListener('change', function () {
    runQuery();
  });

  /* Tabs */
  var tabButtons = document.querySelectorAll('.inspector-tab');
  var tabPanes = {
    conflicts: document.getElementById('paneConflicts'),
    visual: document.getElementById('paneVisual'),
    graph: document.getElementById('paneGraph')
  };

  tabButtons.forEach(function (btn) {
    btn.addEventListener('click', function () {
      var target = btn.getAttribute('data-tab');
      tabButtons.forEach(function (b) {
        var active = b === btn;
        b.classList.toggle('is-active', active);
        b.setAttribute('aria-selected', String(active));
      });
      Object.keys(tabPanes).forEach(function (key) {
        var pane = tabPanes[key];
        var active = key === target;
        pane.classList.toggle('is-active', active);
        pane.hidden = !active;
      });
      if (target === 'graph') {
        syncGraphIframe();
      }
    });
  });

  if (copyJsonBtn) {
    copyJsonBtn.addEventListener('click', function () {
      if (navigator.clipboard && rawJsonPre.textContent) {
        navigator.clipboard.writeText(rawJsonPre.textContent).then(function () {
          copyJsonBtn.textContent = 'Copied';
          setTimeout(function () { copyJsonBtn.textContent = 'Copy JSON Dossier'; }, 1500);
        });
      }
    });
  }

  /* Bootstrap Audit Console */
  async function initAuditConsole() {
    try {
      var initial = await apiJson('/api/state');
      renderState(initial, false);
      if (initial.presets && initial.presets.length) {
        queryInput.value = initial.presets[0].query;
      } else {
        queryInput.value = 'What is the approved amount for invoice INV-402?';
      }
      if (initial.has_graph) {
        await runQuery(false);
      }
    } catch (err) {
      verdictBadge.textContent = 'API ERROR';
      verdictAnswer.textContent = (err && err.message) ? err.message : 'Unable to reach CERBERUS-X local API at /api/state.';
    }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initAuditConsole);
  } else {
    initAuditConsole();
  }
})();
