// Copyright (C) 2026 sognix
// SPDX-License-Identifier: AGPL-3.0-or-later

const $ = (sel) => document.querySelector(sel);

let PROCESSORS = {};
let currentProcessor = null;
let currentMode = "single";
let VIDEO_EXTENSIONS = [];

async function api(path, opts) {
  const res = await fetch(path, opts);
  if (!res.ok) {
    let detail = res.statusText;
    try {
      const body = await res.json();
      detail = body.detail || detail;
    } catch (_) {}
    const err = new Error(detail);
    err.status = res.status;
    throw err;
  }
  const ct = res.headers.get("content-type") || "";
  return ct.includes("application/json") ? res.json() : res.text();
}

// POST JSON; on 409 (output/upload target already exists) ask, then retry with overwrite
async function postWithOverwrite(path, body) {
  const post = (b) =>
    api(path, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(b) });
  try {
    return await post(body);
  } catch (err) {
    if (err.status !== 409 || !confirm(`${err.message}\n\nOverwrite?`)) throw err;
    return post({ ...body, overwrite: true });
  }
}

function showError(message) {
  const el = $("#global-error");
  el.textContent = message;
  el.hidden = false;
}

// ----------------------------------------------------------------- mode

function setMode(mode) {
  currentMode = mode;
  for (const btn of document.querySelectorAll(".mode-btn")) {
    btn.classList.toggle("active", btn.dataset.mode === mode);
  }
  $("#panel-input-single").hidden = mode !== "single";
  $("#panel-input-batch").hidden = mode !== "batch";
  $("#panel-output-single").hidden = mode !== "single";
  // batch picks its GPUs via the checkboxes in step 1 — the single-device dropdown doesn't apply
  $("#device-select-label").hidden = mode === "batch";
  $("#device-panel-title").textContent = mode === "batch" ? "3. Hardware decode" : "3. GPU (Vulkan device)";
  $("#start-btn").textContent = mode === "batch" ? "Start batch" : "Start job";
  updateClipSource();
}

for (const btn of document.querySelectorAll(".mode-btn")) {
  btn.addEventListener("click", () => setMode(btn.dataset.mode));
}

// -------------------------------------------------------------- top tabs

let currentTab = "run";
const TAB_HASHES = { run: "#run", queues: "#status", logs: "#logs" };

function setTopTab(tab) {
  currentTab = tab;
  for (const btn of document.querySelectorAll(".toptab-btn")) {
    btn.classList.toggle("active", btn.dataset.tab === tab);
  }
  $("#tab-run").hidden = tab !== "run";
  $("#tab-queues").hidden = tab !== "queues";
  $("#tab-logs").hidden = tab !== "logs";
  // keep the tab in the URL so a reload/bookmark lands on it again
  if (location.hash !== TAB_HASHES[tab]) history.replaceState(null, "", TAB_HASHES[tab]);
  if (tab === "queues") pollStatus();
  if (tab === "logs") loadLogs();
}

function tabFromHash() {
  return Object.keys(TAB_HASHES).find((tab) => TAB_HASHES[tab] === location.hash) || "run";
}

for (const btn of document.querySelectorAll(".toptab-btn")) {
  btn.addEventListener("click", () => setTopTab(btn.dataset.tab));
}
window.addEventListener("hashchange", () => setTopTab(tabFromHash()));

// ---------------------------------------------------------------- files

async function loadFiles(selectPath) {
  const select = $("#input-select");
  const previous = selectPath || select.value;
  const data = await api("/api/files?root=videos&path=input");
  const files = data.entries.filter((e) => !e.is_dir);
  select.innerHTML = "";
  if (files.length === 0) {
    const opt = document.createElement("option");
    opt.value = "";
    opt.textContent = "(no files uploaded yet)";
    opt.disabled = true;
    opt.selected = true;
    select.appendChild(opt);
    return;
  }
  for (const entry of files) {
    const opt = document.createElement("option");
    opt.value = entry.path;
    opt.textContent = `${entry.name} (${formatBytes(entry.size)})`;
    if (entry.path === previous) opt.selected = true;
    select.appendChild(opt);
  }
  probeSingleInput();
}

function formatBytes(n) {
  if (n == null) return "";
  const units = ["B", "KB", "MB", "GB"];
  let i = 0;
  while (n >= 1024 && i < units.length - 1) {
    n /= 1024;
    i++;
  }
  return `${n.toFixed(1)} ${units[i]}`;
}

$("#upload-btn").addEventListener("click", async () => {
  const input = $("#upload-input");
  if (!input.files.length) return;
  const form = new FormData();
  form.append("file", input.files[0]);
  const url = "/api/files/upload?root=videos&dest_dir=input";
  $("#upload-btn").disabled = true;
  try {
    let result;
    try {
      result = await api(url, { method: "POST", body: form });
    } catch (err) {
      if (err.status !== 409 || !confirm(`${err.message}\n\nOverwrite?`)) throw err;
      result = await api(`${url}&overwrite=true`, { method: "POST", body: form });
    }
    await loadFiles(result.path);
    input.value = "";
  } catch (err) {
    alert(`Upload failed: ${err.message}`);
  } finally {
    $("#upload-btn").disabled = false;
  }
});

$("#refresh-files-btn").addEventListener("click", () => loadFiles().catch((err) => alert(err.message)));

// ------------------------------------------------------------ batch dirs

async function loadBatchDirs() {
  const select = $("#batch-dir-select");
  const previous = select.value;
  const data = await api("/api/files?root=batch&path=");
  select.innerHTML = "";
  const rootOpt = document.createElement("option");
  rootOpt.value = "";
  rootOpt.textContent = "(root) /batch";
  select.appendChild(rootOpt);

  for (const entry of data.entries) {
    if (!entry.is_dir) continue;
    const opt = document.createElement("option");
    opt.value = entry.path;
    opt.textContent = entry.name;
    if (entry.path === previous) opt.selected = true;
    select.appendChild(opt);
  }
  await updateBatchFileCount();
}

async function updateBatchFileCount() {
  const dir = $("#batch-dir-select").value;
  const listEl = $("#batch-file-list");
  try {
    const data = await api(`/api/files?root=batch&path=${encodeURIComponent(dir)}`);
    const files = data.entries.filter((e) => !e.is_dir);
    const isVideo = (name) => VIDEO_EXTENSIONS.includes(name.split(".").pop().toLowerCase());
    const videoCount = files.filter((f) => isVideo(f.name)).length;
    const skipped = files.length - videoCount;
    $("#batch-file-count").textContent =
      `${videoCount} video file(s) in this folder` + (skipped ? ` · ${skipped} other file(s) skipped` : "");

    listEl.innerHTML = "";
    if (files.length === 0) {
      const empty = document.createElement("div");
      empty.className = "empty";
      empty.textContent = "(no files here)";
      listEl.appendChild(empty);
    } else {
      for (const f of files) {
        const row = document.createElement("div");
        row.className = isVideo(f.name) ? "file-row" : "file-row skipped";
        const name = document.createElement("span");
        name.textContent = f.name;
        const size = document.createElement("span");
        size.className = "file-size";
        size.textContent = isVideo(f.name) ? formatBytes(f.size) : "skipped (not a video)";
        row.appendChild(name);
        row.appendChild(size);
        if (isVideo(f.name)) {
          row.dataset.path = f.path;
          row.dataset.name = f.name;
          row.dataset.size = formatBytes(f.size);
          row.addEventListener("click", () => selectBatchClipSource(row));
        }
        listEl.appendChild(row);
      }
      const first = listEl.querySelector(".file-row[data-path]");
      if (first) selectBatchClipSource(first);
    }
    updateClipSource();
    probeBatchFolder(dir);
  } catch (err) {
    $("#batch-file-count").textContent = `error: ${err.message}`;
    listEl.innerHTML = "";
  }
}

