/* ═══════════════════════════════════════════════════════════════════════════
   VideoSub AI — app.js
   ═══════════════════════════════════════════════════════════════════════════ */

'use strict';

// ── DOM References ──────────────────────────────────────────────────────────
// Tabs
const tabUrlBtn          = document.getElementById('tabUrlBtn');
const tabUploadBtn       = document.getElementById('tabUploadBtn');
const urlTabPane         = document.getElementById('urlTabPane');
const uploadTabPane      = document.getElementById('uploadTabPane');

// URL Input
const videoUrlInput      = document.getElementById('videoUrl');
const translateUrlBtn    = document.getElementById('translateUrlBtn');

// File Upload
const uploadDropzone     = document.getElementById('uploadDropzone');
const videoFileInput     = document.getElementById('videoFileInput');
const dropzoneContent    = document.getElementById('dropzoneContent');
const filePreviewCard    = document.getElementById('filePreviewCard');
const previewFileName    = document.getElementById('previewFileName');
const previewFileMeta    = document.getElementById('previewFileMeta');
const fileRemoveBtn      = document.getElementById('fileRemoveBtn');
const translateUploadBtn = document.getElementById('translateUploadBtn');

// Progress & Status
const inputCard          = document.getElementById('inputCard');
const progressSection    = document.getElementById('progressSection');
const progressFill       = document.getElementById('progressFill');
const progressMessage    = document.getElementById('progressMessage');
const progressPercent    = document.getElementById('progressPercent');
const processLogList     = document.getElementById('processLogList');
const errorBanner        = document.getElementById('errorBanner');
const errorMessage       = document.getElementById('errorMessage');

// Player Section
const playerSection      = document.getElementById('playerSection');
const mainVideo          = document.getElementById('mainVideo');
const subtitleOverlay    = document.getElementById('subtitleOverlay');
const subtitleText       = document.getElementById('subtitleText');
const videoControls      = document.getElementById('videoControls');
const playerWrapper      = document.getElementById('playerWrapper');

// Controls
const playBtn            = document.getElementById('playBtn');
const playIcon           = document.getElementById('playIcon');
const pauseIcon          = document.getElementById('pauseIcon');
const timeDisplay        = document.getElementById('timeDisplay');
const seekBar            = document.getElementById('seekBar');
const seekProgress       = document.getElementById('seekProgress');
const seekLoaded         = document.getElementById('seekLoaded');
const seekThumb          = document.getElementById('seekThumb');
const muteBtn            = document.getElementById('muteBtn');
const volumeSlider       = document.getElementById('volumeSlider');
const ccBtn              = document.getElementById('ccBtn');
const fullscreenBtn      = document.getElementById('fullscreenBtn');

// Subtitle Editor
const editorCard         = document.getElementById('editorCard');
const editorCountBadge   = document.getElementById('editorCountBadge');
const applySubBtn        = document.getElementById('applySubBtn');
const subtitlesList      = document.getElementById('subtitlesList');

// Settings & Actions
const fontSizeSlider     = document.getElementById('fontSizeSlider');
const fontSizeValue      = document.getElementById('fontSizeValue');
const positionSelect     = document.getElementById('positionSelect');
const bgOpacity          = document.getElementById('bgOpacity');
const bgOpacityValue     = document.getElementById('bgOpacityValue');
const colorOptions       = document.getElementById('colorOptions');
const downloadMp4Btn     = document.getElementById('downloadMp4Btn');
const downloadVttBtn     = document.getElementById('downloadVttBtn');
const downloadSrtBtn     = document.getElementById('downloadSrtBtn');
const newVideoBtn        = document.getElementById('newVideoBtn');

// Steps
const steps = [
  document.getElementById('step1'),
  document.getElementById('step2'),
  document.getElementById('step3'),
  document.getElementById('step4'),
];

