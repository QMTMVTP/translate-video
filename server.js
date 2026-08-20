require('dotenv').config();
const express = require('express');
const cors = require('cors');
const path = require('path');
const fs = require('fs-extra');
const multer = require('multer');
const { execFile } = require('child_process');
const ffmpegPath = require('ffmpeg-static');
const { v4: uuidv4 } = require('uuid');

const videoProcessor = require('./services/videoProcessor');
const transcriber = require('./services/transcriber');
const translator = require('./services/translator');
const subtitleGenerator = require('./services/subtitleGenerator');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json({ limit: '10mb' }));
app.use(express.static(path.join(__dirname, 'public')));

// Ensure upload directory exists
const uploadDir = path.join(__dirname, 'temp', 'uploads');
fs.ensureDirSync(uploadDir);

// Multer configuration for video file uploads
const storage = multer.diskStorage({
  destination: (_req, _file, cb) => {
    cb(null, uploadDir);
  },
  filename: (_req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase() || '.mp4';
    cb(null, `${uuidv4()}${ext}`);
  },
});

const upload = multer({
  storage,
  limits: { fileSize: 500 * 1024 * 1024 }, // 500 MB max
  fileFilter: (_req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase();
    const isVideoExt = /\.(mp4|mkv|mov|webm|avi|flv|m4v|wmv|ts|3gp|ogv)$/i.test(ext);
    const isVideoMime = (file.mimetype || '').startsWith('video/') || file.mimetype === 'application/octet-stream';
    if (isVideoExt || isVideoMime || !ext) {
      cb(null, true);
    } else {
      cb(new Error('Chỉ chấp nhận file video (.mp4, .mkv, .mov, .webm, .avi, .m4v...).'));
    }
  },
});

// In-memory job store
const jobs = new Map();

function makeLogEntry(message) {
  return { time: new Date().toLocaleTimeString('vi-VN'), message };
}

function appendJobLog(job, message) {
  const logs = job.logs || [];
  if (logs.at(-1)?.message === message) return logs;
  return [...logs, makeLogEntry(message)].slice(-100);
}

// The UI shows progress for the current step only, rather than one combined
// percentage across the entire pipeline.
function getStepProgress(percent) {
  if (percent < 45) {
    return { step: 1, stepPercent: Math.max(0, Math.min(100, Math.round(((percent - 10) / 25) * 100))) };
  }
  if (percent < 68) {
    return { step: 2, stepPercent: 0 };
  }
  if (percent < 95) {
    return { step: 3, stepPercent: Math.max(0, Math.min(100, Math.round(((percent - 68) / 20) * 100))) };
  }
  return { step: 4, stepPercent: percent >= 100 ? 100 : 0 };
}

// ─── POST /api/process (Process URL) ─────────────────────────────────────────
app.post('/api/process', async (req, res) => {
  const { url } = req.body;

  if (!url || !url.trim()) {
    return res.status(400).json({ error: 'Vui lòng nhập URL video hợp lệ.' });
  }

  const jobId = uuidv4();
  jobs.set(jobId, {
    status: 'processing',
    percent: 5,
    step: 1,
    stepPercent: 0,
    message: '🚀 Đang khởi tạo...',
    logs: [makeLogEntry('Đã nhận link video, đang tạo tác vụ xử lý.')],
  });
  res.json({ jobId });

  // Run processing in background
  runJob(jobId, url.trim(), false).catch((err) => {
    console.error('[Job Error]', err);
  });
});

// ─── POST /api/upload (Process Uploaded File) ────────────────────────────────
app.post('/api/upload', (req, res) => {
  upload.single('videoFile')(req, res, (err) => {
    if (err) {
      console.error('[Upload Error]', err.message);
      return res.status(400).json({ error: err.message || 'Lỗi tải lên file video.' });
    }

    if (!req.file) {
      return res.status(400).json({ error: 'Vui lòng chọn một file video để tải lên.' });
    }

    const jobId = uuidv4();
    const uploadedFilePath = req.file.path;
    const originalName = req.file.originalname;
    const fileSizeMB = (req.file.size / (1024 * 1024)).toFixed(1);

    jobs.set(jobId, {
      status: 'processing',
      percent: 5,
      step: 1,
      stepPercent: 0,
      message: '🚀 Đang khởi tạo...',
      logs: [makeLogEntry(`Đã nhận file video: ${originalName} (${fileSizeMB} MB)`)],
    });

    res.json({ jobId });

    // Run processing in background
    runJob(jobId, uploadedFilePath, true).catch((jobErr) => {
      console.error('[Upload Job Error]', jobErr);
    });
  });
});

// ─── GET /api/status/:jobId ──────────────────────────────────────────────────
app.get('/api/status/:jobId', (req, res) => {
  const job = jobs.get(req.params.jobId);
  if (!job) return res.status(404).json({ error: 'Không tìm thấy job.' });
  res.json(job);
});