$("#batch-dir-select").addEventListener("change", updateBatchFileCount);
$("#refresh-batch-btn").addEventListener("click", () => loadBatchDirs().catch((err) => alert(err.message)));

// ------------------------------------------------------------ processors

function renderProcessorFields() {
  const container = $("#processor-fields");
  container.innerHTML = "";
  const spec = PROCESSORS[currentProcessor];
  if (!spec) return;

  if (spec.description) {
    container.appendChild(makeNote(spec.description));
  }

  if (spec.kind === "simple") {
    for (const [key, field] of Object.entries(spec.fields)) {
      container.appendChild(makeFieldLabel(key, field));
    }
    return;
  }

  if (spec.kind === "model-scale") {
    const models = Object.keys(spec.models);
    const modelLabel = document.createElement("label");
    modelLabel.textContent = "Model";
    const modelSelect = document.createElement("select");
    modelSelect.id = "proc-model";
    for (const m of models) {
      const o = document.createElement("option");
      o.value = m;
      o.textContent = m;
      if (m === spec.default_model) o.selected = true;
      modelSelect.appendChild(o);
    }
    modelLabel.appendChild(modelSelect);
    container.appendChild(modelLabel);
    const modelNote = makeNote(spec.models[modelSelect.value].description || "");
    container.appendChild(modelNote);

    const scaleLabel = document.createElement("label");
    scaleLabel.textContent = "Scaling factor";
    const scaleSelect = document.createElement("select");
    scaleSelect.id = "proc-scale";
    scaleLabel.appendChild(scaleSelect);
    container.appendChild(scaleLabel);

    const refreshScales = () => {
      modelNote.textContent = spec.models[modelSelect.value].description || "";
      const scales = spec.models[modelSelect.value].scales;
      scaleSelect.innerHTML = "";
      for (const s of scales) {
        const o = document.createElement("option");
        o.value = s;
        o.textContent = `${s}x`;
        scaleSelect.appendChild(o);
      }
    };
    modelSelect.addEventListener("change", refreshScales);
    refreshScales();
    return;
  }

  if (spec.kind === "model-scale-noise") {
    const models = Object.keys(spec.models);
    const modelLabel = document.createElement("label");
    modelLabel.textContent = "Model";
    const modelSelect = document.createElement("select");
    modelSelect.id = "proc-model";
    for (const m of models) {
      const o = document.createElement("option");
      o.value = m;
      o.textContent = m;
      if (m === spec.default_model) o.selected = true;
      modelSelect.appendChild(o);
    }
    modelLabel.appendChild(modelSelect);
    container.appendChild(modelLabel);
    const modelNote = makeNote(spec.models[modelSelect.value].description || "");
    container.appendChild(modelNote);

    const scaleLabel = document.createElement("label");
    scaleLabel.textContent = "Scaling factor";
    const scaleSelect = document.createElement("select");
    scaleSelect.id = "proc-scale";
    scaleLabel.appendChild(scaleSelect);
    container.appendChild(scaleLabel);

    const noiseLabel = document.createElement("label");
    noiseLabel.textContent = "Noise level";
    const noiseSelect = document.createElement("select");
    noiseSelect.id = "proc-noise";
    noiseLabel.appendChild(noiseSelect);
    container.appendChild(noiseLabel);

    const refreshNoise = () => {
      const scales = spec.models[modelSelect.value].scales;
      const noises = scales[scaleSelect.value];
      noiseSelect.innerHTML = "";
      for (const n of noises) {
        const o = document.createElement("option");
        o.value = n;
        o.textContent = n;
        noiseSelect.appendChild(o);
      }
    };
    const refreshScales = () => {
      modelNote.textContent = spec.models[modelSelect.value].description || "";
      const scales = spec.models[modelSelect.value].scales;
      scaleSelect.innerHTML = "";
      for (const s of Object.keys(scales)) {
        const o = document.createElement("option");
        o.value = s;
        o.textContent = `${s}x`;
        scaleSelect.appendChild(o);
      }
      refreshNoise();
    };
    modelSelect.addEventListener("change", refreshScales);
    scaleSelect.addEventListener("change", refreshNoise);
    refreshScales();

    for (const [key, field] of Object.entries(spec.extra_fields || {})) {
      container.appendChild(makeFieldLabel(key, field));
    }
    return;
  }
}

function makeNote(text) {
  const note = document.createElement("p");
  note.className = "hint";
  note.textContent = text;
  return note;
}

function wrapWithNote(el, note) {
  const frag = document.createDocumentFragment();
  frag.appendChild(el);
  frag.appendChild(note);
  return frag;
}

function makeFieldLabel(key, field) {
  const label = document.createElement("label");
  let input;
  if (field.type === "enum") {
    input = document.createElement("select");
    for (const opt of field.options) {
      const o = document.createElement("option");
      o.value = opt;
      o.textContent = opt;
      if (opt === field.default) o.selected = true;
      input.appendChild(o);
    }
    input.dataset.key = key;
    input.dataset.field = "1";
    label.textContent = field.label || key;
    label.appendChild(input);
    if (field.option_notes) {
      const note = makeNote(field.option_notes[input.value] || "");
      input.addEventListener("change", () => {
        note.textContent = field.option_notes[input.value] || "";
      });
      return wrapWithNote(label, note);
    }
  } else if (field.type === "bool") {
    input = document.createElement("input");
    input.type = "checkbox";
    input.checked = !!field.default;
    input.dataset.key = key;
    input.dataset.field = "1";
    label.classList.add("checkbox");
    label.appendChild(input);
    label.append(field.label || key);
  } else {
    input = document.createElement("input");
    input.type = "number";
    if (field.default !== undefined) input.value = field.default;
    input.dataset.key = key;
    input.dataset.field = "1";
    label.textContent = field.label || key;
    label.appendChild(input);
  }
  return label;
}

function collectProcessorOptions() {
  const spec = PROCESSORS[currentProcessor];
  const opts = {};

  if (spec.kind === "model-scale" || spec.kind === "model-scale-noise") {
    opts.model = $("#proc-model").value;
    opts.scaling_factor = $("#proc-scale").value;
    if (spec.kind === "model-scale-noise") {
      opts.noise_level = $("#proc-noise").value;
    }
  }

  for (const el of $("#processor-fields").querySelectorAll("[data-field]")) {
    const key = el.dataset.key;
    opts[key] = el.type === "checkbox" ? el.checked : el.value;
  }
  return opts;
}

