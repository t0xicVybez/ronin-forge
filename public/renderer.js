'use strict';

// ── Global wizard state ────────────────────────────────────────────────────
let currentStep   = 0;
let selectedGame  = null;
let installDir    = '';
let formData      = {};
let installerResult = {};
let mrpackSource  = '';
let rsmAvailable  = false;

// ── Jobs (session history) ─────────────────────────────────────────────────
let jobs = [];
let activeJobId = null;

// ── RSM polling ────────────────────────────────────────────────────────────
let rsmPollTimer = null;

// ── Citadel status ─────────────────────────────────────────────────────────
let citadelStatus = 'disconnected';

const STEPS = ['step-0','step-1','step-2','step-3','step-4','step-5'];

const VIEW_LABELS = {
  install: 'Install',
  jobs:    'Jobs',
  rsm:     'RSM',
  settings:'Settings',
};

// ══════════════════════════════════════════════════════════════════════════════
// BOOT
// ══════════════════════════════════════════════════════════════════════════════
(async () => {
    setupTitlebar();
    setupUpdateBar();
    setupSidebar();
    setupInstallProgress();
    renderGameGrid();
    setupDirPicker();
    gotoStep(0);

    // Background: check RSM and load configs
    rsmAvailable = await api.invoke('check-rsm-installed');
    pollRSMTopbar();

    loadSettingsView();

    api.receive('citadel-status', (status) => {
        citadelStatus = status;
        updateCitadelDot(status);
    });
})();

// ══════════════════════════════════════════════════════════════════════════════
// TITLEBAR & UPDATES
// ══════════════════════════════════════════════════════════════════════════════
function setupTitlebar() {
    document.getElementById('btnMinimize').onclick = () => api.send('window-minimize');
    document.getElementById('btnClose').onclick    = () => api.send('window-close');
}

function setupUpdateBar() {
    api.receive('update-available', () => {
        document.getElementById('updateMsg').textContent = 'An update is downloading…';
        document.getElementById('updateBar').style.display = 'flex';
    });
    api.receive('update-downloaded', () => {
        document.getElementById('updateMsg').textContent = 'Update ready — restart to apply.';
        const btn = document.getElementById('btnInstallUpdate');
        btn.style.display = '';
        btn.onclick = () => api.send('install-update');
        document.getElementById('updateBar').style.display = 'flex';
    });
}

// ══════════════════════════════════════════════════════════════════════════════
// SIDEBAR / VIEW SWITCHING
// ══════════════════════════════════════════════════════════════════════════════
function setupSidebar() {
    document.querySelectorAll('.side-nav-item').forEach(item => {
        item.addEventListener('click', () => showView(item.dataset.view));
    });
}

function showView(name) {
    // Sidebar active state
    document.querySelectorAll('.side-nav-item').forEach(el => {
        el.classList.toggle('active', el.dataset.view === name);
    });

    // Breadcrumb
    document.getElementById('breadcrumbCurrent').textContent = VIEW_LABELS[name] || name;

    // Views
    const views = ['install','jobs','rsm','settings'];
    views.forEach(v => {
        document.getElementById(`view${cap(v)}`).classList.toggle('hidden', v !== name);
    });

    // RSM polling: only while RSM view is visible
    if (name === 'rsm') {
        loadRSMView();
        rsmPollTimer = setInterval(loadRSMView, 5000);
    } else {
        if (rsmPollTimer) { clearInterval(rsmPollTimer); rsmPollTimer = null; }
    }

    if (name === 'jobs') renderJobsView();
    if (name === 'settings') loadSettingsView();
}

function cap(s) { return s.charAt(0).toUpperCase() + s.slice(1); }

// ══════════════════════════════════════════════════════════════════════════════
// RSM TOPBAR STATUS
// ══════════════════════════════════════════════════════════════════════════════
async function pollRSMTopbar() {
    try {
        const status = await api.invoke('get-rsm-status');
        const dot   = document.getElementById('rsmDot');
        const label = document.getElementById('rsmTopbarLabel');
        if (status.online) {
            dot.className   = 'status-dot online';
            label.textContent = `RSM · ${status.serverCount} server${status.serverCount !== 1 ? 's' : ''}`;
        } else {
            dot.className   = 'status-dot offline';
            label.textContent = 'RSM Offline';
        }
    } catch {}
    setTimeout(pollRSMTopbar, 10000);
}