// ─── GET /api/video/:jobId (range-aware video streaming) ─────────────────────
app.get('/api/video/:jobId', (req, res) => {
  const videoPath = path.join(__dirname, 'temp', req.params.jobId, 'video.mp4');

  if (!fs.existsSync(videoPath)) {
    return res.status(404).json({ error: 'Video không tìm thấy.' });
  }

  const stat = fs.statSync(videoPath);
  const fileSize = stat.size;
  const range = req.headers.range;

  if (range) {
    const [startStr, endStr] = range.replace(/bytes=/, '').split('-');
    const start = parseInt(startStr, 10);
    const end = endStr ? parseInt(endStr, 10) : fileSize - 1;
    const chunkSize = end - start + 1;

    res.writeHead(206, {
      'Content-Range': `bytes ${start}-${end}/${fileSize}`,
      'Accept-Ranges': 'bytes',
      'Content-Length': chunkSize,
      'Content-Type': 'video/mp4',
    });
    fs.createReadStream(videoPath, { start, end }).pipe(res);
  } else {
    res.writeHead(200, {
      'Content-Length': fileSize,
      'Content-Type': 'video/mp4',
      'Accept-Ranges': 'bytes',
    });
    fs.createReadStream(videoPath).pipe(res);
  }
});

app.get('/api/download/:jobId', (req, res) => {
  const outputPath = path.join(__dirname, 'temp', req.params.jobId, 'video-vietsub.mp4');
  if (!fs.existsSync(outputPath)) {
    return res.status(404).json({ error: 'File MP4 có phụ đề không tìm thấy.' });
  }
  res.download(outputPath, 'video-vietsub.mp4');
});

// ─── POST /api/subtitles/:jobId (Update subtitles & re-burn MP4) ────────────
app.post('/api/subtitles/:jobId', async (req, res) => {
  const { jobId } = req.params;
  const { segments, srtContent: customSrt, vttContent: customVtt } = req.body;

  const outputDir = path.join(__dirname, 'temp', jobId);
  if (!fs.existsSync(outputDir) || !fs.existsSync(path.join(outputDir, 'video.mp4'))) {
    return res.status(404).json({ error: 'Không tìm thấy video để cập nhật phụ đề.' });
  }

  try {
    let srtContent = customSrt;
    let vttContent = customVtt;

    if (Array.isArray(segments) && segments.length > 0) {
      srtContent = subtitleGenerator.generateSRT(segments);
      vttContent = subtitleGenerator.generateVTT(segments);
    }

    if (!srtContent) {
      return res.status(400).json({ error: 'Nội dung phụ đề không hợp lệ.' });
    }

    const subtitleFilename = 'subtitles.vi.srt';
    const subtitlePath = path.join(outputDir, subtitleFilename);
    await fs.writeFile(subtitlePath, srtContent, 'utf-8');

    // Re-burn subtitles to video-vietsub.mp4
    await burnSubtitlesToVideo(outputDir, subtitleFilename);

    // Update in-memory job if exists
    const current = jobs.get(jobId);
    if (current) {
      jobs.set(jobId, {
        ...current,
        vttContent,
        segments: segments || current.segments,
        logs: appendJobLog(current, 'Đã cập nhật phụ đề chỉnh sửa vào video MP4.'),
      });
    }

    res.json({
      success: true,
      message: 'Đã cập nhật phụ đề và xuất lại video MP4 thành công.',
      downloadUrl: `/api/download/${jobId}`,
      vttContent,
    });
  } catch (err) {
    console.error('[Update Subtitles Error]', err);
    res.status(500).json({ error: `Lỗi cập nhật video: ${err.message}` });
  }
});

/**
 * Hardsub / burn subtitles directly into video frames
 * Runs in workDir so relative subtitle file name avoids Windows path colon escaping issues.
 */
/**
 * Hardsub / burn subtitles directly into video frames
 * Runs in workDir so relative subtitle file name avoids Windows path colon escaping issues.
 */
function burnSubtitlesToVideo(workDir, subtitleFilename = 'subtitles.vi.srt') {
  return new Promise((resolve, reject) => {
    const args = [
      '-i', 'video.mp4',
      '-vf', `subtitles=${subtitleFilename}:force_style='FontName=Arial,FontSize=20,PrimaryColour=&H00FFFFFF,OutlineColour=&H00000000,BorderStyle=1,Outline=2,Shadow=1,MarginV=25'`,
      '-c:v', 'libx264',
      '-preset', 'veryfast',
      '-crf', '22',
      '-c:a', 'aac',
      '-b:a', '192k',
      '-movflags', '+faststart',
      '-y', 'video-vietsub.mp4',
    ];

    execFile(ffmpegPath, args, { cwd: workDir }, (err, _stdout, stderr) => {
      if (err) {
        console.warn('[burnSubtitlesToVideo] Hardsub re-encode failed, falling back to soft subtitles:', stderr || err.message);
        // Fallback: embed soft subtitle track
        execFile(
          ffmpegPath,
          [
            '-i', 'video.mp4',
            '-i', subtitleFilename,
            '-map', '0:v:0',
            '-map', '0:a?',
            '-map', '1:0',
            '-c:v', 'copy',
            '-c:a', 'copy',
            '-c:s', 'mov_text',
            '-metadata:s:s:0', 'language=vie',
            '-metadata:s:s:0', 'title=Tiếng Việt',
            '-y', 'video-vietsub.mp4',
          ],
          { cwd: workDir },
          (fallbackErr, _stdout2, fallbackStderr) => {
            if (fallbackErr) {
              reject(new Error(`Không thể xuất video có phụ đề: ${fallbackStderr || fallbackErr.message}`));
            } else {
              resolve();
            }
          }
        );
      } else {
        resolve();
      }
    });
  });
}