// ── State ───────────────────────────────────────────────────────────────────
let activeJobId = '';
let selectedFile = null;
let currentTab = 'url'; // 'url' | 'upload'
let cues = [];          // parsed subtitle cues: [{ start, end, text }]
let vttContent = '';    // raw VTT string
let subtitlesOn = true;
let pollingTimer = null;
let isSeeking = false;
let currentSubtitleColor = '#ffffff';
let displayedLogKey = '';
let downloadUrl = '';
let currentActiveCueIndex = -1;

// ── Tab Navigation ──────────────────────────────────────────────────────────
tabUrlBtn.addEventListener('click', () => switchTab('url'));
tabUploadBtn.addEventListener('click', () => switchTab('upload'));

function switchTab(tab) {
  currentTab = tab;
  if (tab === 'url') {
    tabUrlBtn.classList.add('active');
    tabUrlBtn.setAttribute('aria-selected', 'true');
    tabUploadBtn.classList.remove('active');
    tabUploadBtn.setAttribute('aria-selected', 'false');

    urlTabPane.hidden = false;
    uploadTabPane.hidden = true;
    videoUrlInput.focus();
  } else {
    tabUploadBtn.classList.add('active');
    tabUploadBtn.setAttribute('aria-selected', 'true');
    tabUrlBtn.classList.remove('active');
    tabUrlBtn.setAttribute('aria-selected', 'false');

    urlTabPane.hidden = true;
    uploadTabPane.hidden = false;
  }
}

// ── File Upload & Dropzone Handling ─────────────────────────────────────────
uploadDropzone.addEventListener('click', (e) => {
  if (e.target.closest('#fileRemoveBtn')) return;
  videoFileInput.click();
});

videoFileInput.addEventListener('change', (e) => {
  if (e.target.files && e.target.files.length > 0) {
    handleFileSelected(e.target.files[0]);
  }
});

fileRemoveBtn.addEventListener('click', (e) => {
  e.stopPropagation();
  clearSelectedFile();
});

// Drag & Drop events
['dragenter', 'dragover'].forEach((eventName) => {
  uploadDropzone.addEventListener(eventName, (e) => {
    e.preventDefault();
    e.stopPropagation();
    uploadDropzone.classList.add('dragover');
  });
});

['dragleave', 'drop'].forEach((eventName) => {
  uploadDropzone.addEventListener(eventName, (e) => {
    e.preventDefault();
    e.stopPropagation();
    uploadDropzone.classList.remove('dragover');
  });
});

uploadDropzone.addEventListener('drop', (e) => {
  const dt = e.dataTransfer;
  if (dt && dt.files && dt.files.length > 0) {
    handleFileSelected(dt.files[0]);
  }
});

function handleFileSelected(file) {
  if (!file) return;

  const validTypes = /\.(mp4|mkv|mov|webm|avi|flv|m4v|wmv|ts|3gp|ogv)$/i;
  const isVideo = file.type.startsWith('video/') || validTypes.test(file.name);

  if (!isVideo) {
    showError('Vui lòng chọn một file video hợp lệ (MP4, MKV, MOV, WEBM, AVI...).');
    return;
  }

  const maxBytes = 500 * 1024 * 1024; // 500MB
  if (file.size > maxBytes) {
    showError('Dung lượng video vượt quá 500MB. Vui lòng chọn file nhỏ hơn.');
    return;
  }

  hideError();
  selectedFile = file;

  previewFileName.textContent = file.name;
  const sizeMB = (file.size / (1024 * 1024)).toFixed(1);
  previewFileMeta.textContent = `${sizeMB} MB • Định dạng: ${file.name.split('.').pop().toUpperCase()}`;

  dropzoneContent.hidden = true;
  filePreviewCard.hidden = false;
  translateUploadBtn.disabled = false;
}

function clearSelectedFile() {
  selectedFile = null;
  videoFileInput.value = '';
  dropzoneContent.hidden = false;
  filePreviewCard.hidden = true;
  translateUploadBtn.disabled = true;
}

