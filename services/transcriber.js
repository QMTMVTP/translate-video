const Groq = require('groq-sdk');
const fs = require('fs');

const groq = new Groq({ apiKey: process.env.GROQ_API_KEY });

/**
 * Transcribe audio file using Groq Whisper API
 * Returns array of segments: [{ start, end, text }]
 */
async function transcribe(audioPath) {
  const fileStream = fs.createReadStream(audioPath);

  const response = await groq.audio.transcriptions.create({
    file: fileStream,
    model: 'whisper-large-v3',
    response_format: 'verbose_json',
    timestamp_granularities: ['segment'],
  });

  if (!response.segments || response.segments.length === 0) {
    throw new Error('Không thể phiên âm audio: không có nội dung giọng nói nào được phát hiện.');
  }

  // Normalize segments to { start, end, text }
  return response.segments.map((seg) => ({
    start: seg.start,
    end: seg.end,
    text: (seg.text || '').trim(),
  })).filter((seg) => seg.text.length > 0);
}

module.exports = { transcribe };
