// app.js - Video Enhancement 工具箱前端逻辑（免构建 Vue 3 Composition API）
const { createApp, ref, reactive, computed, onMounted } = Vue;

createApp({
  setup() {
    const modes = [
      { key: 'upscale', label: '超分' },
      { key: 'interp', label: '补帧 60/45' },
      { key: 'interp120', label: '补帧 120' },
      { key: 'resize', label: '缩放' },
    ];
    const MODE_LABEL = Object.fromEntries(modes.map(m => [m.key, m.label]));
    const STATUS_LABEL = { done: '完成', error: '失败', cancelled: '已取消', running: '运行中', pending: '排队' };

    const mode = ref('upscale');
    const path = ref('');
    const probe = ref(null);
    const probeWarn = ref('');
    const probeError = ref('');
    const opts = reactive({
      scale: 2, model: 'realesr-animevideov3', want60: true, want45: true,
      resizeW: 1920, resizeH: 1080, chunk: null, crf: 18,
    });
    const running = ref(false);
    const stage = ref('');
    const progress = ref(null);
    const logs = ref([]);
    const showLogs = ref(false);
    const elapsed = ref(0);
    const result = ref(null);
    const jobError = ref('');
    const startError = ref('');
    const busy = ref(false);
    const recentJobs = ref([]);
    const gpu = ref('');
    const browseVisible = ref(false);
    const browseData = ref(null);
    const browsePathInput = ref('');
    const browseError = ref('');
    const models = ref([]);
    const faceEnhance = ref(false);
    const modelDlState = ref(null);
    const modelDlError = ref('');

    let es = null, jobId = null, timer = null, startedAt = null, finished = false, esFailures = 0;
    let modelDlTimer = null;

    const canRun = computed(() => !running.value && !!path.value && !!probe.value && !probeError.value && modelOk.value);
    const selectedModel = computed(() => models.value.find(m => m.name === opts.model) || null);
    const modelOk = computed(() => mode.value !== 'upscale' || !selectedModel.value || selectedModel.value.downloaded);
    const modelDlActive = computed(() => !!modelDlState.value && modelDlState.value.state === 'running');
    const modelDlPct = computed(() => {
      const s = modelDlState.value;
      if (!s || !s.total) return null;
      return Math.max(0, Math.min(100, s.received / s.total * 100));
    });
    const fmtDlProgress = computed(() => {
      const s = modelDlState.value;
      if (!s) return '';
      const got = (s.received / 1048576).toFixed(1);
      return s.total ? `已下载 ${got} / ${(s.total / 1048576).toFixed(1)} MB` : `已下载 ${got} MB`;
    });
    const selMbText = computed(() => selectedModel.value && selectedModel.value.mb ? selectedModel.value.mb + 'MB' : '—');
    const selZipMbText = computed(() => selectedModel.value && selectedModel.value.zip_mb ? selectedModel.value.zip_mb + 'MB' : '—');
    const pct = computed(() =>
      progress.value && progress.value.percent != null
        ? Math.max(0, Math.min(100, progress.value.percent * 100))
        : null);
    const progressText = computed(() => (progress.value && progress.value.text) || stage.value || '准备中…');

    async function api(method, url, body) {
      const r = await fetch(url, {
        method,
        headers: body ? { 'Content-Type': 'application/json' } : undefined,
        body: body ? JSON.stringify(body) : undefined,
      });
      let j = {};
      try { j = await r.json(); } catch (e) { /* ignore */ }
      if (!r.ok) throw new Error(j.error || ('请求失败 ' + r.status));
      return j;
    }

    function pathDir(p) { const i = p.lastIndexOf('\\'); return i > 0 ? p.slice(0, i) : null; }

    async function doProbe(p) {
      probeWarn.value = ''; probeError.value = '';
      if (!p) { probe.value = null; return; }
      try {
        probe.value = await api('POST', '/api/probe', { path: p });
        const fps = probe.value.fps;
        if (mode.value === 'interp120' && fps && Math.abs(fps - 60) > 8) {
          probeWarn.value = '提示：输入帧率约 ' + fps + 'fps，补帧120 建议输入 60fps 的视频。';
        }
      } catch (e) { probe.value = null; probeError.value = e.message; }
    }

    function probePath() { if (path.value) doProbe(path.value); }

    function selectMode(k) {
      mode.value = k;
      if (path.value && !probe.value) doProbe(path.value);
    }

    function joinPath(base, name) {
      if (!base) return name;
      return (base.endsWith('\\') || base.endsWith('/') ? base : base + '\\') + name;
    }

    async function browseGo(p) {
      browseError.value = '';
      const url = '/api/browse' + (p ? '?path=' + encodeURIComponent(p) : '');
      try { browseData.value = await api('GET', url); }
      catch (e) { browseError.value = e.message; browseData.value = null; }
    }

    function browseHome() { browseGo(null); }

    function openBrowse() {
      browseData.value = null;
      browseVisible.value = true;
      browseGo(path.value ? pathDir(path.value) : null);
    }

    function pickFile(p) {
      path.value = p;
      browseVisible.value = false;
      doProbe(p);
    }

    async function loadModels() {
      try {
        const r = await api('GET', '/api/models');
        models.value = r.models || [];
        if (mode.value === 'upscale' && !models.value.some(m => m.name === opts.model)) {
          const dl = models.value.find(m => m.downloaded);
          if (dl) opts.model = dl.name;
        }
      } catch (e) { /* ignore */ }
    }

    function onModelChange() { modelDlError.value = ''; }

    async function startModelDownload() {
      if (!selectedModel.value) return;
      modelDlError.value = '';
      let id;
      try {
        id = (await api('POST', '/api/model/download', { name: opts.model })).dl_id;
      } catch (e) { modelDlError.value = e.message; return; }
      modelDlState.value = { state: 'running', total: 0, received: 0, error: null };
      if (modelDlTimer) clearInterval(modelDlTimer);
      modelDlTimer = setInterval(() => pollModelDl(id), 500);
      pollModelDl(id);
    }

    async function pollModelDl(id) {
      let st;
      try { st = await api('GET', '/api/model/download/' + id); }
      catch (e) {
        stopModelDlPoll();
        modelDlError.value = e.message;
        return;
      }
      modelDlState.value = st;
      if (st.state === 'done') {
        stopModelDlPoll();
        loadModels();
      } else if (st.state === 'error') {
        stopModelDlPoll();
        modelDlError.value = st.error || '下载失败';
      }
    }

    function stopModelDlPoll() {
      if (modelDlTimer) { clearInterval(modelDlTimer); modelDlTimer = null; }
    }

    async function startJob() {
      startError.value = ''; jobError.value = ''; result.value = null; busy.value = false;
      const body = {
        mode: mode.value, path: path.value,
        scale: opts.scale, model: opts.model,
        want60: opts.want60, want45: opts.want45,
        width: opts.resizeW, height: opts.resizeH,
        chunk: opts.chunk ? Math.max(1, Math.floor(Number(opts.chunk))) : null,
        crf: Math.max(1, Math.min(51, Math.floor(opts.crf || 18))),
      };
      let jid;
      try { jid = (await api('POST', '/api/job', body)).job_id; }
      catch (e) { startError.value = e.message; return; }
      connect(jid);
    }

    function connect(jid) {
      jobId = jid; finished = false; esFailures = 0;
      running.value = true; progress.value = null; stage.value = '已提交';
      logs.value = []; showLogs.value = false; startedAt = Date.now(); elapsed.value = 0;
      timer = setInterval(() => { if (!finished) elapsed.value = (Date.now() - startedAt) / 1000; }, 1000);
      es = new EventSource('/api/stream/' + jid);
      es.onmessage = (e) => {
        let ev;
        try { ev = JSON.parse(e.data); } catch (err) { return; }
        handleEvent(ev);
      };
      es.onerror = () => {
        esFailures += 1;
        if (esFailures > 6 && !finished) {
          es.close();
          jobError.value = '与后端连接中断，请检查 webui.py 是否仍在运行。';
          finish();
        }
      };
    }

    function handleEvent(ev) {
      if (ev.type === 'stage') stage.value = ev.text;
      else if (ev.type === 'progress') progress.value = ev;
      else if (ev.type === 'log') {
        logs.value.push(ev.line);
        if (logs.value.length > 800) logs.value.splice(0, logs.value.length - 800);
      }
      else if (ev.type === 'done') { result.value = ev.outputs; }
      else if (ev.type === 'error') { jobError.value = ev.message; }
      else if (ev.type === 'cancelled') { busy.value = true; }
      else if (ev.type === 'end') { finish(); }
    }

    function finish() {
      if (finished) return;
      finished = true;
      running.value = false;
      if (es) { es.close(); es = null; }
      if (timer) { clearInterval(timer); timer = null; }
      refreshRecent();
    }

    async function cancelJob() {
      if (!jobId) return;
      try { await api('POST', '/api/job/' + jobId + '/cancel'); } catch (e) { /* ignore */ }
    }

    function openFolder(p) { api('POST', '/api/open', { path: p, how: 'folder' }).catch(() => {}); }
    function openFile(p) { api('POST', '/api/open', { path: p, how: 'file' }).catch(() => {}); }

    async function refreshRecent() {
      try {
        const st = await api('GET', '/api/state');
        recentJobs.value = st.recent || [];
        if (st.gpu) gpu.value = st.gpu;
      } catch (e) { /* ignore */ }
    }

    onMounted(async () => {
      loadModels();
      try {
        const st = await api('GET', '/api/state');
        if (st.gpu) gpu.value = st.gpu;
        recentJobs.value = st.recent || [];
        const active = (st.active || []).find(j => j.status === 'running' || j.status === 'pending');
        if (active) {
          mode.value = active.mode;
          path.value = active.src;
          connect(active.id);
          doProbe(active.src);
        }
      } catch (e) { /* ignore */ }
    });

    function fmtSize(n) {
      if (!n) return '—';
      const u = ['B', 'KB', 'MB', 'GB', 'TB']; let i = 0;
      while (n >= 1024 && i < u.length - 1) { n /= 1024; i++; }
      return n.toFixed(n < 10 && i > 0 ? 1 : 0) + ' ' + u[i];
    }
    function fmtDur(s) {
      if (s === null || s === undefined || !isFinite(s)) return '—';
      s = Math.max(0, Math.round(s));
      const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = s % 60;
      if (h > 0) return h + 'h ' + m + 'm ' + sec + 's';
      if (m > 0) return m + 'm ' + sec + 's';
      return sec + 's';
    }
    function fmtInt(n) { return (n || 0).toLocaleString('en-US'); }
    function fmtFps(f) { return (Math.round(f * 10) / 10).toFixed(1); }
    function modeLabel(k) { return MODE_LABEL[k] || k; }
    function statusLabel(s) { return STATUS_LABEL[s] || s; }
    function shortName(p) {
      if (!p) return '';
      const s = p.replace(/\\/g, '/');
      const i = s.lastIndexOf('/');
      return i >= 0 ? s.slice(i + 1) : s;
    }

    return { modes, mode, path, probe, probeWarn, probeError, opts, running, stage, progress,
             logs, showLogs, elapsed, result, jobError, startError, busy, recentJobs, gpu,
             browseVisible, browseData, browsePathInput, browseError,
             models, faceEnhance, modelDlState, modelDlError,
             selectedModel, modelOk, modelDlActive, modelDlPct, fmtDlProgress, selMbText, selZipMbText,
             canRun, pct, progressText, selectMode, probePath, openBrowse, browseGo, browseHome,
             joinPath, pickFile, loadModels, onModelChange, startModelDownload,
             startJob, cancelJob, openFolder, openFile,
             fmtSize, fmtDur, fmtInt, fmtFps, modeLabel, statusLabel, shortName };
  },
}).mount('#app');
