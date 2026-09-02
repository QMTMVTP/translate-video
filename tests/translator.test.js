const test = require('node:test');
const assert = require('node:assert/strict');

const translator = require('../services/translator');

test('translateText should fall back to alternate provider when Google response is empty or malformed', async () => {
  const originalFetch = global.fetch;
  const calls = [];

  global.fetch = async (url, init) => {
    const urlString = String(url);
    calls.push(urlString);

    if (urlString.includes('translate.googleapis.com')) {
      return {
        ok: true,
        json: async () => ({ data: [] }),
      };
    }

    if (urlString.includes('translate.argosopentech.com')) {
      return {
        ok: true,
        json: async () => ({
          translatedText: 'xin chào',
        }),
      };
    }

    throw new Error(`Unexpected URL: ${urlString}`);
  };

  try {
    const result = await translator.translateText('hello world');
    assert.equal(result, 'xin chào');
    assert.equal(calls.length >= 2, true);
  } finally {
    global.fetch = originalFetch;
  }
});

test('translateSegments should not keep original Japanese text when batch split fails', async () => {
  const originalFetch = global.fetch;

  global.fetch = async (url) => {
    const urlString = String(url);

    if (urlString.includes('translate.googleapis.com')) {
      return {
        ok: true,
        json: async () => ({
          data: [[['xin chào\n⟨SEP⟩\ntôi khỏe', 'hello\n⟨SEP⟩\nhow are you']]],
        }),
      };
    }

    if (urlString.includes('translate.argosopentech.com')) {
      return {
        ok: true,
        json: async () => ({ translatedText: 'xin chào' }),
      };
    }

    throw new Error(`Unexpected URL: ${urlString}`);
  };

  try {
    const result = await translator.translateSegments(
      [
        { start: 0, end: 2, text: 'hello' },
        { start: 2, end: 4, text: 'how are you' },
      ],
      () => {}
    );

    assert.deepEqual(result.map((segment) => segment.text), ['xin chào', 'tôi khỏe']);
  } finally {
    global.fetch = originalFetch;
  }
});
