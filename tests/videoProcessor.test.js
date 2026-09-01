const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');

const videoProcessor = require('../services/videoProcessor');

test('resolveYtDlpBinary should prioritize existing system yt-dlp in PATH', async () => {
  const tempDir = fs.mkdtempSync(path.join(process.cwd(), 'tmp-yt-dlp-'));
  const fakeBinary = path.join(tempDir, process.platform === 'win32' ? 'yt-dlp.exe' : 'yt-dlp');
  fs.writeFileSync(fakeBinary, 'test-binary');
  fs.chmodSync(fakeBinary, 0o755);

  const originalPath = process.env.PATH || '';
  process.env.PATH = `${tempDir}${path.delimiter}${originalPath}`;

  try {
    const resolved = await videoProcessor.resolveYtDlpBinary();
    assert.ok(resolved, 'should resolve a binary path');
    assert.match(resolved, /yt-dlp/);
  } finally {
    process.env.PATH = originalPath;
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});
