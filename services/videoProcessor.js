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

// Server youtube-downloader trên Render
const YOUTUBE_DOWNLOADER_URL = (
  process.env.YOUTUBE_DOWNLOADER_URL || ''
).replace(/\/+$/, '');

// Token bảo vệ server downloader.
// Nếu youtube-downloader không cấu hình token thì để trống.
const DOWNLOADER_API_TOKEN =
  process.env.DOWNLOADER_API_TOKEN || '';

// Giới hạn video tải từ URL.
// youtube-downloader hiện đang mặc định tối đa 300 MB.
const MAX_REMOTE_VIDEO_SIZE_MB = Number(
  process.env.MAX_REMOTE_VIDEO_SIZE_MB || 300
);

const MAX_REMOTE_VIDEO_SIZE_BYTES =
  MAX_REMOTE_VIDEO_SIZE_MB * 1024 * 1024;

// Timeout tải video từ downloader / URL trực tiếp
const DOWNLOAD_TIMEOUT_MS = Number(
  process.env.DOWNLOAD_TIMEOUT_MS || 10 * 60 * 1000
);

// =========================================================
// YT-DLP LOCAL
// =========================================================
//
// Chỉ dùng cho TikTok fallback.
// YouTube KHÔNG sử dụng yt-dlp local nữa.
//

let ytDlpPath = null;

async function getYtDlp(onProgress) {
  if (ytDlpPath) {
    return ytDlpPath;
  }

  await fs.ensureDir(BIN_DIR);

  const hasBinary = await fs.pathExists(BIN_PATH);

  console.log(
    `[yt-dlp] Binary ${
      hasBinary ? 'đã tìm thấy' : 'không tìm thấy'
    }: ${BIN_PATH}`
  );

  if (!hasBinary) {
    throw new Error(
      'Không tìm thấy bin/yt-dlp.exe. Vui lòng cài yt-dlp để sử dụng fallback TikTok.'
    );
  }

  if (process.platform !== 'win32') {
    try {
      await fs.chmod(BIN_PATH, 0o755);
    } catch (err) {
      console.warn(
        '[yt-dlp] Không thể chmod binary:',
        err.message
      );
    }
  }

  onProgress?.(
    '🔧 Đã tìm thấy yt-dlp, đang khởi động...',
    12
  );

  ytDlpPath = BIN_PATH;

  return ytDlpPath;
}

// =========================================================
// PLATFORM
// =========================================================

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

function isYouTubeUrl(url) {
  try {
    const parsed = new URL(url);
    const hostname = parsed.hostname.toLowerCase();

    return (
      hostname === 'youtube.com' ||
      hostname === 'www.youtube.com' ||
      hostname === 'm.youtube.com' ||
      hostname === 'music.youtube.com' ||
      hostname === 'youtu.be' ||
      hostname === 'www.youtu.be'
    );
  } catch {
    return false;
  }
}

function isTikTokUrl(url) {
  return /tiktok\.com/i.test(url);
}

// =========================================================
// DIRECT VIDEO URL
// =========================================================

function isDirectVideoUrl(url) {
  return /\.(mp4|webm|mov|mkv|avi|flv|m4v|wmv|ts|3gp|ogv)(\?.*)?$/i.test(
    url
  );
}

// =========================================================
// HELPERS
// =========================================================

function safeRemove(filePath) {
  if (!filePath) return;

  return fs.remove(filePath).catch(() => {});
}

function createAbortController(timeoutMs) {
  const controller = new AbortController();

  const timer = setTimeout(() => {
    controller.abort();
  }, timeoutMs);

  // Không giữ Node process lại chỉ vì timer
  timer.unref?.();

  return {
    controller,
    clear: () => clearTimeout(timer),
  };
}

function getContentLength(response) {
  const value = response.headers.get('content-length');

  if (!value) {
    return 0;
  }

  const size = Number(value);

  if (!Number.isFinite(size) || size < 0) {
    return 0;
  }

  return size;
}

