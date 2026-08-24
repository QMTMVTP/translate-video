const { execFile } = require('child_process');
const path = require('path');
const fs = require('fs-extra');
const ffmpegPath = require('ffmpeg-static');

const BIN_DIR = path.join(__dirname, '..', 'bin');

const MAX_DOWNLOAD_SIZE = 500 * 1024 * 1024; // 500 MB

/**
 * ============================================================
 * Helpers
 * ============================================================
 */

function isYouTubeUrl(url) {
  return /(?:youtube\.com|youtu\.be)/i.test(url);
}

function isTikTokUrl(url) {
  return /tiktok\.com/i.test(url);
}

function isDirectVideoUrl(url) {
  return /\.(mp4|webm|mov|mkv|avi|flv|m4v)(\?.*)?$/i.test(url);
}

function getPlatformName(url) {
  if (isYouTubeUrl(url)) return 'YouTube';
  if (isTikTokUrl(url)) return 'TikTok';
  if (/facebook\.com|fb\.com|fb\.watch/i.test(url)) return 'Facebook';
  if (/instagram\.com/i.test(url)) return 'Instagram';
  if (/twitter\.com|x\.com/i.test(url)) return 'Twitter/X';

  return 'video';
}

/**
 * ============================================================
 * Download direct video URL
 * ============================================================
 */

async function downloadDirectVideo(url, outputPath, onProgress) {
  onProgress?.('📥 Đang tải video trực tiếp...', 12);

  const response = await fetch(url);

  if (!response.ok) {
    throw new Error(
      `Không thể tải video: HTTP ${response.status} ${response.statusText}`
    );
  }

  if (!response.body) {
    throw new Error('Server không trả về dữ liệu video.');
  }

  const contentLength = response.headers.get('content-length');
  const totalBytes = contentLength
    ? parseInt(contentLength, 10)
    : 0;

  if (totalBytes > MAX_DOWNLOAD_SIZE) {
    throw new Error('Video vượt quá giới hạn 500 MB.');
  }

  await fs.ensureDir(path.dirname(outputPath));

  const file = await fs.open(outputPath, 'w');

  let received = 0;

  try {
    const reader = response.body.getReader();

    while (true) {
      const { done, value } = await reader.read();

      if (done) break;

      if (value) {
        await file.write(Buffer.from(value));

        received += value.length;

        if (totalBytes > 0) {
          const percent = Math.min(
            100,
            Math.round((received / totalBytes) * 100)
          );

          const mapped = Math.round(
            12 + (percent / 100) * 18
          );

          onProgress?.(
            `📥 Đang tải... ${percent}%`,
            mapped
          );
        }
      }
    }
  } finally {
    await file.close();
  }
}

/**
 * ============================================================
 * TikTok
 * ============================================================
 */

async function downloadTikTokVideo(url, outputPath, onProgress) {
  onProgress?.('📥 Đang kết nối tới TikTok...', 12);

  const response = await fetch('https://www.tikwm.com/api/', {
    method: 'POST',

    headers: {
      'Content-Type':
        'application/x-www-form-urlencoded; charset=UTF-8',

      'User-Agent':
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120 Safari/537.36',
    },

    body: new URLSearchParams({
      url,
      count: '12',
      cursor: '0',
      web: '1',
      hd: '1',
    }),
  });

  if (!response.ok) {
    throw new Error(
      `TikTok API trả về HTTP ${response.status}`
    );
  }

  const json = await response.json();

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

  const fullUrl =
    playUrl.startsWith('http')
      ? playUrl
      : `https://www.tikwm.com${playUrl}`;

  onProgress?.(
    '📥 Đang tải video TikTok...',
    18
  );

  await downloadDirectVideo(
    fullUrl,
    outputPath,
    onProgress
  );
}