$("#processor-select").addEventListener("change", (e) => {
  currentProcessor = e.target.value;
  renderProcessorFields();
  renderInputInfo();
});
// scale / size / frame-rate fields change the "→ output" estimate
$("#panel-processor").addEventListener("change", renderInputInfo);
$("#panel-processor").addEventListener("input", renderInputInfo);

// ----------------------------------------------------------- extra opts

$("#add-extra-option-btn").addEventListener("click", () => {
  const tpl = $("#tpl-extra-option").content.cloneNode(true);
  const row = tpl.querySelector(".extra-option");
  row.querySelector(".remove-extra").addEventListener("click", () => row.remove());
  $("#extra-options").appendChild(tpl);
});

function collectExtraOptions() {
  const rows = $("#extra-options").querySelectorAll(".extra-option");
  const result = [];
  for (const row of rows) {
    const key = row.querySelector(".extra-key").value.trim();
    const value = row.querySelector(".extra-value").value.trim();
    if (key) result.push({ key, value });
  }
  return result;
}

// ---------------------------------------------------------------- setup

async function loadMeta() {
  PROCESSORS = await api("/api/meta/processors");
  const processorSelect = $("#processor-select");
  processorSelect.innerHTML = "";
  for (const [key, spec] of Object.entries(PROCESSORS)) {
    const opt = document.createElement("option");
    opt.value = key;
    opt.textContent = spec.label;
    processorSelect.appendChild(opt);
  }
  currentProcessor = Object.keys(PROCESSORS)[0];
  renderProcessorFields();

  const options = await api("/api/meta/options");
  VIDEO_EXTENSIONS = options.video_extensions || [];
  if (options.source_url) {
    const link = document.createElement("a");
    link.href = options.source_url;
    link.target = "_blank";
    link.rel = "noopener";
    link.textContent = "source code (AGPL-3.0)";
    $("#source-link").replaceChildren(link);
  }
  fillSelect("#hwaccel-select", options.hwaccel, "none");
  const hwaccelWarning = $("#hwaccel-warning");
  hwaccelWarning.textContent = "⚠ " + options.hwaccel_warning;
  const updateHwaccelWarning = () => {
    hwaccelWarning.hidden = $("#hwaccel-select").value === "none";
  };
  $("#hwaccel-select").addEventListener("change", updateHwaccelWarning);
  updateHwaccelWarning();

  fillSelect("#loglevel-select", options.log_levels, "info");
  const presetSelect = $("#preset-select");
  for (const p of options.encoder_presets) {
    const o = document.createElement("option");
    o.value = p;
    o.textContent = p;
    presetSelect.appendChild(o);
  }

  try {
    const devices = await api("/api/meta/devices");
    const deviceSelect = $("#device-select");
    deviceSelect.innerHTML = "";
    for (const dev of devices) {
      const o = document.createElement("option");
      o.value = dev.index;
      o.textContent = `${dev.index}: ${dev.name}${dev.type ? " (" + dev.type + ")" : ""}`;
      deviceSelect.appendChild(o);
    }
    if (devices.length === 0) {
      const o = document.createElement("option");
      o.textContent = "(no Vulkan devices detected)";
      deviceSelect.appendChild(o);
    }

    renderBatchDeviceCheckboxes(devices);
  } catch (err) {
    const o = document.createElement("option");
    o.textContent = `error: ${err.message}`;
    $("#device-select").replaceChildren(o);
    $("#batch-devices-list").textContent = `error: ${err.message}`;
  }
}

function renderBatchDeviceCheckboxes(devices) {
  const container = $("#batch-devices-list");
  container.innerHTML = "";
  if (devices.length === 0) {
    container.textContent = "No Vulkan devices detected.";
    return;
  }

  const allLabel = document.createElement("label");
  allLabel.className = "checkbox";
  const allInput = document.createElement("input");
  allInput.type = "checkbox";
  allInput.id = "batch-devices-all";
  allLabel.appendChild(allInput);
  allLabel.append("All");
  container.appendChild(allLabel);

  const deviceInputs = [];
  for (const dev of devices) {
    const label = document.createElement("label");
    label.className = "checkbox";
    const input = document.createElement("input");
    input.type = "checkbox";
    input.value = dev.index;
    input.className = "batch-device-checkbox";
    input.checked = dev.type !== "CPU"; // GPUs on by default, software fallback off by default
    input.addEventListener("change", () => {
      allInput.checked = deviceInputs.every((el) => el.checked);
    });
    label.appendChild(input);
    label.append(`${dev.index}: ${dev.name}${dev.type ? " (" + dev.type + ")" : ""}`);
    container.appendChild(label);
    deviceInputs.push(input);
  }

  allInput.checked = deviceInputs.every((el) => el.checked);
  allInput.addEventListener("change", () => {
    for (const el of deviceInputs) el.checked = allInput.checked;
  });
}

function collectBatchDevices() {
  return Array.from(document.querySelectorAll(".batch-device-checkbox"))
    .filter((el) => el.checked)
    .map((el) => Number(el.value));
}

function fillSelect(sel, values, selected) {
  const el = $(sel);
  el.innerHTML = "";
  for (const v of values) {
    const o = document.createElement("option");
    o.value = v;
    o.textContent = v;
    if (v === selected) o.selected = true;
    el.appendChild(o);
  }
}

// ----------------------------------------------------------------- jobs

const ACTIVE_STATUSES = ["running", "queued"];
const jobCards = new Map();
const jobSockets = new Map();

function jobCard(job) {
  let card = jobCards.get(job.id);
  if (!card) {
    const tpl = $("#tpl-job").content.cloneNode(true);
    card = tpl.querySelector(".job");
    card.dataset.id = job.id;
    const cancelBtn = card.querySelector(".job-cancel");
    cancelBtn.addEventListener("click", async () => {
      cancelBtn.disabled = true;
      try {
        await api(`/api/jobs/${job.id}/cancel`, { method: "POST" });
      } catch (err) {
        alert(`Cancel failed: ${err.message}`);
        cancelBtn.disabled = false;
      }
    });
    card.querySelector(".job-clear").addEventListener("click", async () => {
      try {
        await api(`/api/jobs/${job.id}`, { method: "DELETE" });
        removeJobCard(job.id);
      } catch (err) {
        alert(`Clear failed: ${err.message}`);
      }
    });
    $("#jobs-finished").append(card); // scheduleJobSort() moves it into its group
    jobCards.set(job.id, card);
  }
  updateJobCard(card, job);
  scheduleJobSort();
  return card;
}

// Running jobs on top, then the waiting ones in the order they'll run (in a
// group collapsed by default), then finished ones (newest first). Re-sorted
// whenever a card is added or updated.
const STATUS_RANK = { running: 0, queued: 1 };
let jobSortPending = false;

function compareJobs(a, b) {
  const ra = STATUS_RANK[a.status] ?? 2;
  const rb = STATUS_RANK[b.status] ?? 2;
  if (ra !== rb) return ra - rb;
  if (ra === 0) return (a.started_at || 0) - (b.started_at || 0);
  // waiting: submission order; a batch shares one created_at and runs in file-name order
  if (ra === 1) return a.created_at - b.created_at || a.input_path.localeCompare(b.input_path);
  return (b.finished_at || b.created_at) - (a.finished_at || a.created_at);
}

