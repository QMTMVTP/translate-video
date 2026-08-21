const { execFile, spawn } = require('child_process');
const { Readable } = require('stream');
const { pipeline } = require('stream/promises');
const path = require('path');
const fs = require('fs-extra');
const ffmpegPath = require('ffmpeg-static');

const BIN_DIR = path.join(__dirname, '..', 'bin');
const BIN_PATH = path.join(
  BIN_DIR,
  process.platform === 'win32' ? 'yt-dlp.exe' : 'yt-dlp'
);

let ytDlpPath = null;

/**
 * Maximum video size we allow the processor to work with.
 *
 * This is mainly a safety limit for Render Free.
 * 200 MB is much safer than allowing 500 MB+ files on a 512 MB instance.
 */
const MAX_VIDEO_SIZE = 200 * 1024 * 1024;

/**
 * Check whether a downloaded file is valid.
 */
async function verifyVideoFile(videoPath) {
  if (!(await fs.pathExists(videoPath))) {
    throw new Error('File video không tồn tại sau khi tải.');
  }

  const stat = await fs.stat(videoPath);

  if (!stat.isFile() || stat.size <= 0) {
    throw new Error('File video rỗng hoặc không hợp lệ.');
  }

  if (stat.size > MAX_VIDEO_SIZE) {
    await fs.remove(videoPath).catch(() => {});

    throw new Error(
      `Video quá lớn. Giới hạn hiện tại là ${Math.round(
        MAX_VIDEO_SIZE / 1024 / 1024
      )} MB để tránh máy chủ hết RAM.`
    );
  }

  return stat.size;
}

/**
 * Find yt-dlp.
 *
 * Windows:
 *   ./bin/yt-dlp.exe
 *
 * Linux / Render:
 *   system command "yt-dlp"
 */
async function getYtDlp(onProgress) {
  if (ytDlpPath) {
    return ytDlpPath;
  }

  // ---------------------------------------------------------
  // Windows
  // ---------------------------------------------------------
  if (process.platform === 'win32') {
    await fs.ensureDir(BIN_DIR);

    const hasBinary = await fs.pathExists(BIN_PATH);

    console.log(
      `[yt-dlp] Windows binary ${
        hasBinary ? 'đã tìm thấy' : 'không tìm thấy'
      }: ${BIN_PATH}`
    );

    if (!hasBinary) {
      throw new Error(
        'Không tìm thấy bin/yt-dlp.exe. Vui lòng đặt yt-dlp.exe vào thư mục bin/.'
      );
    }

    ytDlpPath = BIN_PATH;

    onProgress &&
      onProgress(
        '🔧 Đã tìm thấy yt-dlp, đang khởi động công cụ tải video...',
        12
      );

    return ytDlpPath;
  }

  // ---------------------------------------------------------
  // Linux / Render
  // ---------------------------------------------------------
  console.log('[yt-dlp] Linux/Render: using system yt-dlp');

  ytDlpPath = 'yt-dlp';

  onProgress &&
    onProgress(
      '🔧 Đang sử dụng yt-dlp trên máy chủ...',
      12
    );

  return ytDlpPath;
}

/**
 * Detect platform name from URL.
 */
function getPlatformName(url) {
  if (/youtube\.com|youtu\.be/i.test(url)) {
    return 'YouTube';
  }

  if (/tiktok\.com/i.test(url)) {
    return 'TikTok';
  }

  if (/facebook\.com|fb\.com|fb\.watch/i.test(url)) {
    return 'Facebook';
  }

  if (/instagram\.com/i.test(url)) {
    return 'Instagram';
  }

  if (/twitter\.com|x\.com/i.test(url)) {
    return 'Twitter/X';
  }

  return 'video';
}

/**
 * Check if URL is TikTok.
 */
function isTikTokUrl(url) {
  return /tiktok\.com/i.test(url);
}

/**
 * Check if URL is a direct video file.
 */
function isDirectVideoUrl(url) {
  return /\.(mp4|webm|mov|mkv|avi|flv|m4v)(\?.*)?$/i.test(url);
}

/**
 * Stream HTTP response directly to disk.
 *
 * IMPORTANT:
 * We intentionally do NOT do:
 *
 *   const chunks = [];
 *   chunks.push(...)
 *   Buffer.concat(chunks)
 *
 * because that can consume hundreds of MB of RAM.
 */
