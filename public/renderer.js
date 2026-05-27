'use strict';

// ── State ──────────────────────────────────────────────────────────────────
let currentStep = 0;
let selectedGame = null;
let installDir = '';
let formData = {};
let installerResult = {};
let rsmAvailable = false;

const STEPS = ['step-0','step-1','step-2','step-3','step-4','step-5'];

// ── Boot ───────────────────────────────────────────────────────────────────
(async () => {
    setupTitlebar();
    renderGameGrid();
    setupDirPicker();
    rsmAvailable = await api.invoke('check-rsm-installed');
    setupInstallProgress();
    gotoStep(0);
})();

// ── Titlebar ───────────────────────────────────────────────────────────────
function setupTitlebar() {
    document.getElementById('btnMinimize').onclick = () => api.send('window-minimize');
    document.getElementById('btnClose').onclick    = () => api.send('window-close');
}

// ── Step navigation ────────────────────────────────────────────────────────
function gotoStep(n) {
    currentStep = n;

    STEPS.forEach((id, i) => {
        document.getElementById(id).classList.toggle('active', i === n);
    });

    document.querySelectorAll('.step-item').forEach((el, i) => {
        el.classList.toggle('active', i === n);
        el.classList.toggle('done', i < n);
    });

    updateFooter();
}

function updateFooter() {
    const back   = document.getElementById('btnBack');
    const next   = document.getElementById('btnNext');
    const status = document.getElementById('footerStatus');

    back.disabled = currentStep === 0 || currentStep >= 4;

    // Reconfigure Next button per step
    const cfg = stepNextConfig();
    next.textContent = cfg.label;
    next.disabled    = !cfg.enabled;
    next.className   = `btn ${cfg.danger ? 'btn-danger' : 'btn-primary'}`;
    if (cfg.hidden) next.style.display = 'none';
    else            next.style.display = '';

    back.onclick = () => {
        if (currentStep > 0 && currentStep < 4) gotoStep(currentStep - 1);
    };

    next.onclick = cfg.action;
    status.textContent = cfg.status || '';
}

function stepNextConfig() {
    switch (currentStep) {
        case 0: return {
            label: selectedGame ? `Continue →` : 'Select a Game',
            enabled: !!selectedGame,
            action: () => gotoStep(1),
        };
        case 1: return {
            label: 'Continue →',
            enabled: !!installDir,
            action: () => {
                buildConfigForm();
                gotoStep(2);
            },
        };
        case 2: return {
            label: 'Review →',
            enabled: true,
            action: () => {
                if (!validateForm()) return;
                collectFormData();
                buildReview();
                gotoStep(3);
            },
        };
        case 3: return {
            label: 'Install',
            enabled: true,
            action: () => startInstall(),
        };
        case 4: return {
            label: 'Cancel',
            enabled: true,
            danger: true,
            action: () => {
                api.send('cancel-install');
                document.getElementById('progressMsg').textContent = 'Cancelling...';
            },
        };
        case 5: return {
            label: '',
            enabled: false,
            hidden: true,
        };
    }
}

// ── Step 0: Game Selection ─────────────────────────────────────────────────
function renderGameGrid() {
    const grid = document.getElementById('gameGrid');
    grid.innerHTML = '';

    GAMES.forEach(game => {
        const card = document.createElement('div');
        card.className = 'game-card';
        card.dataset.gameId = game.id;
        card.innerHTML = `
            <span class="game-icon">${game.icon}</span>
            <div class="game-name">${game.displayName}</div>
            <div class="game-desc">${game.description}</div>
            <div class="disk-badge">~${game.diskGB} GB</div>`;

        card.onclick = () => {
            document.querySelectorAll('.game-card').forEach(c => c.classList.remove('selected'));
            card.classList.add('selected');
            selectedGame = game;
            // Default install dir suggestion
            const safeName = game.displayName.replace(/[^a-zA-Z0-9]/g, '_');
            if (!installDir) {
                document.getElementById('installDir').value = `C:\\Servers\\${safeName}`;
                installDir = `C:\\Servers\\${safeName}`;
            }
            document.getElementById('diskEstimate').textContent = `~${game.diskGB} GB`;
            updateFooter();
        };

        grid.appendChild(card);
    });
}

