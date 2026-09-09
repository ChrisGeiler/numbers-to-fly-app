export const recordingNames = [
  '000', '00', '0', '1', '2', '3', '4', '5', '6', '7', '8', '9',
  '10', '12', '13', '14', '15', '16', '17', '18', '19',
  '20', '30', '40', '50', '60', '70', '80', '90',
  'alt', 'base', 'bearing', 'directn', 'distance', 'dive', 'dot', 'feet',
  'flare', 'glide', 'horz', 'iglide', 'km', 'knots', 'left', 'meters',
  'miles', 'minus', 'nav', 'org', 'right', 'speed', 'time', 'vert', 'wowsd', 'wowss',
];

// Read numbers digit by digit: this also handles 11 without a missing 11.wav.
export function numberRecordings(value: string): string[] {
  if (!/^-?\d+(\.\d+)?$/.test(value)) return [];
  return [...value].map(character => character === '.' ? 'dot' : character === '-' ? 'minus' : character);
}

export class FlySightVoice {
  private buffers = new Map<string, AudioBuffer>();
  private sources = new Set<AudioBufferSourceNode>();
  private pending: Promise<void> | null = null;
  private until = 0;

  constructor(privateContext: AudioContext) { this.context = privateContext; }
  private context: AudioContext;

  load(baseUrl: string) {
    if (this.pending) return this.pending;
    this.pending = Promise.all(recordingNames.map(async name => {
      if (this.buffers.has(name)) return;
      const response = await fetch(`${baseUrl}flysight-audio/${name}.wav`);
      if (!response.ok) throw new Error(`Could not load FlySight recording: ${name}.wav`);
      const buffer = await this.context.decodeAudioData(await response.arrayBuffer());
      this.buffers.set(name, buffer);
    })).then(() => undefined).catch(error => { this.pending = null; throw error; });
    return this.pending;
  }

  get speaking() { return this.context.currentTime < this.until; }

  stop() {
    this.sources.forEach(source => { source.stop(); source.disconnect(); });
    this.sources.clear();
    this.until = 0;
  }

  speak(names: string[], volume: number) {
    this.stop();
    let start = this.context.currentTime;
    for (const name of names) {
      const buffer = this.buffers.get(name);
      if (!buffer) throw new Error(`Missing FlySight recording: ${name}.wav`);
      const source = this.context.createBufferSource();
      const gain = this.context.createGain();
      source.buffer = buffer;
      gain.gain.value = volume;
      source.connect(gain); gain.connect(this.context.destination);
      this.sources.add(source);
      source.onended = () => { this.sources.delete(source); source.disconnect(); gain.disconnect(); };
      source.start(start);
      start += buffer.duration;
    }
    this.until = start;
  }
}