// ── Submission Handlers ─────────────────────────────────────────────────────
translateUrlBtn.addEventListener('click', handleTranslateUrl);
videoUrlInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') handleTranslateUrl();
});
translateUploadBtn.addEventListener('click', handleTranslateUpload);

// ── Translate Handler (URL) ──────────────────────────────────────────────────
async function handleTranslateUrl() {
  const url = videoUrlInput.value.trim();
  if (!url) {
    showError('Vui lòng nhập URL video trước.');
    return;
  }

  if (!isValidUrl(url)) {
    showError('URL không hợp lệ. Vui lòng kiểm tra lại.');
    return;
  }

  hideError();
  clearCurrentVideo();
  playerSection.hidden = true;
  setLoadingState(true);
  displayedLogKey = '';
  processLogList.replaceChildren();
  showProgress(5, '🚀 Đang khởi tạo...');

  try {
    const res = await fetch('/api/process', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url }),
    });

    const data = await res.json();

    if (!res.ok) {
      throw new Error(data.error || 'Lỗi máy chủ không xác định.');
    }

    activeJobId = data.jobId;
    startPolling(data.jobId);
  } catch (err) {
    showError(err.message);
    setLoadingState(false);
    progressSection.hidden = true;
  }
}

// ── Translate Handler (Uploaded File) ────────────────────────────────────────
function handleTranslateUpload() {
  if (!selectedFile) {
    showError('Vui lòng chọn file video cần dịch trước.');
    return;
  }

  hideError();
  clearCurrentVideo();
  playerSection.hidden = true;
  setLoadingState(true);
  displayedLogKey = '';
  processLogList.replaceChildren();
  showProgress(2, '📤 Đang tải video lên máy chủ (0%)...');

  const formData = new FormData();
  formData.append('videoFile', selectedFile);

  const xhr = new XMLHttpRequest();
  xhr.open('POST', '/api/upload', true);

  xhr.upload.onprogress = (e) => {
    if (e.lengthComputable) {
      const pct = Math.round((e.loaded / e.total) * 100);
      showProgress(Math.min(99, pct), `📤 Đang tải video lên máy chủ... ${pct}%`);
    }
  };

  xhr.onload = () => {
    if (xhr.status >= 200 && xhr.status < 300) {
      try {
        const data = JSON.parse(xhr.responseText);
        activeJobId = data.jobId;
        startPolling(data.jobId);
      } catch {
        showError('Phản hồi từ máy chủ không hợp lệ. Vui lòng thử lại.');
        setLoadingState(false);
        progressSection.hidden = true;
      }
    } else {
      let errMsg = `Lỗi tải video lên máy chủ (Mã HTTP ${xhr.status}). Vui lòng khởi động lại server.`;
      try {
        const data = JSON.parse(xhr.responseText);
        if (data.error) errMsg = data.error;
      } catch {}
      showError(errMsg);
      setLoadingState(false);
      progressSection.hidden = true;
    }
  };

  xhr.onerror = () => {
    showError('Lỗi kết nối mạng khi tải video lên máy chủ.');
    setLoadingState(false);
    progressSection.hidden = true;
  };

  xhr.send(formData);
}

// ── Polling ──────────────────────────────────────────────────────────────────
function startPolling(jobId) {
  clearPolling();
  pollingTimer = setInterval(() => pollStatus(jobId), 1500);
  pollStatus(jobId); // immediate first check
}