// ══════════════════════════════════════════════════════════════════════════════
// WIZARD — step navigation
// ══════════════════════════════════════════════════════════════════════════════
function gotoStep(n) {
    currentStep = n;

    STEPS.forEach((id, i) => {
        document.getElementById(id).classList.toggle('active', i === n);
    });

    document.querySelectorAll('.wizard-step').forEach((el, i) => {
        el.classList.toggle('active', i === n);
        el.classList.toggle('done',   i < n);
    });

    updateFooter();
}

function updateFooter() {
    const back   = document.getElementById('btnBack');
    const next   = document.getElementById('btnNext');
    const status = document.getElementById('footerStatus');

    back.disabled = currentStep === 0 || currentStep >= 4;

    const cfg = stepNextConfig();
    next.textContent = cfg.label;
    next.disabled    = !cfg.enabled;
    next.className   = `btn ${cfg.danger ? 'btn-danger' : 'btn-primary'}`;
    next.style.display = cfg.hidden ? 'none' : '';

    back.onclick = () => { if (currentStep > 0 && currentStep < 4) gotoStep(currentStep - 1); };
    next.onclick  = cfg.action;
    status.textContent = cfg.status || '';
}

function stepNextConfig() {
    switch (currentStep) {
        case 0: return {
            label:   selectedGame ? 'Continue →' : 'Select a Game',
            enabled: !!selectedGame,
            action:  () => gotoStep(1),
        };
        case 1: return {
            label:   'Continue →',
            enabled: !!installDir,
            action:  () => { buildConfigForm(); gotoStep(2); },
        };
        case 2: return {
            label:   'Review →',
            enabled: true,
            action:  () => {
                if (!validateForm()) return;
                collectFormData();
                if (selectedGame.hasMods) {
                    showModpackModal();
                } else {
                    mrpackSource = '';
                    buildReview();
                    gotoStep(3);
                }
            },
        };
        case 3: return {
            label:   'Install',
            enabled: true,
            action:  () => startInstall().catch(err => {
                document.getElementById('progressMsg').textContent = `Unexpected error: ${err.message}`;
                document.getElementById('installStage').textContent = 'FAILED';
            }),
        };
        case 4: return {
            label:   'Cancel',
            enabled: true,
            danger:  true,
            action:  () => {
                api.send('cancel-install');
                document.getElementById('progressMsg').textContent = 'Cancelling…';
            },
        };
        case 5: return { label: '', enabled: false, hidden: true };
    }
}

// ══════════════════════════════════════════════════════════════════════════════
// STEP 0 — Game grid
// ══════════════════════════════════════════════════════════════════════════════
function renderGameGrid() {
    const grid = document.getElementById('gameGrid');
    grid.innerHTML = '';

    GAMES.forEach(game => {
        const card = document.createElement('div');
        card.className = 'game-card';
        card.dataset.gameId = game.id;
        card.innerHTML = `
          <div class="game-card-icon">${game.icon}</div>
          <div class="game-card-eyebrow">Game Server</div>
          <div class="game-card-name">${game.displayName}</div>
          <div class="game-card-desc">${game.description}</div>
          <div class="game-card-footer">
            <span class="disk-badge">~${game.diskGB} GB</span>
          </div>`;

        card.onclick = () => {
            document.querySelectorAll('.game-card').forEach(c => c.classList.remove('selected'));
            card.classList.add('selected');
            selectedGame = game;
            const safeName = game.displayName.replace(/[^a-zA-Z0-9]/g, '_');
            if (!installDir) {
                const dir = `C:\\Servers\\${safeName}`;
                document.getElementById('installDir').value = dir;
                installDir = dir;
            }
            document.getElementById('diskEstimate').textContent = `~${game.diskGB} GB`;
            updateFooter();
        };

        grid.appendChild(card);
    });
}

