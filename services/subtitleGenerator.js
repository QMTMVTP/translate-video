/**
 * Convert translated segments to WebVTT format
 */

/**
 * Format seconds to VTT timestamp: HH:MM:SS.mmm
 */
function formatTime(seconds) {
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

/**
 * Generate WebVTT content from translated segments
 * @param {Array<{start: number, end: number, text: string}>} segments
 * @returns {string} VTT content
 */
function generateVTT(segments) {
  let vtt = 'WEBVTT\n\n';

  segments.forEach((seg, index) => {
    const start = formatTime(seg.start);
    const end = formatTime(seg.end);
    const text = seg.text.replace(/</g, '&lt;').replace(/>/g, '&gt;');

    vtt += `${index + 1}\n`;
    vtt += `${start} --> ${end}\n`;
    vtt += `${text}\n\n`;
  });

  return vtt;
}

/**
 * Generate SRT content from translated segments
 * @param {Array<{start: number, end: number, text: string}>} segments
 * @returns {string} SRT content
 */
function generateSRT(segments) {
  return segments
    .map((seg, index) => {
      const start = formatTime(seg.start).replace('.', ',');
      const end = formatTime(seg.end).replace('.', ',');
      return `${index + 1}\n${start} --> ${end}\n${seg.text}\n`;
    })
    .join('\n');
}

module.exports = { generateVTT, generateSRT, formatTime };