async function pollStatus(jobId) {
  try {
    const res = await fetch(`/api/status/${jobId}`);
    const job = await res.json();

    if (job.status === 'processing') {
      showProgress(job.stepPercent ?? 0, job.message);
      renderProcessLogs(job.logs || []);
      updateStepIndicators(job.step || 1);
    } else if (job.status === 'done') {
      clearPolling();
      showProgress(job.stepPercent ?? 100, job.message);
      renderProcessLogs(job.logs || []);
      updateStepIndicators(job.step || 4);
      setTimeout(() => onJobDone(job), 600);
    } else if (job.status === 'error') {
      clearPolling();
      renderProcessLogs(job.logs || []);
      progressSection.hidden = true;
      setLoadingState(false);
      showError(job.message || 'Đã xảy ra lỗi trong quá trình xử lý.');
    }
  } catch (err) {
    // Network hiccup — keep polling
    console.warn('[Polling] Network error:', err.message);
  }
}

function clearPolling() {
  if (pollingTimer) {
    clearInterval(pollingTimer);
    pollingTimer = null;
  }
}

// ── Job Done ─────────────────────────────────────────────────────────────────
function onJobDone(job) {
  vttContent = job.vttContent || '';
  if (Array.isArray(job.segments) && job.segments.length > 0) {
    cues = job.segments.map((s) => ({
      start: s.start,
      end: s.end,
      text: s.text || '',
    }));
  } else {
    cues = parseVTT(vttContent);
  }

  downloadUrl = job.downloadUrl || '';

  progressSection.hidden = true;
  setLoadingState(false);

  // Render Subtitle Editor
  renderSubtitleEditor();

  // Load video
  mainVideo.src = job.videoUrl;
  mainVideo.load();

  playerSection.hidden = false;
  playerSection.classList.add('animate-in');

  // Scroll to player
  setTimeout(() => {
    playerSection.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }, 100);
}

// ── Subtitle Editor Rendering & Interactions ────────────────────────────────
function renderSubtitleEditor() {
  editorCountBadge.textContent = `${cues.length} câu`;
  subtitlesList.replaceChildren();

  cues.forEach((cue, index) => {
    const row = document.createElement('div');
    row.className = 'sub-row';
    row.dataset.index = String(index);

    const meta = document.createElement('div');
    meta.className = 'sub-meta';

    const idx = document.createElement('span');
    idx.className = 'sub-index';
    idx.textContent = `#${index + 1}`;

    const timeBtn = document.createElement('button');
    timeBtn.type = 'button';
    timeBtn.className = 'sub-time-btn';
    timeBtn.title = 'Tua video đến câu này';
    timeBtn.innerHTML = `<span class="play-icon">▶</span> ${formatShortTime(cue.start)} - ${formatShortTime(cue.end)}`;
    timeBtn.addEventListener('click', () => {
      mainVideo.currentTime = cue.start + 0.05;
      mainVideo.play();
    });

    meta.append(idx, timeBtn);

    const body = document.createElement('div');
    body.className = 'sub-body';

    const textarea = document.createElement('textarea');
    textarea.className = 'sub-textarea';
    textarea.rows = 2;
    textarea.value = cue.text;
    textarea.placeholder = 'Nhập nội dung phụ đề tiếng Việt...';

    // Live update on typing
    textarea.addEventListener('input', (e) => {
      cue.text = e.target.value;
      vttContent = cuesToVTT(cues);

      // Live update player overlay if currently on this cue
      const curTime = mainVideo.currentTime;
      if (curTime >= cue.start && curTime <= cue.end && subtitlesOn) {
        subtitleText.textContent = cue.text;
      }

      // Reset button state
      applySubBtn.classList.remove('success');
      applySubBtn.querySelector('.btn-text').textContent = 'Lưu & Cập nhật video MP4';
    });

    body.append(textarea);
    row.append(meta, body);
    subtitlesList.append(row);
  });
}

// ── Apply / Save Subtitles to MP4 ───────────────────────────────────────────
applySubBtn.addEventListener('click', handleApplySubtitles);