// ══════════════════════════════════════════════════════════════════════════════
// STEP 1 — Install location
// ══════════════════════════════════════════════════════════════════════════════
function setupDirPicker() {
    const input = document.getElementById('installDir');
    const info  = document.getElementById('dirInfo');

    document.getElementById('btnBrowseDir').onclick = async () => {
        const chosen = await api.invoke('select-folder', { title: 'Choose Install Directory' });
        if (chosen) {
            input.value = chosen;
            installDir  = chosen;
            validateDir(chosen);
            updateFooter();
            checkDiskSpace(chosen);
        }
    };

    input.addEventListener('input', () => {
        installDir = input.value.trim();
        validateDir(installDir);
        updateFooter();
    });

    function validateDir(dir) {
        if (!dir) { info.textContent = 'Enter or browse to a folder.'; info.className = 'dir-info'; return; }
        info.textContent = `Files will be installed to: ${dir}`;
        info.className   = 'dir-info ok';
    }
}

async function checkDiskSpace(dir) {
    if (!selectedGame || !dir) return;
    const result = await api.invoke('check-disk-space', { installDir: dir, requiredGB: selectedGame.diskGB });
    const wrap = document.getElementById('diskFreeWrap');
    const el   = document.getElementById('diskFree');
    if (result.freeGB !== null) {
        wrap.style.display = '';
        el.textContent     = `${result.freeGB} GB`;
        el.style.color     = result.sufficient ? '#44dd88' : '#ff6655';
    }
}

// ══════════════════════════════════════════════════════════════════════════════
// STEP 2 — Config form
// ══════════════════════════════════════════════════════════════════════════════
function buildConfigForm() {
    if (!selectedGame) return;
    document.getElementById('configTitle').textContent = `Configure ${selectedGame.displayName}`;
    const container = document.getElementById('configForm');
    container.innerHTML = '';

    selectedGame.form.forEach(field => {
        const wrapper = document.createElement('div');
        wrapper.className = `field${field.type === 'file-picker' ? ' full-width' : ''}`;
        wrapper.id = `field-wrapper-${field.id}`;

        let inputHTML = '';
        if (field.type === 'text' || field.type === 'password') {
            inputHTML = `<input type="${field.type}" class="field-input" id="f-${field.id}" placeholder="${field.placeholder || ''}" ${field.required ? 'required' : ''}>`;
        } else if (field.type === 'number') {
            inputHTML = `<input type="number" class="field-input" id="f-${field.id}" value="${field.default || ''}" min="${field.min || 0}" max="${field.max || 99999}">`;
        } else if (field.type === 'select') {
            const opts = field.options.map(o => `<option value="${o}"${o === field.default ? ' selected' : ''}>${o}</option>`).join('');
            inputHTML = `<select class="field-input" id="f-${field.id}">${opts}</select>`;
        } else if (field.type === 'select-async') {
            inputHTML = `<select class="field-input" id="f-${field.id}"><option value="">Loading…</option></select>`;
        } else if (field.type === 'file-picker') {
            inputHTML = `
              <div class="path-row">
                <input type="text" class="field-input" id="f-${field.id}" placeholder="${field.placeholder || ''}">
                <button class="btn btn-ghost btn-sm" onclick="pickFile('${field.id}')">Browse</button>
              </div>`;
        }

        wrapper.innerHTML = `
          <label class="field-label" for="f-${field.id}">${field.label}${field.required ? ' *' : ''}</label>
          ${inputHTML}
          ${field.hint ? `<div class="field-hint" id="hint-${field.id}">${field.hint}</div>` : ''}`;

        container.appendChild(wrapper);

        if (field.type === 'select-async') loadAsyncOptions(field);
    });

    const nameField = document.getElementById('f-serverName');
    if (nameField && !nameField.value) nameField.value = `My ${selectedGame.displayName} Server`;

    if (selectedGame.form.some(f => f.id === 'javaPath')) autoDetectJava();
}

async function autoDetectJava() {
    const javas = await api.invoke('find-java');
    const el    = document.getElementById('f-javaPath');
    if (el && !el.value && javas.length > 0) {
        el.value = javas[0];
        validateJavaVersion();
    }
}

async function validateJavaVersion() {
    const javaEl = document.getElementById('f-javaPath');
    const mcEl   = document.getElementById('f-mcVersion');
    if (!javaEl?.value || !mcEl?.value) return;

    const res  = await api.invoke('validate-java', { javaPath: javaEl.value, mcVersion: mcEl.value });
    const hint = document.getElementById('hint-javaPath');

    if (res.valid) {
        javaEl.classList.remove('error');
        if (hint) { hint.textContent = `Java ${res.actual} detected ✓`; hint.style.color = '#44dd88'; }
    } else {
        javaEl.classList.add('error');
        if (hint) { hint.textContent = res.error; hint.style.color = '#ff6655'; }
    }
}