// ── Step 1: Install Location ───────────────────────────────────────────────
function setupDirPicker() {
    const input = document.getElementById('installDir');
    const info  = document.getElementById('dirInfo');

    document.getElementById('btnBrowseDir').onclick = async () => {
        const chosen = await api.invoke('select-folder', { title: 'Choose Install Directory' });
        if (chosen) {
            input.value = chosen;
            installDir = chosen;
            validateDir(chosen);
            updateFooter();
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
        info.className = 'dir-info ok';
    }
}

// ── Step 2: Config Form ────────────────────────────────────────────────────
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
            inputHTML = `<input type="${field.type}" id="f-${field.id}" placeholder="${field.placeholder || ''}" ${field.required ? 'required' : ''}>`;
        } else if (field.type === 'number') {
            inputHTML = `<input type="number" id="f-${field.id}" value="${field.default || ''}" min="${field.min || 0}" max="${field.max || 99999}">`;
        } else if (field.type === 'select') {
            const opts = field.options.map(o => `<option value="${o}"${o === field.default ? ' selected' : ''}>${o}</option>`).join('');
            inputHTML = `<select id="f-${field.id}">${opts}</select>`;
        } else if (field.type === 'select-async') {
            inputHTML = `<select id="f-${field.id}"><option value="">Loading...</option></select>`;
        } else if (field.type === 'file-picker') {
            inputHTML = `
                <div class="path-row">
                    <input type="text" id="f-${field.id}" placeholder="${field.placeholder || ''}">
                    <button class="btn btn-secondary" onclick="pickFile('${field.id}')">Browse</button>
                </div>`;
        }

        wrapper.innerHTML = `
            <label for="f-${field.id}">${field.label}${field.required ? ' *' : ''}</label>
            ${inputHTML}
            ${field.hint ? `<div class="hint">${field.hint}</div>` : ''}`;

        container.appendChild(wrapper);

        // Load async options
        if (field.type === 'select-async') {
            loadAsyncOptions(field);
        }
    });

    // Pre-fill server name
    const nameField = document.getElementById('f-serverName');
    if (nameField && !nameField.value) {
        nameField.value = `My ${selectedGame.displayName} Server`;
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

            // When MC version changes, reload dependent forge versions
            if (selectedGame.id === 'minecraft-forge') {
                sel.addEventListener('change', () => loadForgeVersions(sel.value));
            }
        } else if (field.fetchKey === 'forge-versions') {
            // Populated when MC version changes
            options = [{ value: '', label: 'Select Minecraft version first' }];
        }

        sel.innerHTML = options.map(o => `<option value="${o.value}">${o.label}</option>`).join('');
    } catch (e) {
        sel.innerHTML = `<option value="">Failed to load — check internet</option>`;
    }
}

async function loadForgeVersions(mcVersion) {
    const forgeSel = document.getElementById('f-forgeVersion');
    if (!forgeSel) return;
    forgeSel.innerHTML = '<option value="">Loading...</option>';
    const versions = await api.invoke('get-forge-versions', mcVersion);
    if (versions.length === 0) {
        forgeSel.innerHTML = '<option value="">No Forge versions for this MC version</option>';
    } else {
        forgeSel.innerHTML = versions.map(v => `<option value="${v.id}">${v.label}</option>`).join('');
    }
}

async function pickFile(fieldId) {
    const file = await api.invoke('select-file', {
        title: 'Select Java Executable',
        filters: [{ name: 'Executable', extensions: ['exe'] }]
    });
    if (file) {
        const el = document.getElementById(`f-${fieldId}`);
        if (el) el.value = file;
    }
}

function validateForm() {
    let ok = true;
    selectedGame.form.forEach(field => {
        if (field.required) {
            const el = document.getElementById(`f-${field.id}`);
            if (!el || !el.value.trim()) {
                if (el) el.style.borderColor = 'var(--error)';
                ok = false;
            } else {
                if (el) el.style.borderColor = '';
            }
        }
    });
    if (!ok) {
        document.getElementById('footerStatus').textContent = 'Fill in all required fields (marked with *)';
    }
    return ok;
}

function collectFormData() {
    formData = {};
    selectedGame.form.forEach(field => {
        const el = document.getElementById(`f-${field.id}`);
        if (el) formData[field.id] = el.value.trim();
    });
}