async function handleApplySubtitles() {
  if (!activeJobId) return;

  applySubBtn.classList.add('loading');
  applySubBtn.querySelector('.btn-icon').textContent = '⏳';
  applySubBtn.querySelector('.btn-text').textContent = 'Đang xử lý & chèn phụ đề...';

  try {
    const res = await fetch(`/api/subtitles/${activeJobId}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ segments: cues }),
    });

    const data = await res.json();
    if (!res.ok) {
      throw new Error(data.error || 'Lỗi cập nhật phụ đề.');
    }

    if (data.downloadUrl) {
      downloadUrl = data.downloadUrl;
    }
    if (data.vttContent) {
      vttContent = data.vttContent;
    }

    applySubBtn.classList.remove('loading');
    applySubBtn.classList.add('success');
    applySubBtn.querySelector('.btn-icon').textContent = '✓';
    applySubBtn.querySelector('.btn-text').textContent = 'Đã lưu & cập nhật xong!';

    setTimeout(() => {
      applySubBtn.classList.remove('success');
      applySubBtn.querySelector('.btn-icon').textContent = '💾';
      applySubBtn.querySelector('.btn-text').textContent = 'Lưu & Cập nhật video MP4';
    }, 3000);

  } catch (err) {
    applySubBtn.classList.remove('loading');
    applySubBtn.querySelector('.btn-icon').textContent = '💾';
    applySubBtn.querySelector('.btn-text').textContent = 'Lưu & Cập nhật video MP4';
    showError(`Không thể cập nhật video: ${err.message}`);
  }
}

// ── VTT / SRT Helpers ────────────────────────────────────────────────────────
function cuesToVTT(cueList) {
  let vtt = 'WEBVTT\n\n';
  cueList.forEach((seg, index) => {
    const start = formatVTTTime(seg.start);
    const end = formatVTTTime(seg.end);
    const text = (seg.text || '').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    vtt += `${index + 1}\n${start} --> ${end}\n${text}\n\n`;
  });
  return vtt;
}

function cuesToSRT(cueList) {
  return cueList
    .map((seg, index) => {
      const start = formatVTTTime(seg.start).replace('.', ',');
      const end = formatVTTTime(seg.end).replace('.', ',');
      return `${index + 1}\n${start} --> ${end}\n${seg.text || ''}\n`;
    })
    .join('\n');
}

function parseVTT(vtt) {
  const parsed = [];
  const lines = vtt.split('\n');
  let i = 0;

  while (i < lines.length) {
    const line = lines[i].trim();

    if (line.includes('-->')) {
      const parts = line.split('-->');
      const start = parseVTTTime(parts[0].trim());
      const end = parseVTTTime(parts[1].trim().split(' ')[0]);

      const textLines = [];
      i++;
      while (i < lines.length && lines[i].trim() !== '') {
        textLines.push(lines[i].trim());
        i++;
      }

      if (textLines.length > 0) {
        parsed.push({
          start,
          end,
          text: textLines.join('\n'),
        });
      }
    } else {
      i++;
    }
  }

  return parsed;
}

function parseVTTTime(str) {
  const parts = str.split(':');
  if (parts.length === 3) {
    return parseFloat(parts[0]) * 3600 + parseFloat(parts[1]) * 60 + parseFloat(parts[2]);
  } else {
    return parseFloat(parts[0]) * 60 + parseFloat(parts[1]);
  }
}

function formatVTTTime(seconds) {
  const totalMs = Math.round(seconds * 1000);
  const ms = totalMs % 1000;
  const totalSecs = Math.floor(totalMs / 1000);
  const secs = totalSecs % 60;
  const totalMins = Math.floor(totalSecs / 60);
  const mins = totalMins % 60;
  const hours = Math.floor(totalMins / 60);

  return [
    String(hours).padStart(2, '0'),
    String(mins).padStart(2, '0'),
    String(secs).padStart(2, '0'),
  ].join(':') + '.' + String(ms).padStart(3, '0');
}

function formatShortTime(s) {
  if (isNaN(s)) return '00:00';
  const m = Math.floor(s / 60);
  const sec = Math.floor(s % 60);
  return `${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')}`;
}

// ── Subtitle Sync ─────────────────────────────────────────────────────────────
mainVideo.addEventListener('timeupdate', () => {
  if (cues.length === 0) {
    subtitleText.textContent = '';
    return;
  }

  const t = mainVideo.currentTime;
  const activeIdx = cues.findIndex((c) => t >= c.start && t <= c.end);

  if (subtitlesOn) {
    subtitleText.textContent = activeIdx >= 0 ? cues[activeIdx].text : '';
  }

  // Highlight active row in editor
  if (activeIdx !== currentActiveCueIndex) {
    currentActiveCueIndex = activeIdx;
    const rows = subtitlesList.querySelectorAll('.sub-row');
    rows.forEach((row, i) => {
      if (i === activeIdx) {
        row.classList.add('active');
        // Auto scroll active row into view if not user scrolling
        if (!document.activeElement?.closest('.subtitles-list')) {
          row.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
        }
      } else {
        row.classList.remove('active');
      }
    });
  }
});

// ── Video Controls ────────────────────────────────────────────────────────────

// Play / Pause
playBtn.addEventListener('click', togglePlay);
mainVideo.addEventListener('click', togglePlay);

mainVideo.addEventListener('play', () => {
  playIcon.style.display  = 'none';
  pauseIcon.style.display = '';
  playerWrapper.classList.remove('paused');
});

mainVideo.addEventListener('pause', () => {
  playIcon.style.display  = '';
  pauseIcon.style.display = 'none';
  playerWrapper.classList.add('paused');
});

mainVideo.addEventListener('ended', () => {
  playIcon.style.display  = '';
  pauseIcon.style.display = 'none';
  playerWrapper.classList.add('paused');
});

function togglePlay() {
  if (mainVideo.paused) mainVideo.play();
  else mainVideo.pause();
}

// Time display
mainVideo.addEventListener('timeupdate', updateTime);
mainVideo.addEventListener('loadedmetadata', updateTime);

function updateTime() {
  const cur = mainVideo.currentTime;
  const dur = mainVideo.duration || 0;
  timeDisplay.textContent = `${formatTime(cur)} / ${formatTime(dur)}`;

  // Seek bar
  if (!isSeeking && dur > 0) {
    const pct = (cur / dur) * 100;
    seekProgress.style.width = pct + '%';
    seekThumb.style.left = pct + '%';
  }
}

// Buffered progress
mainVideo.addEventListener('progress', () => {
  if (mainVideo.buffered.length > 0 && mainVideo.duration) {
    const buffered = mainVideo.buffered.end(mainVideo.buffered.length - 1);
    seekLoaded.style.width = (buffered / mainVideo.duration * 100) + '%';
  }
});

function formatTime(s) {
  if (isNaN(s)) return '0:00';
  const m = Math.floor(s / 60);
  const sec = Math.floor(s % 60);
  return `${m}:${String(sec).padStart(2, '0')}`;
}

// Seek bar interaction
seekBar.addEventListener('mousedown', (e) => {
  isSeeking = true;
  seek(e);
});

document.addEventListener('mousemove', (e) => {
  if (isSeeking) seek(e);
});

document.addEventListener('mouseup', () => {
  isSeeking = false;
});

function seek(e) {
  const rect = seekBar.getBoundingClientRect();
  const pct = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
  mainVideo.currentTime = pct * (mainVideo.duration || 0);
  seekProgress.style.width = (pct * 100) + '%';
  seekThumb.style.left = (pct * 100) + '%';
}

// Volume
volumeSlider.addEventListener('input', () => {
  mainVideo.volume = parseFloat(volumeSlider.value);
  mainVideo.muted = mainVideo.volume === 0;
});

muteBtn.addEventListener('click', () => {
  mainVideo.muted = !mainVideo.muted;
  volumeSlider.value = mainVideo.muted ? 0 : mainVideo.volume;
});

// CC toggle
ccBtn.addEventListener('click', () => {
  subtitlesOn = !subtitlesOn;
  ccBtn.classList.toggle('active', subtitlesOn);
  ccBtn.setAttribute('aria-pressed', subtitlesOn);
  if (!subtitlesOn) subtitleText.textContent = '';
});

// Fullscreen
fullscreenBtn.addEventListener('click', () => {
  if (!document.fullscreenElement) {
    playerWrapper.requestFullscreen();
  } else {
    document.exitFullscreen();
  }
});

document.addEventListener('fullscreenchange', () => {
  const icon = fullscreenBtn.querySelector('svg path');
  if (document.fullscreenElement) {
    icon.setAttribute('d', 'M5 16h3v3h2v-5H5v2zm3-8H5v2h5V5H8v3zm6 11h2v-3h3v-2h-5v5zm2-11V5h-2v5h5V8h-3z');
  } else {
    icon.setAttribute('d', 'M7 14H5v5h5v-2H7v-3zm-2-4h2V7h3V5H5v5zm12 7h-3v2h5v-5h-2v3zM14 5v2h3v3h2V5h-5z');
  }
});

// Keyboard shortcuts
document.addEventListener('keydown', (e) => {
  if (e.target.matches('input, textarea')) return;
  if (playerSection.hidden) return;

  switch (e.code) {
    case 'Space':
      e.preventDefault();
      togglePlay();
      break;
    case 'ArrowRight':
      e.preventDefault();
      mainVideo.currentTime = Math.min(mainVideo.duration, mainVideo.currentTime + 5);
      break;
    case 'ArrowLeft':
      e.preventDefault();
      mainVideo.currentTime = Math.max(0, mainVideo.currentTime - 5);
      break;
    case 'KeyC':
      ccBtn.click();
      break;
  }
});

// ── Subtitle Settings ─────────────────────────────────────────────────────────

// Font size
fontSizeSlider.addEventListener('input', () => {
  const size = fontSizeSlider.value;
  fontSizeValue.textContent = size + 'px';
  subtitleText.style.fontSize = size + 'px';
});

// Position
positionSelect.addEventListener('change', () => {
  subtitleOverlay.className = 'subtitle-overlay';
  const pos = positionSelect.value;
  if (pos === 'top') {
    subtitleOverlay.classList.add('pos-top');
    subtitleOverlay.style.bottom = 'auto';
    subtitleOverlay.style.top = '16px';
    subtitleOverlay.style.transform = '';
  } else if (pos === 'center') {
    subtitleOverlay.classList.add('pos-center');
    subtitleOverlay.style.bottom = 'auto';
    subtitleOverlay.style.top = '50%';
    subtitleOverlay.style.transform = 'translateY(-50%)';
  } else {
    subtitleOverlay.style.bottom = '70px';
    subtitleOverlay.style.top = 'auto';
    subtitleOverlay.style.transform = '';
  }
});

// Background opacity
bgOpacity.addEventListener('input', () => {
  const opacity = parseInt(bgOpacity.value) / 100;
  bgOpacityValue.textContent = bgOpacity.value + '%';
  subtitleText.style.background = `rgba(0, 0, 0, ${opacity})`;
});

// Text color
colorOptions.addEventListener('click', (e) => {
  const dot = e.target.closest('.color-dot');
  if (!dot) return;

  document.querySelectorAll('.color-dot').forEach((d) => d.classList.remove('active'));
  dot.classList.add('active');
  currentSubtitleColor = dot.dataset.color;
  subtitleText.style.color = currentSubtitleColor;
});

// ── Downloads ─────────────────────────────────────────────────────────────────
downloadMp4Btn.addEventListener('click', () => {
  if (downloadUrl) window.location.assign(downloadUrl);
});

downloadVttBtn.addEventListener('click', () => {
  downloadFile(cuesToVTT(cues), 'subtitles-vi.vtt', 'text/vtt;charset=utf-8');
});

downloadSrtBtn.addEventListener('click', () => {
  downloadFile(cuesToSRT(cues), 'subtitles-vi.srt', 'text/srt;charset=utf-8');
});

function downloadFile(content, filename, type) {
  const blob = new Blob([content], { type });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

// ── Reset ─────────────────────────────────────────────────────────────────────
newVideoBtn.addEventListener('click', resetApp);

function clearCurrentVideo() {
  mainVideo.pause();
  mainVideo.removeAttribute('src');
  mainVideo.load();
  cues = [];
  vttContent = '';
  downloadUrl = '';
  activeJobId = '';
  currentActiveCueIndex = -1;
  subtitleText.textContent = '';
  subtitlesList.replaceChildren();
  editorCountBadge.textContent = '0 câu';
}

function resetApp() {
  clearPolling();
  clearCurrentVideo();
  clearSelectedFile();

  playerSection.hidden = true;
  progressSection.hidden = true;
  errorBanner.hidden = true;
  inputCard.scrollIntoView({ behavior: 'smooth' });
  videoUrlInput.value = '';
  if (currentTab === 'url') {
    videoUrlInput.focus();
  }
}

// ── UI Helpers ────────────────────────────────────────────────────────────────
function setLoadingState(loading) {
  translateUrlBtn.disabled = loading;
  if (loading) {
    translateUrlBtn.classList.add('loading');
    translateUrlBtn.querySelector('.btn-text').textContent = 'Đang xử lý...';
    translateUrlBtn.querySelector('.btn-icon').textContent = '⟳';
    if (translateUploadBtn) {
      translateUploadBtn.disabled = true;
      translateUploadBtn.classList.add('loading');
      translateUploadBtn.querySelector('.btn-text').textContent = 'Đang xử lý...';
      translateUploadBtn.querySelector('.btn-icon').textContent = '⟳';
    }
  } else {
    translateUrlBtn.classList.remove('loading');
    translateUrlBtn.querySelector('.btn-text').textContent = 'Dịch Video';
    translateUrlBtn.querySelector('.btn-icon').textContent = '✦';
    if (translateUploadBtn) {
      translateUploadBtn.disabled = !selectedFile;
      translateUploadBtn.classList.remove('loading');
      translateUploadBtn.querySelector('.btn-text').textContent = 'Dịch Video Tải Lên';
      translateUploadBtn.querySelector('.btn-icon').textContent = '✦';
    }
  }
}

function showProgress(percent, message) {
  progressSection.hidden = false;
  progressFill.style.width = percent + '%';
  progressMessage.textContent = message;
  progressPercent.textContent = percent + '%';
}

function renderProcessLogs(logs) {
  const logKey = logs.map((log) => `${log.time}|${log.message}`).join('\n');
  if (logKey === displayedLogKey) return;
  displayedLogKey = logKey;
  processLogList.replaceChildren(...logs.map((log) => {
    const item = document.createElement('li');
    const time = document.createElement('time');
    time.textContent = log.time;
    const message = document.createElement('span');
    message.textContent = log.message;
    item.append(time, message);
    return item;
  }));
  processLogList.scrollTop = processLogList.scrollHeight;
}

function updateStepIndicators(activeStep) {
  steps.forEach((step, i) => {
    step.classList.remove('active', 'done');
    const stepNumber = i + 1;
    if (stepNumber < activeStep) {
      step.classList.add('done');
    } else if (stepNumber === activeStep) {
      step.classList.add('active');
    }
  });
}

function showError(msg) {
  errorBanner.hidden = false;
  errorMessage.textContent = msg;
}

function hideError() {
  errorBanner.hidden = true;
  errorMessage.textContent = '';
}

function isValidUrl(str) {
  try {
    new URL(str);
    return true;
  } catch {
    return false;
  }
}

// ── Global expose ─────────────────────────────────────────────────────────────
window.hideError = hideError;