async function loadAsyncOptions(field) {
    const sel = document.getElementById(`f-${field.id}`);
    if (!sel) return;
    try {
        let options = [];
        if (field.fetchKey === 'minecraft-versions') {
            const versions = await api.invoke('get-minecraft-versions');
            options = versions.map(v => ({ value: v, label: v }));
            if (selectedGame.id === 'minecraft-forge') {
                sel.addEventListener('change', () => loadForgeVersions(sel.value));
            }
            sel.addEventListener('change', validateJavaVersion);
        } else if (field.fetchKey === 'forge-versions') {
            options = [{ value: '', label: 'Select Minecraft version first' }];
        }
        sel.innerHTML = options.map(o => `<option value="${o.value}">${o.label}</option>`).join('');
    } catch {
        sel.innerHTML = `<option value="">Failed to load — check internet</option>`;
    }
}

async function loadForgeVersions(mcVersion) {
    const sel = document.getElementById('f-forgeVersion');
    if (!sel) return;
    sel.innerHTML = '<option value="">Loading…</option>';
    const versions = await api.invoke('get-forge-versions', mcVersion);
    sel.innerHTML = versions.length
        ? versions.map(v => `<option value="${v.id}">${v.label}</option>`).join('')
        : '<option value="">No Forge versions for this MC version</option>';
}

async function pickFile(fieldId) {
    const filters = fieldId === 'mrpackInput'
        ? [{ name: 'Modrinth Pack', extensions: ['mrpack'] }]
        : [{ name: 'Executable', extensions: ['exe'] }];
    const file = await api.invoke('select-file', { title: 'Select File', filters });
    if (file) {
        const el = document.getElementById(`f-${fieldId}`);
        if (el) el.value = file;
        if (fieldId === 'javaPath') validateJavaVersion();
    }
}

function browseMrpack() { pickFile('mrpackInput'); }

function validateForm() {
    let ok = true;
    selectedGame.form.forEach(field => {
        if (field.required) {
            const el = document.getElementById(`f-${field.id}`);
            if (!el || !el.value.trim()) {
                if (el) el.classList.add('error');
                ok = false;
            } else {
                if (el) el.classList.remove('error');
            }
        }
    });
    if (!ok) document.getElementById('footerStatus').textContent = 'Fill in all required fields (marked with *)';
    return ok;
}

function collectFormData() {
    formData = {};
    selectedGame.form.forEach(field => {
        const el = document.getElementById(`f-${field.id}`);
        if (el) formData[field.id] = el.value.trim();
    });
}

// ══════════════════════════════════════════════════════════════════════════════
// STEP 3 — Review
// ══════════════════════════════════════════════════════════════════════════════
function buildReview() {
    const table = document.getElementById('reviewTable');
    const rows = [
        ['Game',              selectedGame.displayName],
        ['Install Directory', installDir],
        ['Server Name',       formData.serverName || '—'],
        ['Disk Required',     `~${selectedGame.diskGB} GB`],
    ];

    selectedGame.form.forEach(f => {
        if (f.id === 'serverName') return;
        const val = formData[f.id];
        if (!val) return;
        rows.push([f.label, f.type === 'password' ? '••••••••' : val]);
    });

    if (mrpackSource) rows.push(['Modpack', mrpackSource.split(/[\\/]/).pop()]);

    table.innerHTML = rows.map(([k, v]) => `
      <div class="review-row">
        <div class="review-key">${k}</div>
        <div class="review-val">${v}</div>
      </div>`).join('');

    const warnEl = document.getElementById('largeGameWarning');
    const msgEl  = document.getElementById('largeGameMsg');
    if (selectedGame.diskGB >= 10) {
        msgEl.textContent  = `~${selectedGame.diskGB} GB download — expect ${estimateDownloadRange(selectedGame.diskGB)} depending on your connection.`;
        warnEl.style.display = 'flex';
    } else {
        warnEl.style.display = 'none';
    }
}

function estimateDownloadRange(gb) {
    const bytes = gb * 1024 * 1024 * 1024;
    const fast  = bytes / (100 * 1024 * 1024 / 8);
    const slow  = bytes / (10  * 1024 * 1024 / 8);
    const fmt   = s => s < 3600 ? `${Math.round(s / 60)} min` : `${(s / 3600).toFixed(1)} hr`;
    return `${fmt(fast)} – ${fmt(slow)}`;
}

