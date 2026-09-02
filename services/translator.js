/**
 * Translate text to Vietnamese using unofficial free translation APIs.
 * Prefer Google Translate, then fallback to a public mirror if Google blocks or returns malformed payload.
 */

const TRANSLATE_URL = 'https://translate.googleapis.com/translate_a/single';
const ALT_TRANSLATE_URL = 'https://translate.argosopentech.com/translate';
const BATCH_SIZE = 15;      // segments per batch
const BATCH_DELAY_MS = 400; // delay between batches to avoid rate limiting
const SEPARATOR = '\n⟨SEP⟩\n';

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function normalizeTranslatedText(value) {
  if (typeof value !== 'string') return '';
  return value.trim();
}

async function translateWithGoogle(text) {
  const params = new URLSearchParams({
    client: 'gtx',
    sl: 'auto',
    tl: 'vi',
    dt: 't',
    ie: 'UTF-8',
    oe: 'UTF-8',
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

  if (!Array.isArray(data) || !Array.isArray(data[0])) {
    throw new Error('Google Translate trả về payload không hợp lệ.');
  }

  const translated = data[0]
    .map((item) => (Array.isArray(item) ? item[0] || '' : ''))
    .join('');

  const normalized = normalizeTranslatedText(translated);
  if (!normalized) {
    throw new Error('Google Translate không trả về văn bản dịch.');
  }

  return normalized;
}

async function translateWithArgos(text) {
  const res = await fetch(ALT_TRANSLATE_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'User-Agent': 'Mozilla/5.0',
    },
    body: JSON.stringify({
      q: text,
      source: 'auto',
      target: 'vi',
      format: 'text',
    }),
  });

  if (!res.ok) {
    throw new Error(`Argos Translate trả về lỗi HTTP ${res.status}`);
  }

  const data = await res.json();
  const translated =
    data?.translatedText ||
    data?.data?.translatedText ||
    data?.[0]?.translations?.[0]?.translatedText ||
    data?.[0]?.translatedText ||
    '';

  const normalized = normalizeTranslatedText(String(translated || ''));
  if (!normalized) {
    throw new Error('Argos Translate không trả về văn bản dịch.');
  }

  return normalized;
}

/**
 * Translate a single block of text (may contain multiple lines)
 */
async function translateText(text) {
  const safeText = typeof text === 'string' ? text.trim() : '';
  if (!safeText) {
    return '';
  }

  let lastError;

  try {
    return await translateWithGoogle(safeText);
  } catch (err) {
    lastError = err;
    console.warn('[Translator] Google Translate failed, trying fallback provider:', err.message);
  }

  try {
    return await translateWithArgos(safeText);
  } catch (err) {
    lastError = err;
    console.warn('[Translator] Fallback provider failed:', err.message);
  }

  throw new Error(lastError?.message || 'Không thể dịch văn bản sang tiếng Việt.');
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
  if (!Array.isArray(segments) || segments.length === 0) {
    return [];
  }

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
      console.warn(`[Translator] Batch ${batchIdx} failed, retrying segment-by-segment. Error:`, err.message);

      for (let i = 0; i < batch.length; i++) {
        try {
          const singleTranslated = await translateText(batch[i].text);
          results[start + i] = { ...batch[i], text: singleTranslated.trim() };
        } catch (singleErr) {
          console.error(`[Translator] Segment ${start + i} failed translation:`, singleErr.message);
          throw new Error(`Dịch thất bại ở đoạn ${start + i + 1}: ${singleErr.message}`);
        }
      }

      if (onProgress) {
        onProgress((batchIdx + 1) / totalBatches);
      }

      if (batchIdx < totalBatches - 1) {
        await sleep(BATCH_DELAY_MS);
      }
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
