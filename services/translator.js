/**
 * Translate text to Vietnamese using unofficial Google Translate API
 * No API key required.
 */

const TRANSLATE_URL = 'https://translate.googleapis.com/translate_a/single';
const BATCH_SIZE = 15;      // segments per batch
const BATCH_DELAY_MS = 400; // delay between batches to avoid rate limiting
const SEPARATOR = '\n⟨SEP⟩\n';

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Translate a single block of text (may contain multiple lines)
 */
async function translateText(text) {
  const params = new URLSearchParams({
    client: 'gtx',
    sl: 'auto',
    tl: 'vi',
    dt: 't',
    q: text,
  });

  const res = await fetch(`${TRANSLATE_URL}?${params.toString()}`, {
    headers: {
      'User-Agent': 'Mozilla/5.0',
    },
  });

  if (!res.ok) {
    throw new Error(`Google Translate trả về lỗi HTTP ${res.status}`);
  }

  const data = await res.json();

  // data[0] is array of [translatedChunk, originalChunk, ...]
  const translated = data[0]
    .map((item) => (item[0] || ''))
    .join('');

  return translated;
}

/**
 * Translate an array of segments to Vietnamese.
 * Uses batched requests with separator trick to preserve segment boundaries.
 *
 * @param {Array<{start, end, text}>} segments
 * @param {Function} onProgress - callback(0..1)
 * @returns {Array<{start, end, text}>}
 */
async function translateSegments(segments, onProgress) {
  const results = new Array(segments.length);
  const totalBatches = Math.ceil(segments.length / BATCH_SIZE);

  for (let batchIdx = 0; batchIdx < totalBatches; batchIdx++) {
    const start = batchIdx * BATCH_SIZE;
    const end = Math.min(start + BATCH_SIZE, segments.length);
    const batch = segments.slice(start, end);

    // Combine batch texts with separator
    const combined = batch.map((s) => s.text).join(SEPARATOR);

    let translatedCombined;
    try {
      translatedCombined = await translateText(combined);
    } catch (err) {
      console.warn(`[Translator] Batch ${batchIdx} failed, using original text. Error:`, err.message);
      // Fallback: keep original text
      batch.forEach((seg, i) => {
        results[start + i] = { ...seg };
      });
      continue;
    }

    // Split translated text back by separator
    // Google Translate may change casing/spacing of the separator slightly, so try multiple splits
    let parts = translatedCombined.split(SEPARATOR);

    // Fallback: if separator was not preserved, try alternate forms
    if (parts.length !== batch.length) {
      parts = translatedCombined.split('⟨SEP⟩').map((p) => p.replace(/^\n|\n$/g, ''));
    }

    // Final fallback: if still mismatched, translate individually
    if (parts.length !== batch.length) {
      console.warn(`[Translator] Separator split mismatch (got ${parts.length}, expected ${batch.length}). Translating individually...`);
      for (let i = 0; i < batch.length; i++) {
        try {
          const singleTranslated = await translateText(batch[i].text);
          results[start + i] = { ...batch[i], text: singleTranslated.trim() };
          await sleep(100);
        } catch {
          results[start + i] = { ...batch[i] };
        }
      }
    } else {
      batch.forEach((seg, i) => {
        results[start + i] = {
          ...seg,
          text: (parts[i] || seg.text).trim(),
        };
      });
    }

    // Report progress
    if (onProgress) {
      onProgress((batchIdx + 1) / totalBatches);
    }

    // Throttle between batches
    if (batchIdx < totalBatches - 1) {
      await sleep(BATCH_DELAY_MS);
    }
  }

  return results;
}

module.exports = { translateSegments, translateText };