// ══════════════════════════════════════════════════════════════════════════════
// MODPACK MODAL
// ══════════════════════════════════════════════════════════════════════════════
function showModpackModal() {
    const modal = document.getElementById('modpackModal');
    document.getElementById('mrpackInput').value = mrpackSource;
    modal.classList.add('open');

    const close = (src) => {
        modal.classList.remove('open');
        mrpackSource = src;
        buildReview();
        gotoStep(3);
    };

    document.getElementById('btnSkipMods').onclick    = () => close('');
    document.getElementById('btnContinueMods').onclick = () => close(document.getElementById('mrpackInput').value.trim());
}

// ══════════════════════════════════════════════════════════════════════════════
// STEP 4 — Installing
// ══════════════════════════════════════════════════════════════════════════════
function setupInstallProgress() {
    api.receive('install-progress', ({ stage, percent, message }) => {
        document.getElementById('installStage').textContent = stage.toUpperCase();
        document.getElementById('progressMsg').textContent  = message;

        const fill = document.getElementById('progressFill');
        if (stage === 'connect') {
            fill.classList.add('connecting');
        } else {
            if (fill.classList.contains('connecting')) {
                fill.style.transition = 'none';
                fill.classList.remove('connecting');
                fill.style.width = `${percent}%`;
                requestAnimationFrame(() => { fill.style.transition = ''; });
            } else {
                fill.style.width = `${percent}%`;
            }
        }

        // Update active job
        const job = jobs.find(j => j.id === activeJobId);
        if (job) { job.stage = stage; job.percent = percent; job.lastMsg = message; }
    });

    api.receive('install-log', (line) => {
        const log = document.getElementById('installLog');
        log.textContent += line;
        log.scrollTop = log.scrollHeight;

        const job = jobs.find(j => j.id === activeJobId);
        if (job) job.logs += line;
    });
}

async function startInstall() {
    const statusEl = document.getElementById('footerStatus');

    const spaceCheck = await api.invoke('check-disk-space', { installDir, requiredGB: selectedGame.diskGB });
    if (!spaceCheck.sufficient && spaceCheck.freeGB !== null) {
        statusEl.textContent = `Not enough disk space — need ~${selectedGame.diskGB} GB, only ${spaceCheck.freeGB.toFixed(1)} GB free.`;
        return;
    }

    const portFields = selectedGame.form.filter(f => f.id === 'port' || f.id === 'rconPort');
    for (const field of portFields) {
        const port = parseInt(formData[field.id]);
        if (!port) continue;
        const check = await api.invoke('check-port', { port });
        if (check.inUse) {
            statusEl.textContent = `Port ${port} (${field.label}) is already in use — go back and change it.`;
            return;
        }
    }
    statusEl.textContent = '';

    // Track as a job
    const jobId = Date.now().toString();
    activeJobId = jobId;
    jobs.push({
        id:        jobId,
        gameId:    selectedGame.id,
        gameName:  selectedGame.displayName,
        installDir,
        status:    'running',
        startTime: Date.now(),
        endTime:   null,
        logs:      '',
        stage:     '',
        percent:   0,
        lastMsg:   '',
        rsmMethod: null,
    });

    gotoStep(4);
    document.getElementById('installLog').textContent = '';

    const result = await api.invoke('start-install', {
        gameId:       selectedGame.id,
        installDir,
        formData,
        diskGB:       selectedGame.diskGB,
        gameName:     selectedGame.displayName,
        mrpackSource: mrpackSource || null,
    });

    const job = jobs.find(j => j.id === jobId);

    if (result.cancelled) {
        if (job) { job.status = 'cancelled'; job.endTime = Date.now(); }
        gotoStep(3);
        document.getElementById('footerStatus').textContent = 'Installation cancelled.';
        return;
    }

    if (!result.success) {
        if (job) { job.status = 'failed'; job.endTime = Date.now(); }
        document.getElementById('progressMsg').textContent  = `Error: ${result.error}`;
        document.getElementById('installStage').textContent = 'FAILED';
        document.getElementById('progressFill').style.background = 'var(--red-bright)';
        const next = document.getElementById('btnNext');
        next.textContent = '← Back';
        next.className   = 'btn btn-ghost';
        next.disabled    = false;
        next.onclick     = () => gotoStep(3);
        return;
    }

    if (job) { job.status = 'done'; job.endTime = Date.now(); job.rsmMethod = result.rsmMethod || null; }
    installerResult = result.installerResult || {};
    showComplete(result.rsmMethod);
}