/**
 * ============================================================
 * YouTube Downloader Worker
 * ============================================================
 *
 * Render KHÔNG chạy yt-dlp.
 *
 * Render gọi một service bên ngoài:
 *
 * POST ${YOUTUBE_DOWNLOADER_URL}/download
 *
 * Body:
 *
 * {
 *   "url": "https://youtube.com/..."
 * }
 *
 * Response:
 *
 * Content-Type: video/mp4
 *
 * Worker bên ngoài mới chạy yt-dlp.
 *
 * ============================================================
 */

async function downloadYouTubeVideo(
  url,
  outputPath,
  onProgress
) {
  const downloaderUrl =
    process.env.YOUTUBE_DOWNLOADER_URL;

  if (!downloaderUrl) {
    throw new Error(
      'Chưa cấu hình YOUTUBE_DOWNLOADER_URL trên Render.'
    );
  }

  onProgress?.(
    '📡 Đang kết nối YouTube Downloader...',
    12
  );

  const endpoint =
    `${downloaderUrl.replace(/\/$/, '')}/download`;

  const controller = new AbortController();

  // 10 phút timeout
  const timeout = setTimeout(() => {
    controller.abort();
  }, 10 * 60 * 1000);

  try {
    const response = await fetch(endpoint, {
      method: 'POST',

      headers: {
        'Content-Type': 'application/json',

        ...(process.env.YOUTUBE_DOWNLOADER_KEY
          ? {
              Authorization:
                `Bearer ${process.env.YOUTUBE_DOWNLOADER_KEY}`,
            }
          : {}),
      },

      body: JSON.stringify({
        url,
      }),

      signal: controller.signal,
    });

    if (!response.ok) {
      let detail = '';

      try {
        detail = await response.text();
      } catch {}

      throw new Error(
        `YouTube Downloader HTTP ${response.status}` +
        (detail ? `: ${detail.slice(0, 500)}` : '')
      );
    }

    if (!response.body) {
      throw new Error(
        'YouTube Downloader không trả về video.'
      );
    }

    const contentLength =
      response.headers.get('content-length');

    const totalBytes = contentLength
      ? parseInt(contentLength, 10)
      : 0;

    if (
      totalBytes > MAX_DOWNLOAD_SIZE
    ) {
      throw new Error(
        'Video YouTube vượt quá giới hạn 500 MB.'
      );
    }

    await fs.ensureDir(
      path.dirname(outputPath)
    );

    const file = await fs.open(
      outputPath,
      'w'
    );

    let received = 0;

    try {
      const reader =
        response.body.getReader();

      while (true) {
        const { done, value } =
          await reader.read();

        if (done) break;

        if (!value) continue;

        await file.write(
          Buffer.from(value)
        );

        received += value.length;

        if (totalBytes > 0) {
          const percent = Math.min(
            100,
            Math.round(
              (received / totalBytes) * 100
            )
          );

          const mapped = Math.round(
            12 + (percent / 100) * 20
          );

          onProgress?.(
            `📥 Đang tải YouTube... ${percent}%`,
            mapped
          );
        } else {
          onProgress?.(
            '📥 Đang nhận video YouTube...',
            25
          );
        }
      }
    } finally {
      await file.close();
    }

    onProgress?.(
      '✅ Đã tải video YouTube.',
      32
    );
  } catch (err) {
    if (err.name === 'AbortError') {
      throw new Error(
        'Tải video YouTube quá thời gian cho phép.'
      );
    }

    throw err;
  } finally {
    clearTimeout(timeout);
  }
}

/**
 * ============================================================
 * Extract audio
 * ============================================================
 */

function extractAudio(
  videoPath,
  audioPath,
  onProgress
) {
  onProgress?.(
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
        '96k',

        '-y',

        audioPath,

        '-loglevel',
        'error',
      ],

      {
        windowsHide: true,
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

          return;
        }

        resolve();
      }
    );
  });
}

/**
 * ============================================================
 * Validate downloaded video
 * ============================================================
 */

