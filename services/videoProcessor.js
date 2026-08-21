const { execFile, spawn } = require('child_process');
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
 * ============================================================
 * Utility
 * ============================================================
 */

async function fileExistsAndNotEmpty(filePath) {
  try {
    const stat = await fs.stat(filePath);
    return stat.isFile() && stat.size > 0;
  } catch {
    return false;
  }
}

async function removeFileSafe(filePath) {
  try {
    await fs.remove(filePath);
  } catch {
    // Ignore cleanup errors
  }
}

/**
 * ============================================================
 * Find yt-dlp
 * ============================================================
 */

async function getYtDlp(onProgress) {
  if (ytDlpPath) {
    return ytDlpPath;
  }

  await fs.ensureDir(BIN_DIR);

  console.log(`[yt-dlp] Kiểm tra binary: ${BIN_PATH}`);

  if (await fs.pathExists(BIN_PATH)) {
    console.log(`[yt-dlp] Đã tìm thấy: ${BIN_PATH}`);

    onProgress &&
      onProgress(
        '🔧 Đã tìm thấy yt-dlp, đang khởi động công cụ tải video...',
        12
      );

    ytDlpPath = BIN_PATH;
    return ytDlpPath;
  }

  /**
   * Try system yt-dlp.
   *
   * Useful on Render/Linux if yt-dlp is installed
   * in the environment.
   */
  const systemCommand = process.platform === 'win32'
    ? 'yt-dlp.exe'
    : 'yt-dlp';

  try {
    await new Promise((resolve, reject) => {
      execFile(
        systemCommand,
        ['--version'],
        {
          windowsHide: true,
          timeout: 10000,
        },
        (err) => {
          if (err) {
            reject(err);
          } else {
            resolve();
          }
        }
      );
    });

    console.log(`[yt-dlp] Sử dụng yt-dlp hệ thống: ${systemCommand}`);

    onProgress &&
      onProgress(
        '🔧 Đã tìm thấy yt-dlp hệ thống...',
        12
      );

    ytDlpPath = systemCommand;

    return ytDlpPath;
  } catch {
    throw new Error(
      `Không tìm thấy yt-dlp.

Đã kiểm tra:
${BIN_PATH}

Và yt-dlp trong hệ thống.

Trên Render/Linux, hãy đảm bảo bin/yt-dlp tồn tại và có quyền thực thi.`
    );
  }
}

/**
 * ============================================================
 * Platform detection
 * ============================================================
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

function isTikTokUrl(url) {
  return /tiktok\.com/i.test(url);
}

/**
 * ============================================================
 * TikTok
 *
 * IMPORTANT:
 * Do NOT Buffer.concat().
 *
 * Video is streamed directly to disk.
 * ============================================================
 */

async function downloadTikTokVideo(url, outputPath, onProgress) {
  onProgress &&
    onProgress(
      '📥 Đang kết nối tới TikTok...',
      12
    );

  const response = await fetch(
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
    }
  );

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

  const fullDownloadUrl =
    playUrl.startsWith('http')
      ? playUrl
      : `https://www.tikwm.com${playUrl}`;

  onProgress &&
    onProgress(
      '📥 Đang tải video TikTok...',
      18
    );

  const videoResponse = await fetch(
    fullDownloadUrl,
    {
      headers: {
        'User-Agent':
          'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120.0.0.0 Safari/537.36',

        Referer:
          'https://www.tiktok.com/',
      },
    }
  );

  if (!videoResponse.ok) {
    throw new Error(
      `Tải file video TikTok thất bại: HTTP ${videoResponse.status}`
    );
  }

  /**
   * IMPORTANT:
   *
   * Stream directly to disk.
   *
   * This avoids:
   *
   * const chunks = [];
   * Buffer.concat(chunks);
   *
   * which can consume hundreds of MB RAM.
   */

  const fileStream = fs.createWriteStream(
    outputPath
  );

  const contentLength =
    videoResponse.headers.get('content-length');

  const totalBytes = contentLength
    ? parseInt(contentLength, 10)
    : 0;

  let receivedBytes = 0;

  if (!videoResponse.body) {
    throw new Error(
      'TikTok không trả về dữ liệu video.'
    );
  }

  try {
    for await (const chunk of videoResponse.body) {
      receivedBytes += chunk.length;

      if (!fileStream.write(chunk)) {
        await new Promise((resolve) => {
          fileStream.once('drain', resolve);
        });
      }

      if (totalBytes > 0 && onProgress) {
        const percent =
          receivedBytes / totalBytes;

        const mapped =
          Math.round(18 + percent * 14);

        onProgress(
          `📥 Đang tải video TikTok... ${Math.round(
            percent * 100
          )}%`,
          Math.min(mapped, 32)
        );
      }
    }

    await new Promise((resolve, reject) => {
      fileStream.end(() => resolve());
      fileStream.on('error', reject);
    });
  } catch (err) {
    fileStream.destroy();
    await removeFileSafe(outputPath);

    throw err;
  }

  if (!(await fileExistsAndNotEmpty(outputPath))) {
    throw new Error(
      'Video TikTok tải xuống bị rỗng.'
    );
  }
}