// ══════════════════════════════════════════════════════════════════════════════
// STEP 5 — Complete
// ══════════════════════════════════════════════════════════════════════════════
function showComplete(rsmMethod) {
    gotoStep(5);

    document.getElementById('completeMsg').textContent =
        `${selectedGame.displayName} installed to ${installDir}`;

    // RSM method badge
    const methodBadge = document.getElementById('rsmMethodBadge');
    if (rsmMethod === 'api') {
        methodBadge.textContent = '⚡ Added to RSM via live API';
        methodBadge.style.display = 'inline-flex';
    } else if (rsmMethod === 'file') {
        methodBadge.textContent = '📄 Added to RSM servers.json';
        methodBadge.style.display = 'inline-flex';
        methodBadge.style.color = 'var(--text-dim)';
        methodBadge.style.background = 'rgba(255,255,255,0.04)';
        methodBadge.style.border = '1px solid var(--border-2)';
    } else {
        methodBadge.style.display = 'none';
    }

    // Buttons: only show "Add to RSM" if RSM is available and method wasn't already auto-applied
    const addBtn  = document.getElementById('btnAddToRSM');
    const rsmNote = document.getElementById('rsmNotice');
    if (rsmAvailable && !rsmMethod) {
        addBtn.style.display  = '';
        rsmNote.style.display = 'none';
    } else if (!rsmAvailable) {
        addBtn.style.display  = 'none';
        rsmNote.style.display = '';
    } else {
        addBtn.style.display  = 'none';
        rsmNote.style.display = 'none';
    }

    // Config note
    const configNoteEl  = document.getElementById('configNote');
    const configMsgEl   = document.getElementById('configNoteMsg');
    const configPathEl  = document.getElementById('configNotePath');
    if (installerResult.configNote) {
        configNoteEl.style.display = '';
        configMsgEl.textContent    = installerResult.configNote.message;
        configPathEl.textContent   = installerResult.configNote.path;
    } else {
        configNoteEl.style.display = 'none';
    }

    const entry = buildRSMEntry();

    addBtn.onclick = async () => {
        const r = await api.invoke('write-to-rsm', entry);
        if (r && r.success) {
            addBtn.textContent  = '✓ Added';
            addBtn.disabled     = true;
            methodBadge.textContent    = r.method === 'api' ? '⚡ Added to RSM via live API' : '📄 Written to servers.json';
            methodBadge.style.display  = 'inline-flex';
        }
    };

    document.getElementById('btnExportJSON').onclick = async () => {
        const r = await api.invoke('export-server-json', entry);
        if (r && r.success) {
            document.getElementById('btnExportJSON').textContent = '✓ Saved';
            document.getElementById('btnExportJSON').disabled    = true;
        }
    };

    document.getElementById('btnOpenFolder').onclick = () => api.invoke('open-folder', installDir);

    document.getElementById('btnStartOver').onclick = () => {
        selectedGame    = null;
        installDir      = '';
        formData        = {};
        installerResult = {};
        mrpackSource    = '';
        activeJobId     = null;
        document.querySelectorAll('.game-card').forEach(c => c.classList.remove('selected'));
        document.getElementById('installDir').value           = '';
        document.getElementById('progressFill').style.width   = '0%';
        document.getElementById('progressFill').style.background = '';
        document.getElementById('progressFill').classList.remove('connecting');
        document.getElementById('installLog').textContent     = '';
        document.getElementById('diskFreeWrap').style.display = 'none';
        gotoStep(0);
        updateFooter();
    };
}

