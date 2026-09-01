'use strict';

const { execFile, spawn } = require('child_process');
const path = require('path');
const fs = require('fs-extra');
const ffmpegPath = require('ffmpeg-static');

// =========================================================
// CONFIG
// =========================================================

const BIN_DIR = path.join(__dirname, '..', 'bin');
const BIN_PATH = path.join(
  BIN_DIR,
  process.platform === 'win32' ? 'yt-dlp.exe' : 'yt-dlp'
);

// Giới hạn video tải từ URL (mặc định 500 MB)
const MAX_REMOTE_VIDEO_SIZE_MB = Number(
  process.env.MAX_REMOTE_VIDEO_SIZE_MB || 500
);
const MAX_REMOTE_VIDEO_SIZE_BYTES =
  MAX_REMOTE_VIDEO_SIZE_MB * 1024 * 1024;

// Timeout tải video (mặc định 10 phút)
const DOWNLOAD_TIMEOUT_MS = Number(
  process.env.DOWNLOAD_TIMEOUT_MS || 10 * 60 * 1000
);

// =========================================================
// YT-DLP LOCAL
// =========================================================

let ytDlpPath = null;

async function getYtDlp(onProgress) {
  if (ytDlpPath) {
    return ytDlpPath;
  }

  await fs.ensureDir(BIN_DIR);

  const hasBinary = await fs.pathExists(BIN_PATH);

  if (!hasBinary) {
    throw new Error(
      'Không tìm thấy bin/yt-dlp.exe. Vui lòng kiểm tra lại thư mục bin/.'
    );
  }

  if (process.platform !== 'win32') {
    try {
      await fs.chmod(BIN_PATH, 0o755);
    } catch (err) {
      console.warn('[yt-dlp] Không thể chmod binary:', err.message);
    }
  }

  onProgress?.('🔧 Đang khởi động công cụ tải video...', 12);
  ytDlpPath = BIN_PATH;
  return ytDlpPath;
}

// =========================================================
// PLATFORM HELPERS
// =========================================================

function getPlatformName(url) {
  if (/youtube\.com|youtu\.be/i.test(url)) return 'YouTube';
  if (/tiktok\.com/i.test(url)) return 'TikTok';
  if (/facebook\.com|fb\.com|fb\.watch/i.test(url)) return 'Facebook';
  if (/instagram\.com/i.test(url)) return 'Instagram';
  if (/twitter\.com|x\.com/i.test(url)) return 'Twitter/X';
  return 'video';
}

function isDirectVideoUrl(url) {
  return /\.(mp4|webm|mov|mkv|avi|flv|m4v|wmv|ts|3gp|ogv)(\?.*)?$/i.test(url);
}

function isTikTokUrl(url) {
  return /tiktok\.com/i.test(url);
}

function safeRemove(filePath) {
  if (!filePath) return;
  return fs.remove(filePath).catch(() => {});
}

function createAbortController(timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => {
    controller.abort();
  }, timeoutMs);
  timer.unref?.();
  return {
    controller,
    clear: () => clearTimeout(timer),
  };
}

function getContentLength(response) {
  const value = response.headers.get('content-length');
  if (!value) return 0;
  const size = Number(value);
  return Number.isFinite(size) && size >= 0 ? size : 0;
}

// =========================================================
// STREAM RESPONSE TO FILE (Memory-efficient chunked stream)
// =========================================================