function scheduleJobSort() {
  if (jobSortPending) return;
  jobSortPending = true;
  requestAnimationFrame(() => {
    jobSortPending = false;
    const groups = { running: [], queued: [], finished: [] };
    for (const card of [...jobCards.values()].sort((a, b) => compareJobs(a.job, b.job))) {
      const status = card.job.status;
      groups[status === "running" || status === "queued" ? status : "finished"].push(card);
    }
    for (const [name, cards] of Object.entries(groups)) {
      const list = $(`#jobs-${name}`);
      // only touch the DOM where the order actually changed (moving nodes resets hover/focus)
      cards.forEach((card, i) => {
        if (list.children[i] !== card) list.insertBefore(card, list.children[i] || null);
      });
    }
    $("#jobs-queued-group").hidden = groups.queued.length === 0;
    $("#jobs-queued-summary").textContent = `${groups.queued.length} waiting`;
    $("#jobs-finished-group").hidden = groups.finished.length === 0;
    $("#jobs-finished-summary").textContent = `${groups.finished.length} finished`;
  });
}

function removeJobCard(jobId) {
  const card = jobCards.get(jobId);
  if (card) card.remove();
  jobCards.delete(jobId);
  scheduleJobSort(); // updates the group counts / hides empty groups
}

function updateJobCard(card, job) {
  const previousStatus = card.dataset.status;
  card.job = job;
  card.dataset.status = job.status;
  card.querySelector(".job-id").textContent = `${job.id} — ${job.input_path} -> ${job.output_path}`;
  const statusEl = card.querySelector(".job-status");
  statusEl.textContent = job.status;
  statusEl.className = `job-status ${job.status}`;
  card.querySelector(".job-progress-bar").style.width = `${job.progress || 0}%`;
  const devicePart =
    (job.batch_name ? `batch ${job.batch_name} · ` : "") + (job.device != null ? `device ${job.device} · ` : "");
  card.querySelector(".job-meta").textContent =
    job.status === "queued"
      ? job.device == null
        ? `${devicePart}waiting in the batch pool — the next free GPU picks it up (see Status tab)`
        : `${devicePart}waiting for the jobs ahead of it on this device (see Status tab)`
      : `${devicePart}frame ${job.frame}/${job.total_frames} · fps ${job.fps || "-"} · elapsed ${job.elapsed || "-"} · remaining ${job.remaining || "-"}`;
  const isActive = ACTIVE_STATUSES.includes(job.status);
  card.querySelector(".job-cancel").disabled = !isActive;
  card.querySelector(".job-clear").disabled = isActive;
  if (job.kind === "clip") renderClipPreview(card, job, previousStatus);
  // progress-only pushes carry no log; keep whatever was shown last
  if (job.log) {
    const logEl = card.querySelector(".job-log");
    const followTail = logEl.scrollHeight - logEl.scrollTop - logEl.clientHeight < 20;
    logEl.textContent = job.log.join("\n");
    if (followTail) logEl.scrollTop = logEl.scrollHeight;
  }
}

function watchJob(jobId) {
  if (jobSockets.has(jobId)) return;
  const proto = location.protocol === "https:" ? "wss" : "ws";
  const ws = new WebSocket(`${proto}://${location.host}/ws/jobs/${jobId}`);
  jobSockets.set(jobId, ws);
  let lastStatus = "running";
  ws.onmessage = (ev) => {
    const job = JSON.parse(ev.data);
    lastStatus = job.status;
    jobCard(job);
  };
  ws.onclose = (ev) => {
    jobSockets.delete(jobId);
    // dropped mid-job (proxy timeout, backend restart, ...) — reconnect; 4004 = job gone
    if (ev.code !== 4004 && ACTIVE_STATUSES.includes(lastStatus) && jobCards.has(jobId)) {
      setTimeout(() => watchJob(jobId), 2000);
    }
  };
}

async function loadJobs() {
  const jobs = await api("/api/jobs");
  // waiting jobs have no log yet — only fetch the detail (with log) for the others
  const details = await Promise.all(
    jobs.map((j) => (j.status === "queued" ? j : api(`/api/jobs/${j.id}`).catch(() => j)))
  );
  syncJobs(details);
}

// Only running jobs get a WebSocket (live progress + log). Everything else —
// waiting jobs, jobs started from another browser, jobs cleared elsewhere — is
// synced from /api/jobs on every status poll. One socket per waiting job would
// hit the browser's WebSocket limit (~255) with a big batch.
function syncJobs(jobs) {
  const ids = new Set();
  for (const job of jobs) {
    ids.add(job.id);
    if (jobSockets.has(job.id)) continue; // the socket delivers fresher data
    const previous = jobCards.get(job.id)?.job;
    jobCard(job);
    if (job.status === "running") {
      watchJob(job.id);
    } else if (previous && previous.status !== job.status && !ACTIVE_STATUSES.includes(job.status)) {
      // finished between two polls without ever getting a socket — fetch its log once
      api(`/api/jobs/${job.id}`).then(jobCard, () => {});
    }
  }
  // finished jobs cleared from another browser; active ones never vanish server-side
  for (const [id, card] of [...jobCards]) {
    if (!ids.has(id) && !ACTIVE_STATUSES.includes(card.dataset.status)) removeJobCard(id);
  }
}

$("#clear-jobs-btn").addEventListener("click", async () => {
  try {
    await api("/api/jobs", { method: "DELETE" });
  } catch (err) {
    alert(`Clear failed: ${err.message}`);
    return;
  }
  for (const [id, card] of jobCards) {
    if (!ACTIVE_STATUSES.includes(card.dataset.status)) removeJobCard(id);
  }
});

// --------------------------------------------------------------- status

// /api/queues is polled on every tab (faster while the Status tab is shown,
// slower in the background) so the page title and notifications stay current.
// Device cards and batch rows are kept across polls and only patched, so a
// collapsed card, the scroll position and a half-finished click on Cancel
// survive the refresh.
const deviceCards = new Map(); // device index -> { card, info, body, key, runningItem }
const batchRows = new Map(); // batch id -> { row, text, bar, cancelBtn, waiting, waitingKey }
// waiting / recently-finished lists on the Status tab start collapsed; remember which
// ones were opened (keyed "dev:<index>" / "batch:<id>" / "recent:<index>") since the
// lists get rebuilt when jobs move
const openWaitingLists = new Set();

function waitingGroup(key, count, label) {
  const group = document.createElement("details");
  group.className = "waiting-group";
  group.open = openWaitingLists.has(key);
  group.addEventListener("toggle", () => {
    if (group.open) openWaitingLists.add(key);
    else openWaitingLists.delete(key);
  });
  const summary = document.createElement("summary");
  summary.textContent = `${count} ${label}`;
  group.appendChild(summary);
  return group;
}
const COLLAPSED_KEY = "video2x.collapsedDevices";
const collapsedDevices = new Set(loadCollapsedDevices());
const BASE_TITLE = document.title;
let statusLoading = false;
let statusTimer = null;