function buildRSMEntry() {
    const rsm = selectedGame.rsm;
    const f   = formData;
    const dir = installDir;
    const ir  = installerResult;

    return {
        id:                Date.now().toString(),
        name:              f.serverName || selectedGame.displayName,
        type:              rsm.type,
        category:          rsm.category,
        path:              typeof rsm.path        === 'function' ? rsm.path(f, dir, ir)        : rsm.path,
        workingDir:        typeof rsm.workingDir  === 'function' ? rsm.workingDir(f, dir, ir)  : rsm.workingDir,
        args:              typeof rsm.args        === 'function' ? rsm.args(f, dir, ir)        : rsm.args,
        playerListCommand: rsm.playerListCommand || null,
        apiPort:           typeof rsm.apiPort     === 'function' ? rsm.apiPort(f, dir, ir)     : (rsm.apiPort || ''),
        apiPass:           typeof rsm.apiPass     === 'function' ? rsm.apiPass(f, dir, ir)     : (rsm.apiPass || ''),
        logPath:           typeof rsm.logPath     === 'function' ? rsm.logPath(f, dir, ir)     : (rsm.logPath || ''),
        status:            'Offline',
        pid:               null,
        logs:              '',
    };
}

// ══════════════════════════════════════════════════════════════════════════════
// JOBS VIEW
// ══════════════════════════════════════════════════════════════════════════════
function renderJobsView() {
    const container = document.getElementById('jobsContent');
    if (jobs.length === 0) {
        container.innerHTML = `
          <div class="empty-state">
            <div class="empty-icon">📋</div>
            <div class="empty-title">No jobs yet</div>
            <div class="empty-sub">Install a server to see it listed here.</div>
          </div>`;
        return;
    }

    const rows = jobs.map(job => {
        const duration = job.endTime
            ? fmtDuration(job.endTime - job.startTime)
            : 'In progress';
        const badgeCls = { running: 'badge-running', done: 'badge-online', cancelled: 'badge-offline', failed: 'badge-failed' }[job.status] || 'badge-offline';
        return `
          <tr data-job="${job.id}">
            <td>
              <span class="job-game-name">${job.gameName}</span>
              <span class="job-path">${job.installDir}</span>
              <div class="job-log-expand" id="log-${job.id}">${escHtml(job.logs || '(no log output)')}</div>
            </td>
            <td><span class="badge ${badgeCls}">${job.status}</span></td>
            <td>${duration}</td>
            <td>${job.rsmMethod === 'api' ? '⚡ RSM API' : job.rsmMethod === 'file' ? '📄 File' : '—'}</td>
          </tr>`;
    }).join('');

    container.innerHTML = `
      <table class="jobs-table">
        <thead>
          <tr>
            <th>Server</th>
            <th>Status</th>
            <th>Duration</th>
            <th>RSM</th>
          </tr>
        </thead>
        <tbody>${rows}</tbody>
      </table>`;

    container.querySelectorAll('tbody tr').forEach(row => {
        row.addEventListener('click', () => {
            const logEl = row.querySelector('.job-log-expand');
            if (logEl) logEl.classList.toggle('open');
        });
    });
}

function fmtDuration(ms) {
    if (ms < 1000) return `${ms}ms`;
    const s = Math.floor(ms / 1000);
    if (s < 60) return `${s}s`;
    return `${Math.floor(s / 60)}m ${s % 60}s`;
}

function escHtml(s) {
    return s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
}

// ══════════════════════════════════════════════════════════════════════════════
// RSM VIEW
// ══════════════════════════════════════════════════════════════════════════════
async function loadRSMView() {
    const dot        = document.getElementById('rsmViewDot');
    const label      = document.getElementById('rsmViewLabel');
    const urlEl      = document.getElementById('rsmViewUrl');
    const listEl     = document.getElementById('rsmServerList');
    const countEl    = document.getElementById('rsmServerCount');

    try {
        const status = await api.invoke('get-rsm-status');

        if (status.online) {
            dot.className    = 'status-dot online';
            label.textContent = 'Online';
            urlEl.textContent = status.url || '';
            countEl.textContent = `${status.servers.length} server${status.servers.length !== 1 ? 's' : ''}`;
            countEl.className   = 'badge badge-online';

            if (status.servers.length === 0) {
                listEl.innerHTML = `
                  <div class="empty-state">
                    <div class="empty-icon">⚡</div>
                    <div class="empty-title">No servers</div>
                    <div class="empty-sub">Add a server in RSM to see it here.</div>
                  </div>`;
            } else {
                listEl.innerHTML = status.servers.map(srv => `
                  <div class="rsm-server-row">
                    <span class="status-dot ${srv.status === 'Online' ? 'online' : 'offline'}"></span>
                    <div class="rsm-server-info">
                      <div class="rsm-server-name">${escHtml(srv.name)}</div>
                      <div class="rsm-server-type">${srv.type || ''}</div>
                    </div>
                    <span class="badge ${srv.status === 'Online' ? 'badge-online' : 'badge-offline'}">${srv.status}</span>
                  </div>`).join('');
            }
        } else {
            dot.className      = 'status-dot offline';
            label.textContent  = 'Offline';
            urlEl.textContent  = status.url ? `Tried: ${status.url}` : 'RSM not running or not installed';
            countEl.textContent = '—';
            countEl.className   = 'badge badge-offline';
            listEl.innerHTML = `
              <div class="empty-state">
                <div class="empty-icon">⚡</div>
                <div class="empty-title">RSM offline</div>
                <div class="empty-sub">Start Ronin Server Manager to see your servers here.</div>
              </div>`;
        }
    } catch {
        dot.className     = 'status-dot offline';
        label.textContent = 'Error';
    }
}