async function streamResponseToFile(
  response,
  outputPath,
  {
    onProgress,
    progressStart = 12,
    progressEnd = 32,
    maxBytes = MAX_REMOTE_VIDEO_SIZE_BYTES,
    label = 'video',
  } = {}
) {
  if (!response.body) {
    throw new Error('Server không trả về stream dữ liệu video.');
  }

  const totalBytes = getContentLength(response);
  if (totalBytes > 0 && totalBytes > maxBytes) {
    throw new Error(
      `${label} vượt quá giới hạn ${Math.round(maxBytes / 1024 / 1024)} MB.`
    );
  }

  await fs.ensureDir(path.dirname(outputPath));
  const fileStream = fs.createWriteStream(outputPath);
  let receivedBytes = 0;
  let lastProgress = progressStart;
  const reader = response.body.getReader();

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;

      receivedBytes += value.byteLength;
      if (receivedBytes > maxBytes) {
        try {
          await reader.cancel();
        } catch {}
        throw new Error(
          `${label} vượt quá giới hạn ${Math.round(maxBytes / 1024 / 1024)} MB.`
        );
      }

      const buffer = Buffer.from(value);
      if (!fileStream.write(buffer)) {
        await new Promise((resolve, reject) => {
          const onDrain = () => {
            cleanup();
            resolve();
          };
          const onError = (err) => {
            cleanup();
            reject(err);
          };
          const cleanup = () => {
            fileStream.off('drain', onDrain);
            fileStream.off('error', onError);
          };
          fileStream.once('drain', onDrain);
          fileStream.once('error', onError);
        });
      }

      if (totalBytes > 0 && typeof onProgress === 'function') {
        const ratio = receivedBytes / totalBytes;
        const mapped = Math.round(
          progressStart + ratio * (progressEnd - progressStart)
        );
        if (mapped > lastProgress) {
          lastProgress = mapped;
          onProgress(
            `📥 Đang tải ${label}... ${Math.round(ratio * 100)}%`,
            mapped
          );
        }
      }
    }

    await new Promise((resolve, reject) => {
      fileStream.end((err) => {
        if (err) reject(err);
        else resolve();
      });
    });
  } catch (err) {
    fileStream.destroy();
    await safeRemove(outputPath);
    throw err;
  }

  const stat = await fs.stat(outputPath);
  if (!stat.size) {
    await safeRemove(outputPath);
    throw new Error(`${label} tải về bị rỗng.`);
  }

  return { size: stat.size };
}

// =========================================================
// DIRECT VIDEO DOWNLOAD
// =========================================================

async function downloadDirectVideo(url, outputPath, onProgress) {
  onProgress?.('📥 Đang tải video trực tiếp...', 12);
  const { controller, clear } = createAbortController(DOWNLOAD_TIMEOUT_MS);

  try {
    const response = await fetch(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      },
      signal: controller.signal,
    });

    if (!response.ok) {
      throw new Error(`Không thể tải video: HTTP ${response.status} ${response.statusText}`);
    }

    return await streamResponseToFile(response, outputPath, {
      onProgress,
      progressStart: 12,
      progressEnd: 32,
      maxBytes: MAX_REMOTE_VIDEO_SIZE_BYTES,
      label: 'video trực tiếp',
    });
  } catch (err) {
    if (err?.name === 'AbortError') {
      throw new Error('Tải video trực tiếp quá thời gian cho phép.');
    }
    throw err;
  } finally {
    clear();
  }
}

// =========================================================
// TIKTOK API (High-speed direct download, bypasses challenge)
// =========================================================

async function downloadTikTokVideo(url, outputPath, onProgress) {
  onProgress?.('📥 Đang kết nối tới TikTok...', 12);
  const { controller, clear } = createAbortController(DOWNLOAD_TIMEOUT_MS);

  try {
    const res = await fetch('https://www.tikwm.com/api/', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      },
      body: new URLSearchParams({
        url,
        count: '12',
        cursor: '0',
        web: '1',
        hd: '1',
      }),
      signal: controller.signal,
    });

    if (!res.ok) {
      throw new Error(`TikTok API trả về HTTP ${res.status}`);
    }

    const json = await res.json();
    if (json.code !== 0 || !json.data) {
      throw new Error(json.msg || 'Không thể lấy liên kết video TikTok.');
    }

    const playUrl = json.data.hdplay || json.data.play || json.data.wmplay;
    if (!playUrl) {
      throw new Error('Không tìm thấy link phát video TikTok.');
    }

    const fullDownloadUrl = playUrl.startsWith('http')
      ? playUrl
      : `https://www.tikwm.com${playUrl}`;

    onProgress?.('📥 Đang tải video TikTok...', 18);

    const vidRes = await fetch(fullDownloadUrl, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        Referer: 'https://www.tiktok.com/',
      },
      signal: controller.signal,
    });

    if (!vidRes.ok) {
      throw new Error(`Tải file video TikTok thất bại: HTTP ${vidRes.status}`);
    }

    return await streamResponseToFile(vidRes, outputPath, {
      onProgress,
      progressStart: 18,
      progressEnd: 32,
      maxBytes: MAX_REMOTE_VIDEO_SIZE_BYTES,
      label: 'video TikTok',
    });
  } catch (err) {
    if (err?.name === 'AbortError') {
      throw new Error('Tải video TikTok quá thời gian cho phép.');
    }
    throw err;
  } finally {
    clear();
  }
}