// =========================================================
// STREAM RESPONSE TO FILE
// =========================================================
//
// Quan trọng:
// Không dùng:
//   await response.arrayBuffer()
//
// vì cách đó có thể giữ toàn bộ video trong RAM.
//
// Hàm này chỉ giữ từng chunk nhỏ trong RAM.
//

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
    throw new Error(
      'Server không trả về stream video.'
    );
  }

  const totalBytes = getContentLength(response);

  if (
    totalBytes > 0 &&
    totalBytes > maxBytes
  ) {
    throw new Error(
      `${label} vượt quá giới hạn ${Math.round(
        maxBytes / 1024 / 1024
      )} MB.`
    );
  }

  await fs.ensureDir(path.dirname(outputPath));

  const fileStream = fs.createWriteStream(
    outputPath
  );

  let receivedBytes = 0;
  let lastProgress = progressStart;

  const reader = response.body.getReader();

  try {
    while (true) {
      const { done, value } = await reader.read();

      if (done) {
        break;
      }

      if (!value) {
        continue;
      }

      receivedBytes += value.byteLength;

      if (receivedBytes > maxBytes) {
        try {
          await reader.cancel();
        } catch {}

        throw new Error(
          `${label} vượt quá giới hạn ${Math.round(
            maxBytes / 1024 / 1024
          )} MB.`
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

      if (
        totalBytes > 0 &&
        typeof onProgress === 'function'
      ) {
        const ratio =
          receivedBytes / totalBytes;

        const mapped = Math.round(
          progressStart +
            ratio *
              (progressEnd - progressStart)
        );

        if (mapped > lastProgress) {
          lastProgress = mapped;

          onProgress(
            `📥 Đang tải ${label}... ${Math.round(
              ratio * 100
            )}%`,
            mapped
          );
        }
      }
    }

    await new Promise((resolve, reject) => {
      fileStream.end((err) => {
        if (err) {
          reject(err);
        } else {
          resolve();
        }
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

    throw new Error(
      `${label} tải về bị rỗng.`
    );
  }

  if (stat.size > maxBytes) {
    await safeRemove(outputPath);

    throw new Error(
      `${label} vượt quá giới hạn ${Math.round(
        maxBytes / 1024 / 1024
      )} MB.`
    );
  }

  return {
    size: stat.size,
  };
}

// =========================================================
// READ ERROR RESPONSE
// =========================================================
//
// Server downloader có thể trả JSON:
// { error: "..." }
//
// Không đọc toàn bộ response nếu lỗi quá lớn.
//

async function readErrorResponse(response) {
  try {
    const contentType =
      response.headers.get('content-type') || '';

    const text = await response.text();

    const limitedText =
      text.length > 10000
        ? text.slice(-10000)
        : text;

    if (
      contentType.includes(
        'application/json'
      )
    ) {
      try {
        const data = JSON.parse(
          limitedText
        );

        return (
          data.error ||
          data.message ||
          `HTTP ${response.status}`
        );
      } catch {
        return limitedText;
      }
    }

    return (
      limitedText ||
      `HTTP ${response.status}`
    );
  } catch {
    return `HTTP ${response.status}`;
  }
}

// =========================================================
// YOUTUBE DOWNLOADER
// =========================================================
//
// Gọi:
// POST /download
//
// Body:
// {
//   "url": "https://www.youtube.com/..."
// }
//
// Server trả trực tiếp:
// Content-Type: video/mp4
//
// =========================================================

async function downloadYouTubeViaServer(
  url,
  outputPath,
  onProgress
) {
  if (!YOUTUBE_DOWNLOADER_URL) {
    throw new Error(
      'Thiếu biến môi trường YOUTUBE_DOWNLOADER_URL trên video-translator.'
    );
  }

  const endpoint =
    `${YOUTUBE_DOWNLOADER_URL}/download`;

  onProgress?.(
    '📡 Đang kết nối YouTube Downloader...',
    12
  );

  console.log(
    '[YouTube Downloader] Request:',
    endpoint
  );

  const {
    controller,
    clear,
  } = createAbortController(
    DOWNLOAD_TIMEOUT_MS
  );

  try {
    const headers = {
      'Content-Type': 'application/json',
      Accept: 'video/mp4, application/json',
    };

    if (DOWNLOADER_API_TOKEN) {
      headers['x-api-key'] =
        DOWNLOADER_API_TOKEN;
    }

    const response = await fetch(
      endpoint,
      {
        method: 'POST',
        headers,
        body: JSON.stringify({
          url,
        }),
        signal: controller.signal,
      }
    );

    if (!response.ok) {
      const errorMessage =
        await readErrorResponse(
          response
        );

      throw new Error(
        `YouTube Downloader HTTP ${response.status}: ${errorMessage}`
      );
    }

    const contentType =
      response.headers.get(
        'content-type'
      ) || '';

    // Nếu downloader trả JSON thì chắc chắn là lỗi
    // hoặc response không đúng định dạng.
    if (
      contentType.includes(
        'application/json'
      )
    ) {
      const errorMessage =
        await readErrorResponse(
          response
        );

      throw new Error(
        `YouTube Downloader trả về JSON: ${errorMessage}`
      );
    }

    onProgress?.(
      '📥 YouTube Downloader đang tải video...',
      16
    );

    const result =
      await streamResponseToFile(
        response,
        outputPath,
        {
          onProgress,
          progressStart: 16,
          progressEnd: 32,
          maxBytes:
            MAX_REMOTE_VIDEO_SIZE_BYTES,
          label: 'video YouTube',
        }
      );

    onProgress?.(
      '✅ Đã tải video YouTube thành công.',
      33
    );

    return result;
  } catch (err) {
    if (
      err?.name === 'AbortError'
    ) {
      throw new Error(
        `Tải video YouTube quá thời gian ${
          Math.round(
            DOWNLOAD_TIMEOUT_MS / 60000
          )
        } phút.`
      );
    }

    throw err;
  } finally {
    clear();
  }
}

// =========================================================
// TIKTOK API
// =========================================================

async function downloadTikTokVideo(
  url,
  outputPath,
  onProgress
) {
  onProgress?.(
    '📥 Đang kết nối tới TikTok...',
    12
  );

  const {
    controller,
    clear,
  } = createAbortController(
    DOWNLOAD_TIMEOUT_MS
  );

  try {
    const res = await fetch(
      'https://www.tikwm.com/api/',
      {
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

        signal: controller.signal,
      }
    );

    if (!res.ok) {
      throw new Error(
        `TikTok API trả về HTTP ${res.status}`
      );
    }

    const json = await res.json();

    if (
      json.code !== 0 ||
      !json.data
    ) {
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

    const fullDownloadUrl =
      playUrl.startsWith('http')
        ? playUrl
        : `https://www.tikwm.com${playUrl}`;

    onProgress?.(
      '📥 Đang tải video TikTok...',
      18
    );

    const vidRes = await fetch(
      fullDownloadUrl,
      {
        headers: {
          'User-Agent':
            'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120.0.0.0 Safari/537.36',

          Referer:
            'https://www.tiktok.com/',
        },

        signal: controller.signal,
      }
    );

    if (!vidRes.ok) {
      throw new Error(
        `Tải file video TikTok thất bại: HTTP ${vidRes.status}`
      );
    }

    const result =
      await streamResponseToFile(
        vidRes,
        outputPath,
        {
          onProgress,
          progressStart: 18,
          progressEnd: 32,
          maxBytes:
            MAX_REMOTE_VIDEO_SIZE_BYTES,
          label: 'video TikTok',
        }
      );

    return result;
  } catch (err) {
    if (
      err?.name === 'AbortError'
    ) {
      throw new Error(
        'Tải video TikTok quá thời gian cho phép.'
      );
    }

    throw err;
  } finally {
    clear();
  }
}

// =========================================================
// DIRECT VIDEO URL
// =========================================================

async function downloadDirectVideo(
  url,
  outputPath,
  onProgress
) {
  onProgress?.(
    '📥 Đang tải video trực tiếp...',
    12
  );

  const {
    controller,
    clear,
  } = createAbortController(
    DOWNLOAD_TIMEOUT_MS
  );

  try {
    const response = await fetch(
      url,
      {
        headers: {
          'User-Agent':
            'Mozilla/5.0',
        },

        signal: controller.signal,
      }
    );

    if (!response.ok) {
      throw new Error(
        `Không thể tải video: HTTP ${response.status} ${response.statusText}`
      );
    }

    const result =
      await streamResponseToFile(
        response,
        outputPath,
        {
          onProgress,
          progressStart: 12,
          progressEnd: 32,
          maxBytes:
            MAX_REMOTE_VIDEO_SIZE_BYTES,
          label: 'video',
        }
      );

    return result;
  } catch (err) {
    if (
      err?.name === 'AbortError'
    ) {
      throw new Error(
        'Tải video trực tiếp quá thời gian cho phép.'
      );
    }

    throw err;
  } finally {
    clear();
  }
}

// =========================================================
// YT-DLP FALLBACK
// =========================================================
//
// Chỉ dùng fallback cho TikTok hoặc các nền tảng
// khác nếu cần.
//
// YouTube KHÔNG đi vào hàm này.
//

async function downloadWithYtDlp(
  url,
  outputPath,
  onProgress
) {
  const platform =
    getPlatformName(url);

  onProgress?.(
    `📥 Đang tải video từ ${platform} bằng yt-dlp...`,
    12
  );

  const ytPath =
    await getYtDlp(onProgress);

  return new Promise(
    (resolve, reject) => {
      const args = [
        url,

        '-o',
        outputPath,

        '--format',
        'bestvideo[ext=mp4][height<=1080]+bestaudio[ext=m4a]/best[ext=mp4]/best',

        '--merge-output-format',
        'mp4',

        '--no-playlist',

        '--no-warnings',

        '--newline',

        '--progress',

        '--ffmpeg-location',
        ffmpegPath,
      ];

      const child = spawn(
        ytPath,
        args,
        {
          windowsHide: true,
          stdio: [
            'ignore',
            'pipe',
            'pipe',
          ],
        }
      );

      let lastPercent = 12;
      let stderrBuffer = '';
      let finished = false;

      const timeout =
        setTimeout(() => {
          if (finished) return;

          try {
            child.kill('SIGKILL');
          } catch {}

          reject(
            new Error(
              `yt-dlp tải ${platform} quá thời gian cho phép.`
            )
          );
        }, DOWNLOAD_TIMEOUT_MS);

      timeout.unref?.();

      const reportProgress =
        (data) => {
          const text =
            data.toString();

          const match =
            text.match(
              /(\d+(?:\.\d+)?)%/
            );

          if (!match) {
            return;
          }

          const dlPct =
            parseFloat(match[1]);

          const mapped =
            Math.round(
              12 +
                (dlPct / 100) *
                  20
            );

          if (
            mapped >
            lastPercent
          ) {
            lastPercent =
              mapped;

            onProgress?.(
              `📥 Đang tải ${platform}... ${Math.round(
                dlPct
              )}%`,
              mapped
            );
          }
        };

      child.stdout.on(
        'data',
        reportProgress
      );

      child.stderr.on(
        'data',
        (data) => {
          const text =
            data.toString();

          stderrBuffer += text;

          if (
            stderrBuffer.length >
            10000
          ) {
            stderrBuffer =
              stderrBuffer.slice(
                -10000
              );
          }

          reportProgress(data);
        }
      );

      child.on(
        'error',
        (err) => {
          clearTimeout(timeout);

          if (finished) return;

          finished = true;

          reject(
            new Error(
              `Không thể chạy yt-dlp: ${err.message}`
            )
          );
        }
      );

      child.on(
        'close',
        async (code) => {
          clearTimeout(timeout);

          if (finished) return;

          if (code === 0) {
            try {
              const exists =
                await fs.pathExists(
                  outputPath
                );

              if (!exists) {
                finished = true;

                return reject(
                  new Error(
                    'yt-dlp không tạo được file video.'
                  )
                );
              }

              const stat =
                await fs.stat(
                  outputPath
                );

              if (!stat.size) {
                finished = true;

                return reject(
                  new Error(
                    'yt-dlp tạo file video rỗng.'
                  )
                );
              }

              if (
                stat.size >
                MAX_REMOTE_VIDEO_SIZE_BYTES
              ) {
                await safeRemove(
                  outputPath
                );

                finished = true;

                return reject(
                  new Error(
                    `Video vượt quá giới hạn ${MAX_REMOTE_VIDEO_SIZE_MB} MB.`
                  )
                );
              }

              finished = true;

              return resolve({
                size: stat.size,
              });
            } catch (err) {
              finished = true;
              return reject(err);
            }
          }

          const detail =
            stderrBuffer
              .split(/\r?\n/)
              .map((line) =>
                line.trim()
              )
              .filter(Boolean)
              .slice(-5)
              .join('\n');

          finished = true;

          reject(
            new Error(
              `yt-dlp thoát với mã lỗi ${code}${
                detail
                  ? `: ${detail}`
                  : ''
              }`
            )
          );
        }
      );
    }
  );
}

// =========================================================
// EXTRACT AUDIO
// =========================================================

function extractAudio(
  videoPath,
  audioPath,
  onProgress
) {
  onProgress?.(
    '🎵 Đang trích xuất audio...',
    35
  );

  return new Promise(
    (resolve, reject) => {
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
          '128k',

          '-y',

          audioPath,

          '-loglevel',
          'error',
        ],
        (err, _stdout, stderr) => {
          if (err) {
            return reject(
              new Error(
                `ffmpeg lỗi: ${
                  stderr ||
                  err.message
                }`
              )
            );
          }

          resolve();
        }
      );
    }
  );
}

// =========================================================
// PROCESS UPLOADED FILE
// =========================================================

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

  await fs.ensureDir(
    outputDir
  );

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

  // -------------------------------------------------------
  // Try remux first
  // -------------------------------------------------------

  await new Promise(
    (resolve, reject) => {
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
        (err) => {
          if (
            !err &&
            fs.existsSync(
              videoPath
            ) &&
            fs.statSync(
              videoPath
            ).size > 0
          ) {
            return resolve();
          }

          // ------------------------------------------------
          // Fallback: transcode H.264
          // ------------------------------------------------

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
            (
              transcodeErr,
              _stdout,
              stderr
            ) => {
              if (
                transcodeErr
              ) {
                return reject(
                  new Error(
                    `Không thể xử lý file video tải lên: ${
                      stderr ||
                      transcodeErr.message
                    }`
                  )
                );
              }

              resolve();
            }
          );
        }
      );
    }
  );

  // -------------------------------------------------------
  // Verify video
  // -------------------------------------------------------

  if (
    !fs.existsSync(videoPath) ||
    (
      await fs.stat(
        videoPath
      )
    ).size === 0
  ) {
    throw new Error(
      'Xử lý file video tải lên thất bại: file trống hoặc không hợp lệ.'
    );
  }

  // -------------------------------------------------------
  // Extract audio
  // -------------------------------------------------------

  await extractAudio(
    videoPath,
    audioPath,
    onProgress
  );

  // -------------------------------------------------------
  // Verify audio
  // -------------------------------------------------------

  if (
    !fs.existsSync(audioPath) ||
    (
      await fs.stat(
        audioPath
      )
    ).size === 0
  ) {
    throw new Error(
      'Trích xuất audio từ file tải lên thất bại.'
    );
  }

  return {
    videoPath,
    audioPath,
  };
}

// =========================================================
// MAIN PROCESS
// =========================================================

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

  await fs.ensureDir(
    outputDir
  );

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

  // -------------------------------------------------------
  // Validate URL
  // -------------------------------------------------------

  if (
    typeof url !== 'string' ||
    !url.trim()
  ) {
    throw new Error(
      'URL video không hợp lệ.'
    );
  }

  url = url.trim();

  const platform =
    getPlatformName(url);

  console.log(
    `[videoProcessor] Processing ${platform}: ${url}`
  );

  // -------------------------------------------------------
  // 1. YouTube
  // -------------------------------------------------------
  //
  // QUAN TRỌNG:
  // YouTube không sử dụng yt-dlp local nữa.
  //
  // Gọi:
  // POST https://youtube-downloader-wowp.onrender.com/download
  //
  // -------------------------------------------------------

  if (isYouTubeUrl(url)) {
    await downloadYouTubeViaServer(
      url,
      videoPath,
      onProgress
    );
  }

  // -------------------------------------------------------
  // 2. Direct video URL
  // -------------------------------------------------------

  else if (
    isDirectVideoUrl(url)
  ) {
    await downloadDirectVideo(
      url,
      videoPath,
      onProgress
    );
  }

  // -------------------------------------------------------
  // 3. TikTok
  // -------------------------------------------------------

  else if (
    isTikTokUrl(url)
  ) {
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

      onProgress?.(
        '⚠️ TikTok API thất bại, đang thử phương án dự phòng...',
        12
      );

      await downloadWithYtDlp(
        url,
        videoPath,
        onProgress
      );
    }
  }

  // -------------------------------------------------------
  // 4. Other supported URLs
  // -------------------------------------------------------

  else {
    try {
      await downloadWithYtDlp(
        url,
        videoPath,
        onProgress
      );
    } catch (dlErr) {
      throw dlErr;
    }
  }

  // -------------------------------------------------------
  // Verify video
  // -------------------------------------------------------

  if (
    !fs.existsSync(videoPath)
  ) {
    throw new Error(
      `Tải video ${platform} thất bại: file không tồn tại.`
    );
  }

  const videoStat =
    await fs.stat(
      videoPath
    );

  if (
    videoStat.size === 0
  ) {
    throw new Error(
      `Tải video ${platform} thất bại: file trống.`
    );
  }

  console.log(
    `[videoProcessor] Video downloaded: ${
      Math.round(
        videoStat.size /
          1024 /
          1024 *
          10
      ) / 10
    } MB`
  );

  // -------------------------------------------------------
  // Extract audio
  // -------------------------------------------------------

  await extractAudio(
    videoPath,
    audioPath,
    onProgress
  );

  // -------------------------------------------------------
  // Verify audio
  // -------------------------------------------------------

  if (
    !fs.existsSync(audioPath)
  ) {
    throw new Error(
      'Trích xuất audio thất bại: file audio không tồn tại.'
    );
  }

  const audioStat =
    await fs.stat(
      audioPath
    );

  if (
    audioStat.size === 0
  ) {
    throw new Error(
      'Trích xuất audio thất bại: file audio rỗng.'
    );
  }

  return {
    videoPath,
    audioPath,
  };
}

// =========================================================
// EXPORT
// =========================================================

module.exports = {
  process: processVideo,
  processUploadedFile,
};