function loadCollapsedDevices() {
  try {
    return JSON.parse(localStorage.getItem(COLLAPSED_KEY)) || [];
  } catch (_) {
    return [];
  }
}

function saveCollapsedDevices() {
  try {
    localStorage.setItem(COLLAPSED_KEY, JSON.stringify([...collapsedDevices]));
  } catch (_) {}
}

function formatDuration(seconds) {
  if (seconds == null) return "?";
  seconds = Math.round(seconds);
  if (seconds < 60) return `${seconds} s`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes} min`;
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return m ? `${h} h ${m} min` : `${h} h`;
}

function formatClock(timestamp) {
  return new Date(timestamp * 1000).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

function baseName(path) {
  return path.split("/").pop();
}

async function pollStatus() {
  if (!statusLoading) {
    statusLoading = true;
    try {
      const [data, jobs] = await Promise.all([api("/api/queues"), api("/api/jobs")]);
      syncJobs(jobs);
      updateTitle(data);
      checkNotifications(data);
      if (currentTab === "queues") renderStatus(data);
    } catch (err) {
      if (currentTab === "queues") setQueuesMessage(`error: ${err.message}`);
    } finally {
      statusLoading = false;
    }
  }
  // cleared right before re-arming, so overlapping calls never leave two timer chains running
  clearTimeout(statusTimer);
  const delay = document.hidden ? 10000 : currentTab === "queues" ? 2000 : 5000;
  statusTimer = setTimeout(pollStatus, delay);
}

document.addEventListener("visibilitychange", () => {
  if (!document.hidden) pollStatus();
});

function renderStatus(data) {
  renderOverview(data.summary);
  renderBatches(data.batches);
  renderDevices(data.devices);
}

function renderOverview(summary) {
  const el = $("#overview-text");
  if (summary.running === 0 && summary.queued === 0) {
    el.textContent = "All devices idle.";
    return;
  }
  const eta = summary.eta_seconds != null ? `all done in ~${formatDuration(summary.eta_seconds)}` : "time left unknown";
  const pool = summary.pool ? ` (${summary.pool} in batch pool)` : "";
  el.textContent = `${summary.running} running · ${summary.queued} waiting${pool} · ${eta}`;
}

function updateTitle(data) {
  const { running, queued } = data.summary;
  if (running === 0 && queued === 0) {
    document.title = BASE_TITLE;
    return;
  }
  // just counts — a single percentage over several jobs of different length means nothing
  const parts = running ? [`${running} running`] : [];
  if (queued) parts.push(`${queued} waiting`);
  document.title = `(${parts.join(" · ")}) ${BASE_TITLE}`;
}

// ---------------------------------------------------------------- batches

function renderBatches(batches) {
  $("#batches-panel").hidden = batches.length === 0;
  const list = $("#batches-list");
  const seen = new Set();
  batches.forEach((batch, i) => {
    seen.add(batch.id);
    let entry = batchRows.get(batch.id);
    if (!entry) {
      entry = createBatchRow(batch);
      batchRows.set(batch.id, entry);
    }
    updateBatchRow(entry, batch);
    if (list.children[i] !== entry.row) list.insertBefore(entry.row, list.children[i] || null);
  });
  for (const [id, entry] of batchRows) {
    if (!seen.has(id)) {
      entry.row.remove();
      batchRows.delete(id);
    }
  }
}

function createBatchRow(batch) {
  const row = document.createElement("div");
  row.className = "batch-row";

  const header = document.createElement("div");
  header.className = "queue-item-header";
  const name = document.createElement("span");
  name.className = "queue-item-name";
  name.textContent = `${batch.name} · ${formatClock(batch.created_at)}`;
  const pct = document.createElement("span");
  pct.className = "queue-item-state";
  header.append(name, pct);

  const bar = document.createElement("div");
  bar.className = "job-progress";
  const inner = document.createElement("div");
  inner.className = "job-progress-bar";
  bar.appendChild(inner);

  const text = document.createElement("div");
  text.className = "job-meta";

  const cancelBtn = document.createElement("button");
  cancelBtn.type = "button";
  cancelBtn.className = "job-cancel secondary";
  cancelBtn.textContent = "Cancel batch";
  cancelBtn.addEventListener("click", async () => {
    const left = Number(cancelBtn.dataset.left);
    if (!confirm(`Cancel the ${left} unfinished job(s) of ${batch.name}?`)) return;
    cancelBtn.disabled = true;
    try {
      await api(`/api/batches/${batch.id}/cancel`, { method: "POST" });
    } catch (err) {
      alert(`Cancel failed: ${err.message}`);
      cancelBtn.disabled = false;
    }
    pollStatus();
  });

  const waiting = document.createElement("div");
  row.append(header, bar, text, waiting, cancelBtn);
  return { row, pct, bar: inner, text, cancelBtn, waiting, waitingKey: null };
}

function updateBatchRow(entry, batch) {
  const finished = batch.done + batch.error + batch.cancelled;
  const left = batch.queued + batch.running;
  entry.pct.textContent = left ? `${batch.progress.toFixed(1)}%` : "finished";
  entry.bar.style.width = `${batch.progress}%`;
  entry.bar.classList.toggle("has-error", batch.error > 0);

  const parts = [`${finished}/${batch.total} finished`];
  if (batch.running) parts.push(`${batch.running} running`);
  if (batch.queued) parts.push(`${batch.queued} waiting in pool`);
  if (batch.error) parts.push(`${batch.error} failed`);
  if (batch.cancelled) parts.push(`${batch.cancelled} cancelled`);
  if (batch.devices.length) parts.push(`GPU ${batch.devices.join(", ")}`);
  if (left) parts.push(`~${formatDuration(batch.eta_seconds)} left`);
  entry.text.textContent = parts.join(" · ");

  entry.cancelBtn.hidden = left === 0;
  entry.cancelBtn.dataset.left = left;

  const waitingKey = batch.waiting.map((j) => j.id).join(",");
  if (waitingKey !== entry.waitingKey) {
    entry.waitingKey = waitingKey;
    entry.waiting.replaceChildren();
    if (batch.waiting.length) {
      const group = waitingGroup(`batch:${batch.id}`, batch.waiting.length, "waiting in pool");
      batch.waiting.forEach((job, i) => group.appendChild(renderQueueItem(job, "queued", i + 1)));
      entry.waiting.appendChild(group);
    }
  }
}

// ---------------------------------------------------------------- devices

function setQueuesMessage(text) {
  const p = document.createElement("p");
  p.className = "hint queues-message";
  p.textContent = text;
  $("#queues-list").replaceChildren(p);
  deviceCards.clear();
}

function renderDevices(devices) {
  const container = $("#queues-list");
  if (devices.length === 0) {
    setQueuesMessage("No Vulkan devices detected.");
    return;
  }
  container.querySelector(".queues-message")?.remove();

  const seen = new Set();
  devices.forEach((dev, i) => {
    seen.add(dev.index);
    let entry = deviceCards.get(dev.index);
    if (!entry) {
      entry = createDeviceCard(dev);
      deviceCards.set(dev.index, entry);
    }
    updateDeviceCard(entry, dev);
    if (container.children[i] !== entry.card) container.insertBefore(entry.card, container.children[i] || null);
  });
  for (const [index, entry] of deviceCards) {
    if (!seen.has(index)) {
      entry.card.remove();
      deviceCards.delete(index);
    }
  }
}

function createDeviceCard(dev) {
  const card = document.createElement("details");
  card.className = "device-card";
  card.open = !collapsedDevices.has(dev.index);

  const summary = document.createElement("summary");
  const title = document.createElement("h3");
  title.textContent = `${dev.index}: ${dev.name} `;
  if (dev.type) {
    const span = document.createElement("span");
    span.className = "device-type";
    span.textContent = `(${dev.type})`;
    title.appendChild(span);
  }
  const info = document.createElement("span");
  info.className = "device-summary";
  summary.append(title, info);

  const body = document.createElement("div");
  body.className = "device-body";
  card.append(summary, body);

  card.addEventListener("toggle", () => {
    if (card.open) collapsedDevices.delete(dev.index);
    else collapsedDevices.add(dev.index);
    saveCollapsedDevices();
  });
  return { card, info, body, key: null, runningItem: null };
}

function updateDeviceCard(entry, dev) {
  const waiting = dev.queued.length;
  const parts = [dev.running ? `running ${(dev.running.progress || 0).toFixed(1)}%` : "idle"];
  if (waiting) parts.push(`${waiting} waiting`);
  entry.info.textContent = parts.join(" · ");

  // only rebuild the list when its jobs changed; otherwise just patch progress
  const key = [
    dev.running ? dev.running.id : "",
    ...dev.queued.map((j) => j.id),
    ...dev.recent.map((j) => j.id),
  ].join(",");
  if (key === entry.key) {
    if (dev.running) updateQueueItem(entry.runningItem, dev.running, "running");
    return;
  }
  entry.key = key;
  entry.runningItem = null;
  entry.body.replaceChildren();

  if (dev.running) {
    entry.runningItem = renderQueueItem(dev.running, "running");
    entry.body.appendChild(entry.runningItem);
  } else {
    const empty = document.createElement("p");
    empty.className = "queue-empty";
    empty.textContent = "Idle — nothing running.";
    entry.body.appendChild(empty);
  }

  if (waiting > 0) {
    const group = waitingGroup(`dev:${dev.index}`, waiting, "waiting");
    dev.queued.forEach((job, i) => group.appendChild(renderQueueItem(job, "queued", i + 1)));
    entry.body.appendChild(group);
  }

  const activeCount = (dev.running ? 1 : 0) + waiting;
  if (activeCount > 1) {
    const cancelAll = document.createElement("button");
    cancelAll.type = "button";
    cancelAll.className = "job-cancel secondary cancel-all";
    cancelAll.textContent = `Cancel all ${activeCount} on this GPU`;
    cancelAll.addEventListener("click", async () => {
      if (!confirm(`Cancel the running job and all ${waiting} waiting on ${dev.name}?`)) return;
      cancelAll.disabled = true;
      try {
        await api(`/api/devices/${dev.index}/cancel`, { method: "POST" });
      } catch (err) {
        alert(`Cancel failed: ${err.message}`);
        cancelAll.disabled = false;
      }
      pollStatus();
    });
    entry.body.appendChild(cancelAll);
  }

  if (dev.recent.length > 0) {
    const group = waitingGroup(`recent:${dev.index}`, dev.recent.length, "recently finished");
    group.classList.add("recent-group");
    for (const job of dev.recent) group.appendChild(renderRecentItem(job));
    entry.body.appendChild(group);
  }
}

function renderRecentItem(job) {
  const row = document.createElement("div");
  row.className = "recent-item";
  const name = document.createElement("span");
  name.className = "queue-item-name";
  name.textContent = baseName(job.input_path);
  const info = document.createElement("span");
  info.className = `job-status ${job.status}`;
  const duration = job.started_at && job.finished_at ? ` · ${formatDuration(job.finished_at - job.started_at)}` : "";
  const when = job.finished_at ? ` · ${formatClock(job.finished_at)}` : "";
  info.textContent = `${job.status}${duration}${when}`;
  row.append(name, info);
  return row;
}

function renderQueueItem(job, kind, position) {
  const item = document.createElement("div");
  item.className = "queue-item";

  const header = document.createElement("div");
  header.className = "queue-item-header";
  const left = document.createElement("span");
  left.className = "queue-item-name";
  left.textContent = position ? `#${position} ${job.input_path}` : job.input_path;
  const right = document.createElement("span");
  right.className = "queue-item-state";
  header.append(left, right);
  item.appendChild(header);

  if (kind === "running") {
    const bar = document.createElement("div");
    bar.className = "job-progress";
    const inner = document.createElement("div");
    inner.className = "job-progress-bar";
    bar.appendChild(inner);
    const meta = document.createElement("div");
    meta.className = "job-meta";
    item.append(bar, meta);
  }

  const cancelBtn = document.createElement("button");
  cancelBtn.type = "button";
  cancelBtn.className = "job-cancel secondary";
  cancelBtn.textContent = "Cancel";
  cancelBtn.addEventListener("click", async () => {
    cancelBtn.disabled = true;
    try {
      await api(`/api/jobs/${job.id}/cancel`, { method: "POST" });
    } catch (err) {
      alert(`Cancel failed: ${err.message}`);
      cancelBtn.disabled = false;
    }
    pollStatus();
  });
  item.appendChild(cancelBtn);

  updateQueueItem(item, job, kind);
  return item;
}