async function validateVideo(videoPath) {
  if (
    !(await fs.pathExists(videoPath))
  ) {
    throw new Error(
      'File video không tồn tại.'
    );
  }

  const stat =
    await fs.stat(videoPath);

  if (stat.size === 0) {
    throw new Error(
      'File video rỗng.'
    );
  }

  if (
    stat.size > MAX_DOWNLOAD_SIZE
  ) {
    await fs.remove(videoPath);

    throw new Error(
      'Video vượt quá giới hạn 500 MB.'
    );
  }
}

/**
 * ============================================================
 * Process uploaded video
 * ============================================================
 */

async function processUploadedFile(
  uploadedFilePath,
  jobId,
  onProgress
) {
  const outputDir =
    path.join(
      __dirname,
      '..',
      'temp',
      jobId
    );

  await fs.ensureDir(outputDir);

  const videoPath =
    path.join(
      outputDir,
      'video.mp4'
    );

  const audioPath =
    path.join(
      outputDir,
      'audio.mp3'
    );

  onProgress?.(
    '📁 Đang chuẩn bị video tải lên...',
    15
  );

  await new Promise(
    (resolve, reject) => {
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

          '-loglevel',
          'error',
        ],

        {
          windowsHide: true,
        },

        (
          err,
          stdout,
          stderr
        ) => {
          if (err) {
            reject(
              new Error(
                `Không thể xử lý video: ${
                  stderr || err.message
                }`
              )
            );

            return;
          }

          resolve();
        }
      );
    }
  );

  await validateVideo(videoPath);

  await extractAudio(
    videoPath,
    audioPath,
    onProgress
  );

  if (
    !(await fs.pathExists(audioPath))
  ) {
    throw new Error(
      'Trích xuất audio thất bại.'
    );
  }

  return {
    videoPath,
    audioPath,
  };
}

/**
 * ============================================================
 * Main URL processor
 * ============================================================
 */

async function processVideo(
  url,
  jobId,
  onProgress
) {
  const outputDir =
    path.join(
      __dirname,
      '..',
      'temp',
      jobId
    );

  await fs.ensureDir(outputDir);

  const videoPath =
    path.join(
      outputDir,
      'video.mp4'
    );

  const audioPath =
    path.join(
      outputDir,
      'audio.mp3'
    );

  const platform =
    getPlatformName(url);

  onProgress?.(
    `🔎 Đang nhận diện ${platform}...`,
    8
  );

  /**
   * YouTube
   *
   * KHÔNG dùng yt-dlp trên Render.
   */
  if (isYouTubeUrl(url)) {
    await downloadYouTubeVideo(
      url,
      videoPath,
      onProgress
    );
  }

  /**
   * TikTok
   */
  else if (isTikTokUrl(url)) {
    try {
      await downloadTikTokVideo(
        url,
        videoPath,
        onProgress
      );
    } catch (err) {
      throw new Error(
        `Không thể tải TikTok: ${err.message}`
      );
    }
  }

  /**
   * Direct video URL
   */
  else if (isDirectVideoUrl(url)) {
    await downloadDirectVideo(
      url,
      videoPath,
      onProgress
    );
  }

  /**
   * Những nền tảng khác
   *
   * Không còn fallback yt-dlp.
   */
  else {
    throw new Error(
      'Link này chưa được hỗ trợ. Hiện tại hệ thống hỗ trợ YouTube, TikTok và link video trực tiếp.'
    );
  }

  /**
   * Validate
   */
  await validateVideo(videoPath);

  onProgress?.(
    '✅ Video đã tải xong.',
    32
  );

  /**
   * Extract audio
   */
  await extractAudio(
    videoPath,
    audioPath,
    onProgress
  );

  if (
    !(await fs.pathExists(audioPath))
  ) {
    throw new Error(
      'Trích xuất audio thất bại.'
    );
  }

  return {
    videoPath,
    audioPath,
  };
}

/**
 * ============================================================
 * Exports
 * ============================================================
 */

module.exports = {
  process: processVideo,
  processUploadedFile,
};