async function streamResponseToFile(response, outputPath, onProgress) {
  if (!response.body) {
    throw new Error('Máy chủ không trả về dữ liệu video.');
  }

  const contentLength = response.headers.get('content-length');
  const totalBytes = contentLength
    ? parseInt(contentLength, 10)
    : 0;

  let receivedBytes = 0;
  let lastReportedPercent = -1;

  // Convert Web ReadableStream -> Node.js Readable
  const sourceStream = Readable.fromWeb(response.body);

  const progressStream = new (require('stream').Transform)({
    transform(chunk, encoding, callback) {
      receivedBytes += chunk.length;

      if (totalBytes > 0 && onProgress) {
        const percent = Math.min(
          100,
          Math.round((receivedBytes / totalBytes) * 100)
        );

        if (percent !== lastReportedPercent) {
          lastReportedPercent = percent;

          const mapped = Math.round(
            12 + (percent / 100) * 20
          );

          onProgress(
            `📥 Đang tải... ${percent}%`,
            mapped
          );
        }
      }

      callback(null, chunk);
    },
  });

  await pipeline(
    sourceStream,
    progressStream,
    fs.createWriteStream(outputPath)
  );
}

/**
 * Download TikTok video using TikWM API.
 *
 * The important RAM optimization here is:
 *
 * TikTok
 *   ↓
 * fetch stream
 *   ↓
 * file on disk
 *
 * NOT:
 *
 * TikTok
 *   ↓
 * RAM Buffer
 *   ↓
 * file
 */
async function downloadTikTokVideo(
  url,
  outputPath,
  onProgress
) {
  onProgress &&
    onProgress('📥 Đang kết nối tới TikTok...', 12);

  const res = await fetch('https://www.tikwm.com/api/', {
    method: 'POST',
    headers: {
      'Content-Type':
        'application/x-www-form-urlencoded; charset=UTF-8',

      'User-Agent':
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120.0.0.0 Safari/537.36',
    },

    body: new URLSearchParams({
      url,
      count: '12',
      cursor: '0',
      web: '1',
      hd: '1',
    }),
  });

  if (!res.ok) {
    throw new Error(
      `TikTok API trả về HTTP ${res.status}`
    );
  }

  const json = await res.json();

  if (json.code !== 0 || !json.data) {
    throw new Error(
      json.msg ||
        'Không thể lấy liên kết video TikTok.'
    );
  }

  const playUrl =
    json.data.hdplay ||
    json.data.play ||
    json.data.wmplay;

  if (!playUrl) {
    throw new Error(
      'Không tìm thấy link phát video TikTok.'
    );
  }

  const fullDownloadUrl = playUrl.startsWith('http')
    ? playUrl
    : `https://www.tikwm.com${playUrl}`;

  onProgress &&
    onProgress(
      '📥 Đang tải video TikTok...',
      18
    );

  const vidRes = await fetch(fullDownloadUrl, {
    headers: {
      'User-Agent':
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120.0.0.0 Safari/537.36',

      Referer: 'https://www.tiktok.com/',
    },
  });

  if (!vidRes.ok) {
    throw new Error(
      `Tải file video TikTok thất bại: HTTP ${vidRes.status}`
    );
  }

  await streamResponseToFile(
    vidRes,
    outputPath,
    onProgress
  );

  await verifyVideoFile(outputPath);
}

/**
 * Download direct video URL.
 *
 * Streams directly to disk instead of keeping
 * the entire video in RAM.
 */
async function downloadDirectVideo(
  url,
  outputPath,
  onProgress
) {
  onProgress &&
    onProgress(
      '📥 Đang tải video trực tiếp...',
      12
    );

  const response = await fetch(url);

  if (!response.ok) {
    throw new Error(
      `Không thể tải video: HTTP ${response.status} ${response.statusText}`
    );
  }

  await streamResponseToFile(
    response,
    outputPath,
    onProgress
  );

  await verifyVideoFile(outputPath);
}

/**
 * Download video using yt-dlp.
 */