function updateQueueItem(item, job, kind) {
  const state = item.querySelector(".queue-item-state");
  if (job.status === "cancelled") {
    state.textContent = "cancelling…";
    item.querySelector(".job-cancel").disabled = true;
  } else {
    state.textContent = kind === "running" ? `${(job.progress || 0).toFixed(1)}% · fps ${job.fps || "-"}` : "waiting";
  }
  if (kind === "running") {
    item.querySelector(".job-progress-bar").style.width = `${job.progress || 0}%`;
    item.querySelector(".job-meta").textContent =
      `frame ${job.frame}/${job.total_frames} · elapsed ${job.elapsed || "-"} · remaining ${job.remaining || "-"}`;
  }
}

// ---------------------------------------------------------- notifications

// Single jobs notify on their own; batch jobs only once, when the whole batch is through.
// The first poll only records what's already there, so a reload doesn't re-announce old results.
const seenFinished = new Set();
const activeBatches = new Set();
let notificationsSeeded = false;

function notificationsSupported() {
  // browsers only allow notifications on https:// or localhost
  return typeof window.Notification === "function" && window.isSecureContext;
}

function updateNotifyButton() {
  $("#notify-btn").hidden = !notificationsSupported() || Notification.permission !== "default";
}

function requestNotifications() {
  // never let this get in the way of whatever triggered it (e.g. starting a job)
  try {
    if (!notificationsSupported() || Notification.permission !== "default") return;
    Notification.requestPermission().then(updateNotifyButton, updateNotifyButton);
  } catch (_) {}
}

