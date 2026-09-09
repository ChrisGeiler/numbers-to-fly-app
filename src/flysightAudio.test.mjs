import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { FlySightVoice, numberRecordings, recordingNames } from './flysightAudio.ts';

test('numeric speech handles decimals, negative values and the missing eleven recording', () => {
  assert.deepEqual(numberRecordings('11'), ['1', '1']);
  assert.deepEqual(numberRecordings('270'), ['2', '7', '0']);
  assert.deepEqual(numberRecordings('-3.0'), ['minus', '3', 'dot', '0']);
  assert.deepEqual(numberRecordings('NaN'), []);
});

test('every bundled recording is a nonempty PCM WAV', async () => {
  for (const name of recordingNames) {
    const bytes = await readFile(new URL(`../public/flysight-audio/${name}.wav`, import.meta.url));
    assert.equal(bytes.toString('ascii', 0, 4), 'RIFF', name);
    assert.equal(bytes.toString('ascii', 8, 12), 'WAVE', name);
    assert.ok(bytes.length > 44, name);
  }
});

test('recordings are scheduled consecutively and cancelled together', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => ({ ok: true, arrayBuffer: async () => new ArrayBuffer(8) });
  try {
    const sources = [];
    const context = {
      currentTime: 5, destination: {},
      decodeAudioData: async () => ({ duration: 0.4 }),
      createGain: () => ({ gain: {}, connect() {}, disconnect() {} }),
      createBufferSource: () => {
        const source = { connect() {}, disconnect() {}, start(time) { this.time = time; }, stop() { this.stopped = true; } };
        sources.push(source); return source;
      },
    };
    const voice = new FlySightVoice(context);
    await voice.load('/');
    voice.speak(numberRecordings('3.2'), 0.5);
    assert.deepEqual(sources.map(s => s.time), [5, 5.4, 5.800000000000001]);
    assert.equal(voice.speaking, true);
    voice.stop();
    assert.equal(voice.speaking, false);
    assert.ok(sources.every(s => s.stopped));
    voice.speak(['flare'], 0.5);
    assert.equal(sources.length, 4);
  } finally { globalThis.fetch = originalFetch; }
});