// ── Step 3: Review ─────────────────────────────────────────────────────────
function buildReview() {
    const table = document.getElementById('reviewTable');
    const rows = [
        ['Game',             selectedGame.displayName],
        ['Install Directory', installDir],
        ['Server Name',      formData.serverName || '—'],
        ['Disk Required',    `~${selectedGame.diskGB} GB`],
    ];

    // Add relevant form fields to review
    selectedGame.form.forEach(f => {
        if (['serverName'].includes(f.id)) return; // already shown
        const val = formData[f.id];
        if (!val) return;
        const display = f.type === 'password' ? '••••••••' : val;
        rows.push([f.label, display]);
    });

    table.innerHTML = rows.map(([k, v]) => `
        <div class="review-row">
            <div class="review-key">${k}</div>
            <div class="review-val">${v}</div>
        </div>`).join('');
}

// ── Step 4: Install ────────────────────────────────────────────────────────
function setupInstallProgress() {
    api.receive('install-progress', ({ stage, percent, message }) => {
        document.getElementById('installStage').textContent = stage.toUpperCase();
        document.getElementById('progressMsg').textContent  = message;
        document.getElementById('progressFill').style.width = `${percent}%`;
    });

    api.receive('install-log', (line) => {
        const log = document.getElementById('installLog');
        log.textContent += line;
        log.scrollTop = log.scrollHeight;
    });
}

async function startInstall() {
    gotoStep(4);
    document.getElementById('installLog').textContent = '';

    const result = await api.invoke('start-install', {
        gameId: selectedGame.id,
        installDir,
        formData,
    });

    if (result.cancelled) {
        gotoStep(3);
        document.getElementById('footerStatus').textContent = 'Installation cancelled.';
        return;
    }

    if (!result.success) {
        document.getElementById('progressMsg').textContent = `Error: ${result.error}`;
        document.getElementById('installStage').textContent = 'FAILED';
        document.getElementById('progressFill').style.background = 'var(--error)';
        document.getElementById('btnNext').textContent = '← Back';
        document.getElementById('btnNext').className = 'btn btn-secondary';
        document.getElementById('btnNext').onclick = () => gotoStep(3);
        return;
    }

    installerResult = result.installerResult || {};
    showComplete();
}

// ── Step 5: Complete ───────────────────────────────────────────────────────
function showComplete() {
    gotoStep(5);

    document.getElementById('completeMsg').textContent =
        `${selectedGame.displayName} has been installed to ${installDir}`;

    const addBtn   = document.getElementById('btnAddToRSM');
    const rsmNote  = document.getElementById('rsmNotice');
    const expBtn   = document.getElementById('btnExportJSON');
    const openBtn  = document.getElementById('btnOpenFolder');
    const startBtn = document.getElementById('btnStartOver');

    if (rsmAvailable) {
        addBtn.style.display = '';
        rsmNote.style.display = 'none';
    } else {
        addBtn.style.display = 'none';
        rsmNote.style.display = '';
    }

    const entry = buildRSMEntry();

    addBtn.onclick = async () => {
        const r = await api.invoke('write-to-rsm', entry);
        if (r && r.success) {
            addBtn.textContent = '✓ Added to RSM';
            addBtn.disabled = true;
        }
    };

    expBtn.onclick = async () => {
        const r = await api.invoke('export-server-json', entry);
        if (r && r.success) {
            expBtn.textContent = `✓ Saved`;
            expBtn.disabled = true;
        }
    };

    openBtn.onclick = () => api.invoke('open-folder', installDir);

    startBtn.onclick = () => {
        selectedGame = null;
        installDir   = '';
        formData     = {};
        installerResult = {};
        document.querySelectorAll('.game-card').forEach(c => c.classList.remove('selected'));
        document.getElementById('installDir').value = '';
        document.getElementById('progressFill').style.width = '0%';
        document.getElementById('progressFill').style.background = '';
        document.getElementById('installLog').textContent = '';
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
        path:              typeof rsm.path === 'function' ? rsm.path(f, dir, ir) : rsm.path,
        workingDir:        typeof rsm.workingDir === 'function' ? rsm.workingDir(f, dir, ir) : rsm.workingDir,
        args:              typeof rsm.args === 'function' ? rsm.args(f, dir, ir) : rsm.args,
        playerListCommand: rsm.playerListCommand || null,
        apiPort:           typeof rsm.apiPort === 'function' ? rsm.apiPort(f, dir, ir) : (rsm.apiPort || ''),
        apiPass:           typeof rsm.apiPass === 'function' ? rsm.apiPass(f, dir, ir) : (rsm.apiPass || ''),
        logPath:           typeof rsm.logPath === 'function' ? rsm.logPath(f, dir, ir) : (rsm.logPath || ''),
        status:            'Offline',
        pid:               null,
        logs:              '',
    };
}