// =========================================================
// YT-DLP DOWNLOAD (YouTube, Facebook, Instagram, Twitter, etc.)
// =========================================================

async function downloadWithYtDlp(url, outputPath, onProgress) {
  const platform = getPlatformName(url);
  onProgress?.(`📥 Đang tải video từ ${platform}...`, 12);

  const ytPath = await getYtDlp(onProgress);

  return new Promise((resolve, reject) => {
    const args = [
      url,
      '-o', outputPath,
      '--format', 'bestvideo[ext=mp4][height<=1080]+bestaudio[ext=m4a]/best[ext=mp4]/best',
      '--merge-output-format', 'mp4',
      '--no-playlist',
      '--no-warnings',
      '--newline',
      '--progress',
      '--ffmpeg-location', ffmpegPath,
      '--extractor-args', 'youtube:player_client=web_embedded,mweb,android,ios',
    ];

    const child = spawn(ytPath, args, {
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let lastPercent = 12;
    let stderrBuffer = '';
    let finished = false;

    const timeout = setTimeout(() => {
      if (finished) return;
      try {
        child.kill('SIGKILL');
      } catch {}
      reject(new Error(`yt-dlp tải ${platform} quá thời gian cho phép.`));
    }, DOWNLOAD_TIMEOUT_MS);
    timeout.unref?.();

    const reportProgress = (data) => {
      const text = data.toString();
      const match = text.match(/(\d+(?:\.\d+)?)%/);
      if (!match) return;

      const dlPct = parseFloat(match[1]);
      const mapped = Math.round(12 + (dlPct / 100) * 20);
      if (mapped > lastPercent) {
        lastPercent = mapped;
        onProgress?.(
          `📥 Đang tải ${platform}... ${Math.round(dlPct)}%`,
          mapped
        );
      }
    };

    child.stdout.on('data', reportProgress);
    child.stderr.on('data', (data) => {
      const text = data.toString();
      stderrBuffer += text;
      if (stderrBuffer.length > 10000) {
        stderrBuffer = stderrBuffer.slice(-10000);
      }
      reportProgress(data);
    });

    child.on('error', (err) => {
      clearTimeout(timeout);
      if (finished) return;
      finished = true;
      reject(new Error(`Không thể chạy yt-dlp: ${err.message}`));
    });

    child.on('close', async (code) => {
      clearTimeout(timeout);
      if (finished) return;

      if (code === 0) {
        try {
          const exists = await fs.pathExists(outputPath);
          if (!exists) {
            finished = true;
            return reject(new Error('yt-dlp không tạo được file video.'));
          }

          const stat = await fs.stat(outputPath);
          if (!stat.size) {
            finished = true;
            return reject(new Error('yt-dlp tạo file video rỗng.'));
          }

          if (stat.size > MAX_REMOTE_VIDEO_SIZE_BYTES) {
            await safeRemove(outputPath);
            finished = true;
            return reject(
              new Error(`Video vượt quá giới hạn ${MAX_REMOTE_VIDEO_SIZE_MB} MB.`)
            );
          }

          finished = true;
          return resolve({ size: stat.size });
        } catch (err) {
          finished = true;
          return reject(err);
        }
      }

      const detail = stderrBuffer
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter(Boolean)
        .slice(-5)
        .join('\n');

      finished = true;
      reject(
        new Error(`yt-dlp thoát với mã lỗi ${code}${detail ? `: ${detail}` : ''}`)
      );
    });
  });
}

// =========================================================
// EXTRACT AUDIO
// =========================================================

function extractAudio(videoPath, audioPath, onProgress) {
  onProgress?.('🎵 Đang trích xuất audio...', 35);

  return new Promise((resolve, reject) => {
    execFile(
      ffmpegPath,
      [
        '-i', videoPath,
        '-vn',
        '-ar', '16000',
        '-ac', '1',
        '-b:a', '128k',
        '-y',
        audioPath,
        '-loglevel', 'error',
      ],
      (err, _stdout, stderr) => {
        if (err) {
          return reject(
            new Error(`ffmpeg lỗi: ${stderr || err.message}`)
          );
        }
        resolve();
      }
    );
  });
}

// =========================================================
// PROCESS UPLOADED FILE
// =========================================================

async function processUploadedFile(uploadedFilePath, jobId, onProgress) {
  const outputDir = path.join(__dirname, '..', 'temp', jobId);
  await fs.ensureDir(outputDir);

  const videoPath = path.join(outputDir, 'video.mp4');
  const audioPath = path.join(outputDir, 'audio.mp3');

  onProgress?.('📁 Đang chuẩn bị video tải lên...', 15);

  // Remux or transcode to MP4 H.264
  await new Promise((resolve, reject) => {
    execFile(
      ffmpegPath,
      [
        '-i', uploadedFilePath,
        '-c:v', 'copy',
        '-c:a', 'aac',
        '-movflags', '+faststart',
        '-y',
        videoPath,
      ],
      (err) => {
        if (
          !err &&
          fs.existsSync(videoPath) &&
          fs.statSync(videoPath).size > 0
        ) {
          return resolve();
        }

        // Fallback: transcode H.264
        execFile(
          ffmpegPath,
          [
            '-i', uploadedFilePath,
            '-c:v', 'libx264',
            '-preset', 'veryfast',
            '-crf', '23',
            '-c:a', 'aac',
            '-movflags', '+faststart',
            '-y',
            videoPath,
          ],
          (transcodeErr, _stdout, stderr) => {
            if (transcodeErr) {
              return reject(
                new Error(
                  `Không thể xử lý file video tải lên: ${
                    stderr || transcodeErr.message
                  }`
                )
              );
            }
            resolve();
          }
        );
      }
    );
  });

  if (!fs.existsSync(videoPath) || (await fs.stat(videoPath)).size === 0) {
    throw new Error('Xử lý file video tải lên thất bại: file trống hoặc không hợp lệ.');
  }

  // Extract audio
  await extractAudio(videoPath, audioPath, onProgress);

  if (!fs.existsSync(audioPath) || (await fs.stat(audioPath)).size === 0) {
    throw new Error('Trích xuất audio từ file tải lên thất bại.');
  }

  return { videoPath, audioPath };
}

// =========================================================
// MAIN PROCESS (URL)
// =========================================================

async function processVideo(url, jobId, onProgress) {
  const outputDir = path.join(__dirname, '..', 'temp', jobId);
  await fs.ensureDir(outputDir);

  const videoPath = path.join(outputDir, 'video.mp4');
  const audioPath = path.join(outputDir, 'audio.mp3');

  if (typeof url !== 'string' || !url.trim()) {
    throw new Error('URL video không hợp lệ.');
  }

  url = url.trim();
  const platform = getPlatformName(url);

  console.log(`[videoProcessor] Processing ${platform}: ${url}`);

  // 1. Direct video URL
  if (isDirectVideoUrl(url)) {
    await downloadDirectVideo(url, videoPath, onProgress);
  }
  // 2. TikTok
  else if (isTikTokUrl(url)) {
    try {
      await downloadTikTokVideo(url, videoPath, onProgress);
    } catch (tikErr) {
      console.warn(
        '[processVideo] TikTok API failed, trying yt-dlp fallback:',
        tikErr.message
      );
      onProgress?.(
        '⚠️ TikTok API thất bại, đang thử phương án dự phòng...',
        12
      );
      await downloadWithYtDlp(url, videoPath, onProgress);
    }
  }
  // 3. YouTube and other platforms (Facebook, Instagram, Twitter, etc.)
  else {
    await downloadWithYtDlp(url, videoPath, onProgress);
  }

  // Verify video file exists
  if (!fs.existsSync(videoPath)) {
    throw new Error(`Tải video ${platform} thất bại: file không tồn tại.`);
  }

  const videoStat = await fs.stat(videoPath);
  if (videoStat.size === 0) {
    throw new Error(`Tải video ${platform} thất bại: file trống.`);
  }

  console.log(
    `[videoProcessor] Video downloaded: ${
      Math.round((videoStat.size / 1024 / 1024) * 10) / 10
    } MB`
  );

  // Extract audio
  await extractAudio(videoPath, audioPath, onProgress);

  // Verify audio file exists
  if (!fs.existsSync(audioPath)) {
    throw new Error('Trích xuất audio thất bại: file audio không tồn tại.');
  }

  const audioStat = await fs.stat(audioPath);
  if (audioStat.size === 0) {
    throw new Error('Trích xuất audio thất bại: file audio rỗng.');
  }

  return { videoPath, audioPath };
}

// =========================================================
// EXPORT
// =========================================================

module.exports = {
  process: processVideo,
  processUploadedFile,
};