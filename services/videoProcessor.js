const { execFile, spawn } = require('child_process');
const path = require('path');
const fs = require('fs-extra');
const ffmpegPath = require('ffmpeg-static');

const BIN_DIR = path.join(__dirname, '..', 'bin');
const BIN_PATH = path.join(BIN_DIR, process.platform === 'win32' ? 'yt-dlp.exe' : 'yt-dlp');

let ytDlpPath = null;

async function getYtDlp(onProgress) {
  if (ytDlpPath) return ytDlpPath;

  await fs.ensureDir(BIN_DIR);

  const hasBinary = await fs.pathExists(BIN_PATH);
  console.log(`[yt-dlp] Binary ${hasBinary ? 'đã tìm thấy' : 'không tìm thấy'}: ${BIN_PATH}`);

  if (!hasBinary) {
    throw new Error('Không tìm thấy bin/yt-dlp.exe. Vui lòng cài lại công cụ tải video.');
  } else {
    onProgress && onProgress('🔧 Đã tìm thấy yt-dlp, đang khởi động công cụ tải video...', 12);
  }

  ytDlpPath = BIN_PATH;
  return ytDlpPath;
}

/**
 * Detect platform name from URL for friendly messages
 */
function getPlatformName(url) {
  if (/youtube\.com|youtu\.be/i.test(url)) return 'YouTube';
  if (/tiktok\.com/i.test(url)) return 'TikTok';
  if (/facebook\.com|fb\.com|fb\.watch/i.test(url)) return 'Facebook';
  if (/instagram\.com/i.test(url)) return 'Instagram';
  if (/twitter\.com|x\.com/i.test(url)) return 'Twitter/X';
  return 'video';
}

/**
 * Check if URL is TikTok
 */
function isTikTokUrl(url) {
  return /tiktok\.com/i.test(url);
}

/**
 * Download TikTok video using high-speed API (bypasses bot challenge)
 */
async function downloadTikTokVideo(url, outputPath, onProgress) {
  onProgress && onProgress('📥 Đang kết nối tới TikTok...', 12);

  const res = await fetch('https://www.tikwm.com/api/', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    },
    body: new URLSearchParams({
      url,
      count: 12,
      cursor: 0,
      web: 1,
      hd: 1,
    }),
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

  const fullDownloadUrl = playUrl.startsWith('http') ? playUrl : `https://www.tikwm.com${playUrl}`;
  onProgress && onProgress('📥 Đang tải video TikTok...', 18);

  const vidRes = await fetch(fullDownloadUrl, {
    headers: {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      Referer: 'https://www.tiktok.com/',
    },
  });

  if (!vidRes.ok) {
    throw new Error(`Tải file video TikTok thất bại: HTTP ${vidRes.status}`);
  }

  const contentLength = vidRes.headers.get('content-length');
  const totalBytes = contentLength ? parseInt(contentLength, 10) : 0;
  const chunks = [];
  let received = 0;

  const reader = vidRes.body.getReader();
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    received += value.length;
    if (totalBytes > 0 && onProgress) {
      const pct = Math.round(18 + (received / totalBytes) * 14);
      onProgress(`📥 Đang tải video TikTok... ${Math.round((received / totalBytes) * 100)}%`, pct);
    }
  }

  const buffer = Buffer.concat(chunks.map((c) => Buffer.from(c)));
  await fs.writeFile(outputPath, buffer);
}

/**
 * Check if URL is a direct video file link
 */
function isDirectVideoUrl(url) {
  return /\.(mp4|webm|mov|mkv|avi|flv|m4v)(\?.*)?$/i.test(url);
}

/**
 * Download a direct video URL using fetch
 */
async function downloadDirectVideo(url, outputPath, onProgress) {
  onProgress && onProgress('📥 Đang tải video trực tiếp...', 12);

  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`Không thể tải video: HTTP ${response.status} ${response.statusText}`);
  }

  const contentLength = response.headers.get('content-length');
  const totalBytes = contentLength ? parseInt(contentLength, 10) : 0;
  const chunks = [];
  let received = 0;

  const reader = response.body.getReader();
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    received += value.length;
    if (totalBytes > 0 && onProgress) {
      const pct = Math.round(12 + (received / totalBytes) * 18);
      onProgress(`📥 Đang tải... ${Math.round((received / totalBytes) * 100)}%`, pct);
    }
  }

  const buffer = Buffer.concat(chunks.map((c) => Buffer.from(c)));
  await fs.writeFile(outputPath, buffer);
}

/**
 * Download video using yt-dlp
 */