document.getElementById('btnRefreshRSM').addEventListener('click', loadRSMView);

// ══════════════════════════════════════════════════════════════════════════════
// SETTINGS VIEW
// ══════════════════════════════════════════════════════════════════════════════
async function loadSettingsView() {
    // API config
    const apiCfg = await api.invoke('get-api-config');
    document.getElementById('apiEnabled').checked    = !!apiCfg.enabled;
    document.getElementById('apiPort').value         = apiCfg.port || 3003;
    document.getElementById('apiKeyDisplay').textContent = apiCfg.apiKey || '(not set — generate one below)';

    // Agent config
    const agentCfg = await api.invoke('get-agent-config');
    document.getElementById('agentEnabled').checked  = !!agentCfg.enabled;
    document.getElementById('agentUrl').value        = agentCfg.portalUrl || '';
    document.getElementById('agentToken').value      = agentCfg.agentToken || '';

    // RSM auto-detected
    const rsmStatus = await api.invoke('get-rsm-status');
    document.getElementById('rsmAutoUrl').textContent = rsmStatus.url || '(not detected)';
    const rsmDot   = document.getElementById('rsmSettingsDot');
    const rsmLabel = document.getElementById('rsmSettingsLabel');
    rsmDot.className    = `status-dot ${rsmStatus.online ? 'online' : 'offline'}`;
    rsmLabel.textContent = rsmStatus.online ? 'Connected' : 'Offline';
}

// Save API
document.getElementById('btnSaveApi').addEventListener('click', async () => {
    const cfg = {
        enabled: document.getElementById('apiEnabled').checked,
        port:    parseInt(document.getElementById('apiPort').value) || 3003,
        apiKey:  document.getElementById('apiKeyDisplay').textContent.trim(),
    };
    await api.invoke('save-api-config', cfg);
    const status = document.getElementById('apiSaveStatus');
    status.style.display = '';
    setTimeout(() => { status.style.display = 'none'; }, 2000);
});

// Generate key
document.getElementById('btnGenerateKey').addEventListener('click', async () => {
    const key = await api.invoke('generate-api-key');
    document.getElementById('apiKeyDisplay').textContent = key;
});

// Copy key
document.getElementById('btnCopyKey').addEventListener('click', () => {
    navigator.clipboard.writeText(document.getElementById('apiKeyDisplay').textContent).catch(() => {});
});

// Save agent
document.getElementById('btnSaveAgent').addEventListener('click', async () => {
    const cfg = {
        enabled:    document.getElementById('agentEnabled').checked,
        portalUrl:  document.getElementById('agentUrl').value.trim(),
        agentToken: document.getElementById('agentToken').value.trim(),
    };
    await api.invoke('save-agent-config', cfg);
    const status = document.getElementById('agentSaveStatus');
    status.style.display = '';
    setTimeout(() => { status.style.display = 'none'; }, 2000);
});

// Citadel status dot
function updateCitadelDot(status) {
    const dot   = document.getElementById('citadelDot');
    const label = document.getElementById('citadelStatusLabel');
    if (!dot) return;
    if (status === 'connected') {
        dot.className    = 'status-dot online';
        label.textContent = 'Connected';
    } else if (status === 'connecting') {
        dot.className    = 'status-dot offline';
        label.textContent = 'Connecting…';
    } else {
        dot.className    = 'status-dot offline';
        label.textContent = 'Disconnected';
    }
}