/**
 * ============================================================
 * Direct video URL
 *
 * Stream directly to disk.
 * ============================================================
 */

function isDirectVideoUrl(url) {
  return /\.(mp4|webm|mov|mkv|avi|flv|m4v)(\?.*)?$/i.test(
    url
  );
}

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

  if (!response.body) {
    throw new Error(
      'Server không trả về dữ liệu video.'
    );
  }

  const contentLength =
    response.headers.get('content-length');

  const totalBytes = contentLength
    ? parseInt(contentLength, 10)
    : 0;

  let receivedBytes = 0;

  const fileStream = fs.createWriteStream(
    outputPath
  );

  try {
    for await (const chunk of response.body) {
      receivedBytes += chunk.length;

      if (!fileStream.write(chunk)) {
        await new Promise((resolve) => {
          fileStream.once('drain', resolve);
        });
      }

      if (totalBytes > 0 && onProgress) {
        const percent =
          receivedBytes / totalBytes;

        const mapped =
          Math.round(12 + percent * 18);

        onProgress(
          `📥 Đang tải... ${Math.round(
            percent * 100
          )}%`,
          Math.min(mapped, 30)
        );
      }
    }

    await new Promise((resolve, reject) => {
      fileStream.end(() => resolve());
      fileStream.on('error', reject);
    });
  } catch (err) {
    fileStream.destroy();
    await removeFileSafe(outputPath);

    throw err;
  }

  if (!(await fileExistsAndNotEmpty(outputPath))) {
    throw new Error(
      'Video tải xuống bị rỗng hoặc không tồn tại.'
    );
  }
}

/**
 * ============================================================
 * yt-dlp
 *
 * yt-dlp writes directly to disk.
 * No video buffering in Node.js RAM.
 * ============================================================
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

  const ytPath =
    await getYtDlp(onProgress);

  onProgress &&
    onProgress(
      `📡 yt-dlp đã sẵn sàng, đang kết nối tới ${platform}...`,
      12
    );

  return new Promise((resolve, reject) => {
    /**
     * Keep output file on disk.
     *
     * IMPORTANT:
     * Do not pipe video into Node.js.
     */

    const args = [
      url,

      '-o',
      outputPath,

      /**
       * RAM-friendly format:
       *
       * Limit video to 720p.
       *
       * 1080p videos consume much more processing
       * resources when FFmpeg merges them.
       */
      '--format',
      'bestvideo[ext=mp4][height<=720]+bestaudio[ext=m4a]/best[ext=mp4][height<=720]/best[ext=mp4]/best',

      '--merge-output-format',
      'mp4',

      '--no-playlist',

      '--no-warnings',

      '--progress',

      /**
       * Use bundled FFmpeg.
       */
      '--ffmpeg-location',
      ffmpegPath,

      /**
       * Node runtime for yt-dlp JS challenges.
       */
      '--js-runtimes',
      `node:${process.execPath}`,

      /**
       * YouTube extractor.
       */
      '--extractor-args',
      'youtube:player_client=web_embedded',

      /**
       * Avoid keeping unnecessary fragments.
       */
      '--no-part',

      /**
       * Reduce unnecessary disk writes.
       */
      '--concurrent-fragments',
      '1',
    ];

    console.log(
      `[yt-dlp] Starting download: ${platform}`
    );

    const ytProcess = spawn(
      ytPath,
      args,
      {
        windowsHide: true,
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

      const match =
        str.match(/(\d+(?:\.\d+)?)%/);

      if (match && onProgress) {
        const downloadPercent =
          parseFloat(match[1]);

        const mapped =
          Math.round(
            12 +
              (downloadPercent / 100) * 20
          );

        if (mapped > lastPercent) {
          lastPercent = mapped;

          onProgress(
            `📥 Đang tải từ ${platform}... ${Math.round(
              downloadPercent
            )}%`,
            Math.min(mapped, 32)
          );
        }
      }
    };

    ytProcess.stdout.on(
      'data',
      reportYtDlpOutput
    );

    ytProcess.stderr.on(
      'data',
      (data) => {
        const text = data.toString();

        lastErrorOutput += text;

        if (
          lastErrorOutput.length > 3000
        ) {
          lastErrorOutput =
            lastErrorOutput.slice(-3000);
        }

        reportYtDlpOutput(data);
      }
    );

    ytProcess.on(
      'error',
      async (err) => {
        await removeFileSafe(outputPath);
        reject(err);
      }
    );

    ytProcess.on(
      'close',
      async (code) => {
        if (code !== 0) {
          await removeFileSafe(outputPath);

          const detail =
            lastErrorOutput
              .split(/\r?\n/)
              .map((line) =>
                line.trim()
              )
              .filter(
                (line) =>
                  line.startsWith(
                    'ERROR:'
                  ) ||
                  line.startsWith(
                    'WARNING:'
                  )
              )
              .at(-1);

          reject(
            new Error(
              `yt-dlp thoát với mã lỗi ${code}${
                detail
                  ? `: ${detail}`
                  : ''
              }`
            )
          );

          return;
        }

        if (
          !(await fileExistsAndNotEmpty(
            outputPath
          ))
        ) {
          reject(
            new Error(
              'yt-dlp hoàn tất nhưng không tạo được file video.'
            )
          );

          return;
        }

        console.log(
          `[yt-dlp] Download completed: ${outputPath}`
        );

        resolve();
      }
    );
  });
}