async function downloadWithYtDlp(url, outputPath, onProgress) {
  const platform = getPlatformName(url);
  onProgress && onProgress(`📥 Đang tải video từ ${platform}...`, 12);

  const ytPath = await getYtDlp(onProgress);
  onProgress && onProgress(`📡 yt-dlp đã sẵn sàng, đang kết nối tới ${platform}...`, 12);

  return new Promise((resolve, reject) => {
    const args = [
      url,
      '-o', outputPath,
      '--format', 'bestvideo[ext=mp4][height<=1080]+bestaudio[ext=m4a]/best[ext=mp4]/best',
      '--merge-output-format', 'mp4',
      '--no-playlist',
      '--no-warnings',
      '--progress',
      '--ffmpeg-location', ffmpegPath,
      '--js-runtimes', `node:${process.execPath}`,
      // This client avoids the PO Token requirement that causes 403 errors
      // for many anonymous YouTube media requests.
      '--extractor-args', 'youtube:player_client=web_embedded',
    ];

    const ytProcess = spawn(ytPath, args, { windowsHide: true });
    let lastPercent = 12;
    let lastErrorOutput = '';

    ytProcess.on('spawn', () => {
      onProgress && onProgress(`📡 yt-dlp đang lấy thông tin video từ ${platform}...`, 12);
    });

    const reportYtDlpOutput = (data) => {
      const str = data.toString();
      const match = str.match(/(\d+\.?\d*)%/);
      if (match && onProgress) {
        const dlPct = parseFloat(match[1]);
        const mapped = Math.round(12 + (dlPct / 100) * 20);
        if (mapped > lastPercent) {
          lastPercent = mapped;
          onProgress(`📥 Đang tải từ ${platform}... ${Math.round(dlPct)}%`, mapped);
        }
      }
    };

    // yt-dlp writes its live progress to stderr by default. Read both streams
    // so the UI does not appear stuck while a download is actually running.
    ytProcess.stdout.on('data', reportYtDlpOutput);
    ytProcess.stderr.on('data', (data) => {
      lastErrorOutput += data.toString();
      if (lastErrorOutput.length > 2000) lastErrorOutput = lastErrorOutput.slice(-2000);
      reportYtDlpOutput(data);
    });

    ytProcess.on('close', (code) => {
      if (code === 0) return resolve();
      const detail = lastErrorOutput
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter((line) => line.startsWith('ERROR:') || line.startsWith('WARNING:'))
        .at(-1);
      reject(new Error(`yt-dlp thoát với mã lỗi ${code}${detail ? `: ${detail}` : ''}`));
    });

    ytProcess.on('error', reject);
  });
}

/**
 * Extract audio from video using ffmpeg-static
 */
function extractAudio(videoPath, audioPath, onProgress) {
  onProgress && onProgress('🎵 Đang trích xuất audio...', 35);

  return new Promise((resolve, reject) => {
    execFile(
      ffmpegPath,
      [
        '-i', videoPath,
        '-vn',                // no video
        '-ar', '16000',       // 16kHz sample rate (Whisper optimal)
        '-ac', '1',           // mono
        '-b:a', '128k',
        audioPath,
        '-y',
        '-loglevel', 'error',
      ],
      (err, _stdout, stderr) => {
        if (err) {
          reject(new Error(`ffmpeg lỗi: ${stderr || err.message}`));
        } else {
          resolve();
        }
      }
    );
  });
}

/**
 * Process an uploaded video file: converts/prepares standard video.mp4 and extracts audio.mp3
 */
async function processUploadedFile(uploadedFilePath, jobId, onProgress) {
  const outputDir = path.join(__dirname, '..', 'temp', jobId);
  await fs.ensureDir(outputDir);

  const videoPath = path.join(outputDir, 'video.mp4');
  const audioPath = path.join(outputDir, 'audio.mp3');

  onProgress && onProgress('📁 Đang chuẩn bị video tải lên...', 15);

  // Remux or transcode to standard MP4 H.264
  await new Promise((resolve, reject) => {
    // Try fast copy/remux first
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
        if (!err && fs.existsSync(videoPath) && fs.statSync(videoPath).size > 0) {
          return resolve();
        }
        // Fallback: fast re-encode if copy not compatible
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
              reject(new Error(`Không thể xử lý file video tải lên: ${stderr || transcodeErr.message}`));
            } else {
              resolve();
            }
          }
        );
      }
    );
  });

  // Verify video file exists
  if (!fs.existsSync(videoPath) || (await fs.stat(videoPath)).size === 0) {
    throw new Error('Xử lý file video tải lên thất bại: file trống hoặc không hợp lệ.');
  }

  // Extract audio
  await extractAudio(videoPath, audioPath, onProgress);

  // Verify audio file
  if (!fs.existsSync(audioPath) || (await fs.stat(audioPath)).size === 0) {
    throw new Error('Trích xuất audio từ file tải lên thất bại.');
  }

  return { videoPath, audioPath };
}

/**
 * Main process function for URL
 */
async function processVideo(url, jobId, onProgress) {
  const outputDir = path.join(__dirname, '..', 'temp', jobId);
  await fs.ensureDir(outputDir);

  const videoPath = path.join(outputDir, 'video.mp4');
  const audioPath = path.join(outputDir, 'audio.mp3');

  // Download video
  if (isDirectVideoUrl(url)) {
    await downloadDirectVideo(url, videoPath, onProgress);
  } else if (isTikTokUrl(url)) {
    try {
      await downloadTikTokVideo(url, videoPath, onProgress);
    } catch (tikErr) {
      console.warn('[processVideo] TikTok API failed, trying yt-dlp fallback:', tikErr.message);
      await downloadWithYtDlp(url, videoPath, onProgress);
    }
  } else {
    try {
      await downloadWithYtDlp(url, videoPath, onProgress);
    } catch (dlErr) {
      if (isTikTokUrl(url)) {
        console.warn('[processVideo] yt-dlp failed, trying TikTok API fallback:', dlErr.message);
        await downloadTikTokVideo(url, videoPath, onProgress);
      } else {
        throw dlErr;
      }
    }
  }

  // Verify video file exists
  if (!fs.existsSync(videoPath) || (await fs.stat(videoPath)).size === 0) {
    throw new Error('Tải video thất bại: file trống hoặc không tồn tại.');
  }

  // Extract audio
  await extractAudio(videoPath, audioPath, onProgress);

  // Verify audio file
  if (!fs.existsSync(audioPath) || (await fs.stat(audioPath)).size === 0) {
    throw new Error('Trích xuất audio thất bại.');
  }

  return { videoPath, audioPath };
}

module.exports = {
  process: processVideo,
  processUploadedFile,
};