async function downloadWithYtDlp(
  url,
  outputPath,
  onProgress
) {
  const platform = getPlatformName(url);

  onProgress &&
    onProgress(
      `📥 Đang tải video từ ${platform}...`,
      12
    );

  const ytPath = await getYtDlp(onProgress);

  onProgress &&
    onProgress(
      `📡 yt-dlp đã sẵn sàng, đang kết nối tới ${platform}...`,
      12
    );

  return new Promise((resolve, reject) => {
    const args = [
      url,

      '-o',
      outputPath,

      // Prefer MP4 <= 1080p.
      '--format',
      'bestvideo[ext=mp4][height<=1080]+bestaudio[ext=m4a]/best[ext=mp4]/best',

      '--merge-output-format',
      'mp4',

      '--no-playlist',

      '--no-warnings',

      '--progress',

      // Use ffmpeg-static bundled with Node package.
      '--ffmpeg-location',
      ffmpegPath,

      // JavaScript runtime.
      '--js-runtimes',
      `node:${process.execPath}`,

      // YouTube player client.
      '--extractor-args',
      'youtube:player_client=web_embedded',

      // ---------------------------------------------------
      // RAM optimization
      // ---------------------------------------------------

      // Only one fragment at a time.
      '--concurrent-fragments',
      '1',

      // Smaller internal buffer.
      '--buffer-size',
      '1M',

      // Do not keep unnecessary metadata.
      '--no-mtime',

      // Continue partial download if possible.
      '--continue',
    ];

    const ytProcess = spawn(
      ytPath,
      args,
      {
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
      }
    );

    let lastPercent = 12;
    let lastErrorOutput = '';

    ytProcess.on('spawn', () => {
      onProgress &&
        onProgress(
          `📡 yt-dlp đang lấy thông tin video từ ${platform}...`,
          12
        );
    });

    const reportYtDlpOutput = (data) => {
      const str = data.toString();

      const match = str.match(/(\d+\.?\d*)%/);

      if (match && onProgress) {
        const dlPct = parseFloat(match[1]);

        const mapped = Math.round(
          12 + (dlPct / 100) * 20
        );

        if (mapped > lastPercent) {
          lastPercent = mapped;

          onProgress(
            `📥 Đang tải từ ${platform}... ${Math.round(
              dlPct
            )}%`,
            mapped
          );
        }
      }
    };

    ytProcess.stdout.on(
      'data',
      reportYtDlpOutput
    );

    ytProcess.stderr.on('data', (data) => {
      const str = data.toString();

      // Keep only the last 2KB of error output.
      // This prevents unnecessary memory growth.
      lastErrorOutput += str;

      if (lastErrorOutput.length > 2000) {
        lastErrorOutput =
          lastErrorOutput.slice(-2000);
      }

      reportYtDlpOutput(data);
    });

    ytProcess.on('close', async (code) => {
      if (code === 0) {
        try {
          await verifyVideoFile(outputPath);
          resolve();
        } catch (err) {
          reject(err);
        }

        return;
      }

      const detail = lastErrorOutput
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter(
          (line) =>
            line.startsWith('ERROR:') ||
            line.startsWith('WARNING:')
        )
        .at(-1);

      reject(
        new Error(
          `yt-dlp thoát với mã lỗi ${code}${
            detail ? `: ${detail}` : ''
          }`
        )
      );
    });

    ytProcess.on('error', reject);
  });
}

/**
 * Extract audio using ffmpeg-static.
 *
 * Audio is written directly to disk.
 */
function extractAudio(
  videoPath,
  audioPath,
  onProgress
) {
  onProgress &&
    onProgress(
      '🎵 Đang trích xuất audio...',
      35
    );

  return new Promise((resolve, reject) => {
    execFile(
      ffmpegPath,
      [
        '-i',
        videoPath,

        '-vn',

        '-ar',
        '16000',

        '-ac',
        '1',

        '-b:a',
        '64k',

        '-y',

        '-loglevel',
        'error',

        audioPath,
      ],
      {
        maxBuffer: 1024 * 1024,
      },
      (err, stdout, stderr) => {
        if (err) {
          reject(
            new Error(
              `ffmpeg lỗi: ${
                stderr || err.message
              }`
            )
          );
        } else {
          resolve();
        }
      }
    );
  });
}

/**
 * Process uploaded video file.
 *
 * Multer already writes the upload to disk,
 * so we do not load the uploaded file into RAM.
 */