/**
 * ============================================================
 * Extract audio
 *
 * Keep audio relatively small.
 * Whisper only needs mono 16kHz.
 * ============================================================
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

          '-c:a',
          'libmp3lame',

          '-b:a',
          '64k',

          '-y',

          '-loglevel',
          'error',

          audioPath,
        ],
        {
          windowsHide: true,
        },
        async (
          err,
          _stdout,
          stderr
        ) => {
          if (err) {
            await removeFileSafe(
              audioPath
            );

            reject(
              new Error(
                `ffmpeg lỗi khi trích xuất audio: ${
                  stderr ||
                  err.message
                }`
              )
            );

            return;
          }

          if (
            !(await fileExistsAndNotEmpty(
              audioPath
            ))
          ) {
            reject(
              new Error(
                'ffmpeg không tạo được audio.'
              )
            );

            return;
          }

          resolve();
        }
      );
    }
  );
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

  onProgress &&
    onProgress(
      '📁 Đang chuẩn bị video tải lên...',
      15
    );

  /**
   * First try remux.
   *
   * This is much lighter than re-encoding.
   */

  try {
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
          {
            windowsHide: true,
          },
          (err) => {
            if (err) {
              reject(err);
            } else {
              resolve();
            }
          }
        );
      }
    );
  } catch {
    /**
     * If remux fails, transcode.
     *
     * 720p limit reduces RAM/CPU pressure.
     */

    await removeFileSafe(videoPath);

    await new Promise(
      (resolve, reject) => {
        execFile(
          ffmpegPath,
          [
            '-i',
            uploadedFilePath,

            '-vf',
            'scale=-2:min(720\\,ih)',

            '-c:v',
            'libx264',

            '-preset',
            'veryfast',

            '-crf',
            '26',

            '-c:a',
            'aac',

            '-b:a',
            '128k',

            '-movflags',
            '+faststart',

            '-y',

            videoPath,
          ],
          {
            windowsHide: true,
          },
          (
            err,
            _stdout,
            stderr
          ) => {
            if (err) {
              reject(
                new Error(
                  `Không thể xử lý file video tải lên: ${
                    stderr ||
                    err.message
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
  }

  if (
    !(await fileExistsAndNotEmpty(
      videoPath
    ))
  ) {
    throw new Error(
      'Xử lý file video tải lên thất bại: file trống hoặc không hợp lệ.'
    );
  }

  /**
   * Extract audio.
   */

  await extractAudio(
    videoPath,
    audioPath,
    onProgress
  );

  if (
    !(await fileExistsAndNotEmpty(
      audioPath
    ))
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

/**
 * ============================================================
 * Main process for URL
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

  try {
    /**
     * ========================================================
     * Download
     * ========================================================
     */

    if (isDirectVideoUrl(url)) {
      await downloadDirectVideo(
        url,
        videoPath,
        onProgress
      );
    } else if (isTikTokUrl(url)) {
      /**
       * TikTok:
       *
       * 1. Try TikWM
       * 2. Fallback to yt-dlp
       */

      try {
        await downloadTikTokVideo(
          url,
          videoPath,
          onProgress
        );
      } catch (tikTokError) {
        console.warn(
          '[processVideo] TikTok API failed:',
          tikTokError.message
        );

        onProgress &&
          onProgress(
            '⚠️ TikTok API không hoạt động, chuyển sang yt-dlp...',
            12
          );

        await downloadWithYtDlp(
          url,
          videoPath,
          onProgress
        );
      }
    } else {
      /**
       * Other platforms.
       */

      await downloadWithYtDlp(
        url,
        videoPath,
        onProgress
      );
    }

    /**
     * ========================================================
     * Verify downloaded video
     * ========================================================
     */

    if (
      !(await fileExistsAndNotEmpty(
        videoPath
      ))
    ) {
      throw new Error(
        'Tải video thất bại: file trống hoặc không tồn tại.'
      );
    }

    const videoStat =
      await fs.stat(videoPath);

    console.log(
      `[processVideo] Video size: ${(
        videoStat.size /
        1024 /
        1024
      ).toFixed(1)} MB`
    );

    /**
     * ========================================================
     * Extract audio
     * ========================================================
     */

    await extractAudio(
      videoPath,
      audioPath,
      onProgress
    );

    if (
      !(await fileExistsAndNotEmpty(
        audioPath
      ))
    ) {
      throw new Error(
        'Trích xuất audio thất bại.'
      );
    }

    return {
      videoPath,
      audioPath,
    };
  } catch (error) {
    /**
     * Cleanup if processing fails.
     */

    await removeFileSafe(
      videoPath
    );

    await removeFileSafe(
      audioPath
    );

    throw error;
  }
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