// ─── Background job runner ───────────────────────────────────────────────────
async function runJob(jobId, source, isUpload = false) {
  const update = (percent, message, extra = {}) => {
    const current = jobs.get(jobId) || {};
    const stepProgress = getStepProgress(percent);
    jobs.set(jobId, {
      ...current,
      status: 'processing',
      percent,
      ...stepProgress,
      message,
      ...extra,
      logs: appendJobLog(current, message),
    });
  };

  try {
    update(10, isUpload ? '📁 Đang chuẩn bị video tải lên...' : '📥 Đang tải video...');
    
    let videoPath, audioPath;
    if (isUpload) {
      const res = await videoProcessor.processUploadedFile(source, jobId, (msg, pct) => {
        update(pct, msg);
      });
      videoPath = res.videoPath;
      audioPath = res.audioPath;
    } else {
      const res = await videoProcessor.process(source, jobId, (msg, pct) => {
        update(pct, msg);
      });
      videoPath = res.videoPath;
      audioPath = res.audioPath;
    }

    update(45, '🎤 Đang phiên âm giọng nói (Groq Whisper)...');
    const segments = await transcriber.transcribe(audioPath);
    console.log(`[Transcriber] Got ${segments.length} segments`);

    update(68, `🌐 Đang dịch ${segments.length} đoạn sang Tiếng Việt...`);
    const translated = await translator.translateSegments(segments, (progress) => {
      update(68 + Math.round(progress * 20), `🌐 Đang dịch... ${Math.round(progress * 100)}%`);
    });

    update(95, '📝 Đang tạo file phụ đề...');
    const vttContent = subtitleGenerator.generateVTT(translated);
    const srtContent = subtitleGenerator.generateSRT(translated);
    const outputDir = path.join(__dirname, 'temp', jobId);
    const subtitleFilename = 'subtitles.vi.srt';
    const subtitlePath = path.join(outputDir, subtitleFilename);
    const downloadPath = path.join(outputDir, 'video-vietsub.mp4');
    await fs.writeFile(subtitlePath, srtContent, 'utf-8');

    update(97, '🎬 Đang chèn phụ đề tiếng Việt vào video MP4...');
    await burnSubtitlesToVideo(outputDir, subtitleFilename);

    const current = jobs.get(jobId) || {};
    jobs.set(jobId, {
      ...current,
      status: 'done',
      percent: 100,
      step: 4,
      stepPercent: 100,
      message: '✅ Hoàn tất!',
      videoUrl: `/api/video/${jobId}`,
      downloadUrl: `/api/download/${jobId}`,
      vttContent,
      segments: translated,
      logs: appendJobLog(current, 'Đã hoàn tất xử lý video và chèn phụ đề tiếng Việt.'),
    });

    // Remove audio file and temporary upload file
    await fs.remove(audioPath).catch(() => {});
    if (isUpload && source !== videoPath) {
      await fs.remove(source).catch(() => {});
    }

    // Auto-cleanup after 2 hours
    setTimeout(() => {
      fs.remove(path.join(__dirname, 'temp', jobId)).catch(() => {});
      jobs.delete(jobId);
    }, 2 * 60 * 60 * 1000);

  } catch (err) {
    console.error('[runJob] Error:', err.message);
    const current = jobs.get(jobId) || {};
    jobs.set(jobId, {
      ...current,
      status: 'error',
      percent: 0,
      message: `❌ ${err.message}`,
      logs: appendJobLog(current, `Lỗi: ${err.message}`),
    });
  }
}

// ─── Startup ─────────────────────────────────────────────────────────────────
fs.ensureDir(path.join(__dirname, 'temp')).catch(console.error);
fs.ensureDir(path.join(__dirname, 'bin')).catch(console.error);

app.listen(PORT, () => {
  console.log('\n╔══════════════════════════════════════╗');
  console.log('║       VideoSub AI - Đã khởi động     ║');
  console.log(`║   http://localhost:${PORT}              ║`);
  console.log('╚══════════════════════════════════════╝\n');
});