async function processUploadedFile(
  uploadedFilePath,
  jobId,
  onProgress
) {
  const outputDir = path.join(
    __dirname,
    '..',
    'temp',
    jobId
  );

  await fs.ensureDir(outputDir);

  const videoPath = path.join(
    outputDir,
    'video.mp4'
  );

  const audioPath = path.join(
    outputDir,
    'audio.mp3'
  );

  onProgress &&
    onProgress(
      '📁 Đang chuẩn bị video tải lên...',
      15
    );

  // Check uploaded file before processing.
  const uploadedStat =
    await fs.stat(uploadedFilePath);

  if (uploadedStat.size <= 0) {
    throw new Error(
      'File video tải lên bị rỗng.'
    );
  }

  if (uploadedStat.size > MAX_VIDEO_SIZE) {
    throw new Error(
      `Video quá lớn. Giới hạn hiện tại là ${Math.round(
        MAX_VIDEO_SIZE / 1024 / 1024
      )} MB.`
    );
  }

  /**
   * First attempt:
   * Remux/copy video without re-encoding.
   *
   * This is much lighter on CPU/RAM.
   */
  await new Promise((resolve, reject) => {
    execFile(
      ffmpegPath,
      [
        '-i',
        uploadedFilePath,

        '-c:v',
        'copy',

        '-c:a',
        'aac',

        '-movflags',
        '+faststart',

        '-y',

        videoPath,
      ],
      {
        maxBuffer: 1024 * 1024,
      },
      async (err, stdout, stderr) => {
        if (
          !err &&
          (await fs.pathExists(videoPath))
        ) {
          const stat =
            await fs.stat(videoPath);

          if (stat.size > 0) {
            return resolve();
          }
        }

        /**
         * Fallback:
         * Re-encode using H.264.
         *
         * Still relatively light because of veryfast.
         */
        execFile(
          ffmpegPath,
          [
            '-i',
            uploadedFilePath,

            '-c:v',
            'libx264',

            '-preset',
            'veryfast',

            '-crf',
            '23',

            '-c:a',
            'aac',

            '-movflags',
            '+faststart',

            '-y',

            videoPath,
          ],
          {
            maxBuffer: 1024 * 1024,
          },
          (transcodeErr, stdout2, stderr2) => {
            if (transcodeErr) {
              reject(
                new Error(
                  `Không thể xử lý file video tải lên: ${
                    stderr2 ||
                    transcodeErr.message
                  }`
                )
              );
            } else {
              resolve();
            }
          }
        );
      }
    );
  });

  await verifyVideoFile(videoPath);

  // Extract audio.
  await extractAudio(
    videoPath,
    audioPath,
    onProgress
  );

  // Verify audio.
  if (
    !(await fs.pathExists(audioPath))
  ) {
    throw new Error(
      'Trích xuất audio thất bại.'
    );
  }

  const audioStat =
    await fs.stat(audioPath);

  if (audioStat.size <= 0) {
    throw new Error(
      'File audio bị rỗng.'
    );
  }

  return {
    videoPath,
    audioPath,
  };
}

/**
 * Main process function for URL.
 */
async function processVideo(
  url,
  jobId,
  onProgress
) {
  const outputDir = path.join(
    __dirname,
    '..',
    'temp',
    jobId
  );

  await fs.ensureDir(outputDir);

  const videoPath = path.join(
    outputDir,
    'video.mp4'
  );

  const audioPath = path.join(
    outputDir,
    'audio.mp3'
  );

  try {
    /**
     * Direct video URL
     */
    if (isDirectVideoUrl(url)) {
      await downloadDirectVideo(
        url,
        videoPath,
        onProgress
      );
    }

    /**
     * TikTok
     *
     * Try TikWM first.
     * If that fails, use yt-dlp.
     */
    else if (isTikTokUrl(url)) {
      try {
        await downloadTikTokVideo(
          url,
          videoPath,
          onProgress
        );
      } catch (tikErr) {
        console.warn(
          '[processVideo] TikTok API failed, trying yt-dlp fallback:',
          tikErr.message
        );

        await downloadWithYtDlp(
          url,
          videoPath,
          onProgress
        );
      }
    }

    /**
     * Other platforms
     */
    else {
      await downloadWithYtDlp(
        url,
        videoPath,
        onProgress
      );
    }

    /**
     * Verify final video.
     */
    await verifyVideoFile(videoPath);

    /**
     * Extract audio.
     */
    await extractAudio(
      videoPath,
      audioPath,
      onProgress
    );

    /**
     * Verify audio.
     */
    if (
      !(await fs.pathExists(audioPath))
    ) {
      throw new Error(
        'Trích xuất audio thất bại.'
      );
    }

    const audioStat =
      await fs.stat(audioPath);

    if (audioStat.size <= 0) {
      throw new Error(
        'File audio bị rỗng.'
      );
    }

    return {
      videoPath,
      audioPath,
    };
  } catch (error) {
    /**
     * Cleanup partially downloaded files
     * if processing fails.
     */
    await fs.remove(videoPath).catch(
      () => {}
    );

    await fs.remove(audioPath).catch(
      () => {}
    );

    throw error;
  }
}

module.exports = {
  process: processVideo,
  processUploadedFile,
};