$("#notify-btn").addEventListener("click", requestNotifications);

function notify(title, body) {
  if (!notificationsSupported() || Notification.permission !== "granted") return;
  if (!document.hidden && document.hasFocus()) return; // user is looking at the page anyway
  try {
    new Notification(title, { body, icon: "favicon.png" });
  } catch (_) {}
}

function checkNotifications(data) {
  for (const dev of data.devices) {
    for (const job of dev.recent) {
      if (seenFinished.has(job.id)) continue;
      seenFinished.add(job.id);
      if (!notificationsSeeded || job.batch_id || job.status === "cancelled") continue;
      notify(job.status === "done" ? "Job finished" : "Job failed", baseName(job.input_path));
    }
  }

  for (const batch of data.batches) {
    const active = batch.queued + batch.running > 0;
    if (active) {
      activeBatches.add(batch.id);
    } else if (activeBatches.delete(batch.id) && notificationsSeeded && batch.done + batch.error > 0) {
      const parts = [`${batch.done} done`];
      if (batch.error) parts.push(`${batch.error} failed`);
      if (batch.cancelled) parts.push(`${batch.cancelled} cancelled`);
      notify(`Batch ${batch.name} finished`, parts.join(" · "));
    }
  }
  notificationsSeeded = true;
}

// ----------------------------------------------------------- video info

// ffprobe results for the selected single file, or for the whole batch folder.
let singleInfo = null;
let batchInfos = null;

function formatClockDuration(seconds) {
  if (!seconds) return "?";
  seconds = Math.round(seconds);
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = String(seconds % 60).padStart(2, "0");
  return h ? `${h}:${String(m).padStart(2, "0")}:${s}` : `${m}:${s}`;
}

function describeVideo(info) {
  if (!info) return "";
  if (info.error) return info.error;
  const parts = [`${info.width}×${info.height}`];
  if (info.fps) parts.push(`${info.fps} fps`);
  parts.push(formatClockDuration(info.duration));
  if (info.codec) parts.push(info.codec);
  return parts.join(" · ");
}

function processorField(key) {
  return $(`#processor-fields [data-key="${key}"]`);
}

// what the current processor settings turn a video like this into
function estimateOutput(info) {
  if (!info || info.error || !info.width) return "";
  if (currentProcessor === "libplacebo") {
    const w = processorField("width")?.value;
    const h = processorField("height")?.value;
    return w && h ? `→ ${w}×${h}` : "";
  }
  if (currentProcessor === "rife") {
    const mul = Number(processorField("frame_rate_mul")?.value);
    return info.fps && mul ? `→ ${Math.round(info.fps * mul * 1000) / 1000} fps` : "";
  }
  const scale = Number($("#proc-scale")?.value);
  return scale ? `→ ${info.width * scale}×${info.height * scale}` : "";
}

function renderInputInfo() {
  $("#input-info").textContent = singleInfo ? `${describeVideo(singleInfo)} ${estimateOutput(singleInfo)}`.trim() : "";
  renderBatchSummary();
}

async function probeSingleInput() {
  const path = $("#input-select").value;
  singleInfo = null;
  renderInputInfo();
  updateClipSource();
  if (!path) return;
  try {
    const info = await api(`/api/probe?root=videos&path=${encodeURIComponent(path)}`);
    if ($("#input-select").value === path) singleInfo = info;
  } catch (err) {
    singleInfo = { error: err.message };
  }
  renderInputInfo();
}

$("#input-select").addEventListener("change", probeSingleInput);

async function probeBatchFolder(dir) {
  batchInfos = null;
  renderBatchSummary();
  let data;
  try {
    data = await api(`/api/probe?root=batch&path=${encodeURIComponent(dir)}`);
  } catch (_) {
    return;
  }
  if ($("#batch-dir-select").value !== dir) return; // folder changed meanwhile
  batchInfos = data.files;
  const byName = new Map(data.files.map((f) => [f.name, f]));
  for (const row of $("#batch-file-list").querySelectorAll(".file-row[data-path]")) {
    const info = byName.get(row.dataset.name);
    if (!info) continue;
    const text = info.error ? info.error : `${info.width}×${info.height} · ${formatClockDuration(info.duration)}`;
    row.querySelector(".file-size").textContent = `${text} · ${row.dataset.size}`;
  }
  renderBatchSummary();
}

// "total 27:21:10 · 1920×1080 → 3840×2160" under the batch file count
function renderBatchSummary() {
  let el = $("#batch-probe-summary");
  if (!el) {
    el = document.createElement("p");
    el.id = "batch-probe-summary";
    el.className = "hint";
    $("#batch-file-count").after(el);
  }
  const ok = (batchInfos || []).filter((f) => !f.error && f.width);
  if (ok.length === 0) {
    el.textContent = "";
    return;
  }
  const total = ok.reduce((sum, f) => sum + (f.duration || 0), 0);
  // most common resolution stands for the batch
  const counts = new Map();
  for (const f of ok) counts.set(`${f.width}×${f.height}`, (counts.get(`${f.width}×${f.height}`) || 0) + 1);
  const [res, n] = [...counts.entries()].sort((a, b) => b[1] - a[1])[0];
  const sample = ok.find((f) => `${f.width}×${f.height}` === res);
  const mixed = n < ok.length ? ` (${ok.length - n} file(s) differ)` : "";
  el.textContent = `total ${formatClockDuration(total)} · ${res} ${estimateOutput(sample)}${mixed}`;
}

// ---------------------------------------------------------- preview clip

let batchClipRow = null;

function selectBatchClipSource(row) {
  if (batchClipRow) batchClipRow.classList.remove("selected");
  batchClipRow = row;
  row.classList.add("selected");
  updateClipSource();
}

function clipSource() {
  if (currentMode === "single") {
    const path = $("#input-select").value;
    return path ? { root: "videos", input_path: path } : null;
  }
  const dir = $("#batch-dir-select").value;
  if (!batchClipRow || !batchClipRow.isConnected) return null;
  return { root: "batch", input_path: batchClipRow.dataset.path, dir };
}

function updateClipSource() {
  const src = clipSource();
  $("#clip-source").textContent = src
    ? `Clip from: ${src.root === "videos" ? "/videos/" : "/batch/"}${src.input_path}`
    : "Select an input file first.";
  $("#clip-btn").disabled = !src;
}

$("#clip-btn").addEventListener("click", async () => {
  const src = clipSource();
  if (!src) return;
  const shared = collectSharedOptions();
  if (currentMode === "batch") {
    const devices = collectBatchDevices();
    if (devices.length === 0) {
      alert("Select at least one GPU");
      return;
    }
    shared.device = devices[0];
  }
  $("#clip-btn").disabled = true;
  try {
    const job = await api("/api/clips", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        ...shared,
        root: src.root,
        input_path: src.input_path,
        start: Number($("#clip-start").value) || 0,
        duration: Number($("#clip-duration").value) || 10,
      }),
    });
    jobCard(job);
    pollStatus();
    jobCards.get(job.id)?.scrollIntoView({ behavior: "smooth", block: "center" });
  } catch (err) {
    alert(`Could not create the preview clip: ${err.message}`);
  } finally {
    updateClipSource();
  }
});

function renderClipPreview(card, job, previousStatus) {
  const box = card.querySelector(".job-preview");
  if (job.status !== "done" || box.childElementCount) return;
  // a clip that just finished lands in the (collapsed) "finished" group — open it so
  // the result is visible right away; clips that were already done at page load don't
  if (ACTIVE_STATUSES.includes(previousStatus)) {
    $("#jobs-finished-group").open = true;
    requestAnimationFrame(() => card.scrollIntoView({ behavior: "smooth", block: "center" }));
  }
  const video = document.createElement("video");
  video.controls = true;
  video.loop = true;
  video.preload = "metadata";
  video.src = `/api/clips/${job.id}`;
  const note = document.createElement("p");
  note.className = "hint";
  note.textContent =
    "Video only — preview clips have no sound on purpose (many source audio formats don't play in browsers). The real job keeps the audio.";
  box.append(video, note);
  box.hidden = false;
}

// ------------------------------------------------------------------ logs

async function loadLogs() {
  const list = $("#logs-list");
  let data;
  try {
    data = await api("/api/logs");
  } catch (err) {
    $("#logs-info").textContent = `error: ${err.message}`;
    return;
  }
  const total = data.files.reduce((sum, f) => sum + f.size, 0);
  $("#logs-info").textContent =
    `${data.files.length} log file(s) in ${data.dir} · ${formatBytes(total)}` +
    (data.writable ? "" : ` — ⚠ ${data.dir} is not writable for the app, so no new logs can be written there`);
  $("#logs-info").classList.toggle("warning", !data.writable);
  $("#logs-clear-btn").disabled = data.files.every((f) => f.active);

  list.replaceChildren();
  if (data.files.length === 0) {
    const empty = document.createElement("p");
    empty.className = "hint";
    empty.textContent = "No log files.";
    list.appendChild(empty);
    return;
  }
  for (const file of data.files) list.appendChild(renderLogRow(file));
}

function renderLogRow(file) {
  const row = document.createElement("div");
  row.className = "log-row";

  const name = document.createElement("div");
  name.className = "queue-item-name log-name";
  name.textContent = file.name;
  const meta = document.createElement("div");
  meta.className = "job-meta";
  const when = new Date(file.mtime * 1000).toLocaleString([], { dateStyle: "short", timeStyle: "short" });
  meta.textContent = `${when} · ${formatBytes(file.size)}` + (file.active ? " · job still running" : "");

  const actions = document.createElement("div");
  actions.className = "job-actions";
  const view = document.createElement("button");
  view.type = "button";
  view.className = "secondary";
  view.textContent = "View";
  view.addEventListener("click", () => viewLog(file.name));
  const del = document.createElement("button");
  del.type = "button";
  del.className = "job-cancel secondary";
  del.textContent = "Delete";
  del.disabled = file.active;
  del.addEventListener("click", async () => {
    if (!confirm(`Delete ${file.name}?`)) return;
    try {
      await api(`/api/logs/${encodeURIComponent(file.name)}`, { method: "DELETE" });
      if ($("#log-view-title").textContent === file.name) closeLogView();
    } catch (err) {
      alert(`Delete failed: ${err.message}`);
    }
    loadLogs();
  });
  actions.append(view, del);

  row.append(name, meta, actions);
  return row;
}

async function viewLog(name) {
  try {
    const text = await api(`/api/logs/${encodeURIComponent(name)}`);
    $("#log-view-title").textContent = name;
    $("#log-view").textContent = text;
    $("#log-view-panel").hidden = false;
    $("#log-view-panel").scrollIntoView({ behavior: "smooth", block: "start" });
  } catch (err) {
    alert(`Could not open the log: ${err.message}`);
  }
}

function closeLogView() {
  $("#log-view-panel").hidden = true;
  $("#log-view-title").textContent = "";
  $("#log-view").textContent = "";
}

$("#log-view-close").addEventListener("click", closeLogView);
$("#logs-refresh-btn").addEventListener("click", loadLogs);
$("#logs-clear-btn").addEventListener("click", async () => {
  if (!confirm("Delete all log files? Logs of jobs that are still running are kept.")) return;
  try {
    await api("/api/logs", { method: "DELETE" });
  } catch (err) {
    alert(`Delete failed: ${err.message}`);
  }
  closeLogView();
  loadLogs();
});

// ---------------------------------------------------------------- start

function collectSharedOptions() {
  return {
    processor: currentProcessor,
    options: collectProcessorOptions(),
    device: Number($("#device-select").value) || 0,
    hwaccel: $("#hwaccel-select").value,
    log_level: $("#loglevel-select").value,
    benchmark: $("#benchmark-input").checked,
    no_copy_streams: $("#no-copy-streams-input").checked,
    codec: $("#codec-input").value || "libx264",
    crf: $("#crf-input").value ? Number($("#crf-input").value) : null,
    preset: $("#preset-select").value || null,
    bit_rate: $("#bitrate-input").value ? Number($("#bitrate-input").value) : null,
    extra_encoder_options: collectExtraOptions(),
  };
}

$("#start-btn").addEventListener("click", async () => {
  requestNotifications(); // needs a user gesture — starting a job is the natural moment to ask
  $("#start-btn").disabled = true;
  try {
    if (currentMode === "single") {
      const inputPath = $("#input-select").value;
      if (!inputPath) {
        alert("Select an input file first");
        return;
      }
      const outputName = $("#output-name-input").value.trim();
      if (!outputName) {
        alert("Enter an output filename");
        return;
      }
      const body = { input_path: inputPath, output_name: outputName, ...collectSharedOptions() };
      const job = await postWithOverwrite("/api/jobs", body);
      jobCard(job);
      pollStatus(); // picks the job up (and opens its socket) as soon as it runs
    } else {
      const inputDir = $("#batch-dir-select").value;
      const outputExt = $("#batch-ext-select").value;
      const devices = collectBatchDevices();
      if (devices.length === 0) {
        alert("Select at least one GPU for the batch");
        return;
      }
      const body = {
        input_dir: inputDir,
        output_ext: outputExt,
        devices,
        move_done: $("#batch-move-done").checked,
        ...collectSharedOptions(),
      };
      const result = await postWithOverwrite("/api/batch/jobs", body);
      for (const job of result.jobs) jobCard(job);
      pollStatus();
    }
  } catch (err) {
    alert(`Could not start: ${err.message}`);
  } finally {
    $("#start-btn").disabled = false;
  }
});

(async function init() {
  // each step on its own, so one failing request doesn't leave the rest of the page empty
  const steps = [
    ["load processors/options/devices", loadMeta],
    ["list input files", () => loadFiles()],
    ["list batch folders", loadBatchDirs],
    ["load jobs", loadJobs],
  ];
  const failures = [];
  for (const [what, step] of steps) {
    try {
      await step();
    } catch (err) {
      failures.push(`Could not ${what}: ${err.message}`);
    }
  }
  if (failures.length) showError(failures.join("\n"));
  setTopTab(tabFromHash());
  updateNotifyButton();
  pollStatus();
})();
