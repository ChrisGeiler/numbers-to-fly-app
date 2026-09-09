import { useEffect, useMemo, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { supabase } from './supabase';
import { getDetectedJumpTrack, parseFlySightCsv, trimTrackAfterLanding } from './gpsAnalysis';
import {
  canUseWindowAudioFirmware,
  detectSimulationFirmware,
  readSimulationConfig,
  simulationFirmwareTimeline,
  simulationSpeechDue,
  simulationSpeechNumber,
  simulationTimeline,
  simulationTone,
  simulationValue,
  simulationWindow,
} from './simulation';
import type { SimulationFirmwareProfile } from './simulation';
import { FlySightVoice, numberRecordings } from './flysightAudio';
import './ConfigSimulation.css';

type Track = { id: string; jump_date: string | null; location_name: string | null; task_type: string | null };
type Props = { config: string; task: string; userId?: string; userEmail?: string | null; invalid: boolean; onSignIn: () => void; renderGraph: (points: ReturnType<typeof simulationTimeline>, position: number) => ReactNode };

export default function ConfigSimulation({ config, task, userId, userEmail, invalid, onSignIn, renderGraph }: Props) {
  const [open, setOpen] = useState(false);
  const [filter, setFilter] = useState(task);
  const [tracks, setTracks] = useState<Track[]>([]);
  const [selected, setSelected] = useState('');
  const [sourcePoints, setPoints] = useState<ReturnType<typeof simulationTimeline>>([]);
  const [status, setStatus] = useState('');
  const [loading, setLoading] = useState(false);
  const [playing, setPlaying] = useState(false);
  const [position, setPosition] = useState(0);
  const [heard, setHeard] = useState('Ready');
  const [volume, setVolume] = useState(0.25);
  const audio = useRef<AudioContext | null>(null);
  const cursor = useRef(0);
  const speechDeadline = useRef(0);
  const voice = useRef<FlySightVoice | null>(null);
  const playRequest = useRef(0);
  const [audioLoading, setAudioLoading] = useState(false);
  const [selectedConfigName, setSelectedConfigName] = useState<string | null>(null);
  const [selectedConfigText, setSelectedConfigText] = useState<string | null>(null);
  const [firmwareProfile, setFirmwareProfile] = useState<SimulationFirmwareProfile>('standard');
  const [firmwareVersion, setFirmwareVersion] = useState<string | null>(null);
  const [fileStatus, setFileStatus] = useState('');
  const privateFirmwareAllowed = canUseWindowAudioFirmware(userEmail);
  const activeFirmwareProfile: SimulationFirmwareProfile = privateFirmwareAllowed
    ? firmwareProfile
    : 'standard';
  const effectiveConfig = selectedConfigText ?? config;
  const settings = useMemo(() => readSimulationConfig(effectiveConfig), [effectiveConfig]);
  const groundElevation = Number.isFinite(settings.values.DZ_Elev) ? settings.values.DZ_Elev : 0;
  const requiredConfigValues = ['Mode', 'Min', 'Max', 'DZ_Elev', 'Win_Top', 'Win_Bottom', 'Win_Above', 'Win_Below', 'V_Thresh', 'H_Thresh', 'Sp_Rate', 'Sp_Mode', 'Sp_Dec', 'Sp_Volume', 'Volume', 'Min_Val_2', 'Max_Val_2', 'Min_Rate', 'Max_Rate'];
  const selectedConfigInvalid = selectedConfigText !== null && (
    !requiredConfigValues.every(key => Number.isFinite(settings.values[key])) ||
    settings.values.Max <= settings.values.Min
  );
  const effectiveInvalid = selectedConfigText === null ? invalid : selectedConfigInvalid;
  const points = useMemo(() => simulationWindow(sourcePoints, groundElevation), [sourcePoints, groundElevation]);
  const firmwareTimeline = useMemo(
    () => simulationFirmwareTimeline(points, groundElevation, settings, activeFirmwareProfile),
    [points, groundElevation, settings, activeFirmwareProfile],
  );
  useEffect(() => { setPlaying(false); cursor.current = 0; speechDeadline.current = 0; setPosition(0); }, [groundElevation]);
  const duration = points.at(-1)?.seconds ?? 0;
  let index = points.findIndex(p => p.seconds > position);
  index = index === -1 ? points.length - 1 : Math.max(0, index - 1);
  const point = points[index];
  const firmwareState = firmwareTimeline[index]?.state;
  const firmwareLabel = activeFirmwareProfile === 'window-audio'
    ? 'Private window-audio firmware'
    : 'Standard FlySight 2 firmware';
  const missingVerticalAccuracy = activeFirmwareProfile === 'window-audio' &&
    points.length > 0 &&
    points.every(sample => sample.vAccM === null || sample.vAccM === undefined);
  useEffect(() => { setFilter(task); }, [task]);
  useEffect(() => {
    if (!privateFirmwareAllowed && firmwareProfile === 'window-audio') {
      setPlaying(false);
      setFirmwareProfile('standard');
      setFirmwareVersion(null);
    }
  }, [privateFirmwareAllowed, firmwareProfile]);
  useEffect(() => {
    if (!open || !userId) return;
    let cancelled = false;
    setLoading(true); setStatus(''); setTracks([]); setSelected(''); setPoints([]);
    void (async () => {
      try {
        let query = supabase.from('jumps').select('id,jump_date,location_name,task_type').eq('user_id', userId);
        if (filter !== 'all') query = query.eq('task_type', filter);
        const { data, error } = await query.order('jump_date', { ascending: false });
        if (cancelled) return;
        if (error) throw error;
        setTracks(data ?? []);
        if (!data?.length) setStatus('No tracks for this task. Try All tasks or save a flight in your logbook.');
      } catch { if (!cancelled) setStatus('Could not load your logbook. Close and reopen the simulation to retry.'); }
      finally { if (!cancelled) setLoading(false); }
    })();
    return () => { cancelled = true; };
  }, [open, userId, filter]);

  useEffect(() => {
    setPlaying(false); setPosition(0); cursor.current = 0; setHeard('Ready');
    if (!selected || !userId || !open) { setPoints([]); return; }
    let cancelled = false;
    setPoints([]); setLoading(true); setStatus('');
    void (async () => {
      try {
        const { data, error } = await supabase.from('jumps').select('raw_csv').eq('id', selected).eq('user_id', userId).single();
        if (cancelled) return;
        if (error) throw error;
        if (!data?.raw_csv) throw new Error('This track has no original GPS data. Choose another track.');
        const metadata = /(?:^|\r?\n)\$VAR,NTF_MANUAL_EXIT_TIME,([^\r\n]*)(?=\r?\n|$)/;
        const exit = Date.parse(data.raw_csv.match(metadata)?.[1] ?? '');
        const parsed = parseFlySightCsv(data.raw_csv.replace(metadata, ''));
        const detected = getDetectedJumpTrack(parsed);
        const flight = Number.isFinite(exit) ? parsed.filter(p => (p.timestampMs ?? 0) >= exit) : detected.jumpPoints;
        const timeline = simulationTimeline(trimTrackAfterLanding(flight.length ? flight : parsed));
        if (timeline.length < 2) throw new Error('This track has insufficient timed GPS data. Choose another track.');
        setPoints(timeline);
      } catch (error) { if (!cancelled) setStatus(error instanceof Error ? error.message : 'Could not load this track. Choose another track or try again.'); }
      finally { if (!cancelled) setLoading(false); }
    })();
    return () => { cancelled = true; };
  }, [selected, userId, open]);

  // A config change always stops the old preview before the new settings can play.
  useEffect(() => { setPlaying(false); speechDeadline.current = cursor.current; }, [effectiveConfig, activeFirmwareProfile, open, filter, userId, selected]);
  useEffect(() => {
    playRequest.current += 1;
    setAudioLoading(false);
    return () => { playRequest.current += 1; };
  }, [effectiveConfig, activeFirmwareProfile, open, filter, userId, selected]);
  useEffect(() => () => { voice.current?.stop(); void audio.current?.close(); }, []);

  useEffect(() => {
    if (!playing || !points.length || !audio.current) return;
    const context = audio.current;
    const { values: v, alarms } = settings;
    let last = performance.now();
    let nextTone = cursor.current;
    let nextSpeech = speechDeadline.current;
    const startingIndex = Math.max(0, points.findIndex(p => p.seconds >= cursor.current));
    let wasSuppressed = firmwareTimeline[startingIndex]?.suppressed ?? true;
    let toneUntil = 0;
    const tones = new Set<OscillatorNode>();
    function stopTones() { tones.forEach(tone => { tone.stop(); tone.disconnect(); }); tones.clear(); toneUntil = 0; }
    let previous = points[Math.max(0, points.findIndex(p => p.seconds >= cursor.current))];
    // Include the alarm at the clipped 3353 m entry, where playback starts.
    if (cursor.current === 0 && Math.abs(previous.altitudeM - v.DZ_Elev - 3353) < 0.001) {
      previous = { ...previous, altitudeM: previous.altitudeM + 0.001 };
    }
    const voices = voice.current!;
    function say(text: string, alarm = false) {
      setHeard(text);
      voices.speak(alarm ? [text] : numberRecordings(text), volume * v.Sp_Volume / 8);
    }    function beep(frequency: number, length = 0.125) {
      const oscillator = context.createOscillator();
      const gain = context.createGain();
      oscillator.frequency.value = frequency;
      gain.gain.setValueAtTime(0, context.currentTime);
      gain.gain.linearRampToValueAtTime(volume * 0.2 * v.Volume / 8, context.currentTime + 0.008);
      gain.gain.linearRampToValueAtTime(0, context.currentTime + length);
      oscillator.connect(gain); gain.connect(context.destination);
      tones.add(oscillator); toneUntil = context.currentTime + length; oscillator.start(); oscillator.stop(context.currentTime + length);
      oscillator.onended = () => { tones.delete(oscillator); oscillator.disconnect(); gain.disconnect(); };
    }
    const timer = window.setInterval(() => {
      const now = performance.now();
      const before = cursor.current;
      cursor.current = Math.min(duration, before + (now - last) / 1000); last = now;
      const i = points.findIndex(p => p.seconds > cursor.current);
      const sampleIndex = i === -1 ? points.length - 1 : Math.max(0, i - 1);
      const current = points[sampleIndex];
      const altitude = current.altitudeM - v.DZ_Elev;
      const silent = firmwareTimeline[sampleIndex]?.suppressed ?? true;
      if (silent && !wasSuppressed) { voices.stop(); stopTones(); }
      wasSuppressed = silent;
      const previousAltitude = previous.altitudeM - v.DZ_Elev;
      const crossed = alarms.filter(a => a.elevation >= Math.min(previousAltitude, altitude) && a.elevation < Math.max(previousAltitude, altitude));
      if (crossed.length) {
        const alarm = crossed[0]; stopTones(); voices.stop();
        if (alarm.type === 4) say(alarm.file, true);
        else if (alarm.type === 1) { beep(1760); setHeard('Altitude alarm · beep'); }
        nextTone = cursor.current;
      }

      const threshold = Math.abs(current.verticalSpeedMps) * 100 >= v.V_Thresh && current.horizontalSpeedMps * 100 >= v.H_Thresh;
      const value = simulationValue(current, v.Mode);
      if (!silent && threshold) {
        if (simulationSpeechDue(cursor.current, nextSpeech, v.Sp_Rate, silent, threshold, voices.speaking || context.currentTime < toneUntil)) {
          const spoken = simulationValue(current, v.Sp_Mode);
          if (spoken !== null) say(simulationSpeechNumber(spoken / 100 * (v.Sp_Mode === 2 ? 1 : 3.6), v.Sp_Dec));
          nextSpeech = cursor.current + v.Sp_Rate; speechDeadline.current = nextSpeech;
        }
        if (value !== null && cursor.current >= nextTone && !voices.speaking && context.currentTime >= toneUntil) {
          const priorSample = points[Math.max(0, sampleIndex - 2)];
          const oldValue = simulationValue(priorSample, v.Mode);
          if (oldValue !== null) {
            const { pitch, rate } = simulationTone(value, oldValue, current.seconds - priorSample.seconds, v);
            beep(pitch);
            nextTone = cursor.current + 1 / rate;
            setHeard(`Tone · ${pitch} Hz`);
          }
        }      } else if (!crossed.length && !voices.speaking) setHeard(silent ? 'Silence window' : 'Below tone threshold');
      previous = current;
      setPosition(cursor.current);
      if (cursor.current >= duration) { setPlaying(false); setHeard('Simulation complete'); }
    }, 40);
    const stopHidden = () => { if (document.hidden) setPlaying(false); };
    document.addEventListener('visibilitychange', stopHidden);
    return () => { clearInterval(timer); voices.stop(); stopTones(); void context.suspend(); document.removeEventListener('visibilitychange', stopHidden); };
  }, [playing, points, settings, firmwareTimeline, volume, duration]);

  async function chooseConfigFile(file?: File) {
    if (!file) return;
    setFileStatus('');
    try {
      const text = await file.text();
      const parsed = readSimulationConfig(text);
      const valid = requiredConfigValues.every(key => Number.isFinite(parsed.values[key])) &&
        parsed.values.Max > parsed.values.Min;
      if (!valid) {
        throw new Error('That file does not contain a complete FlySight audio configuration.');
      }
      setPlaying(false);
      cursor.current = 0;
      speechDeadline.current = 0;
      setPosition(0);
      setSelectedConfigName(file.name);
      setSelectedConfigText(text);
      setFileStatus(`Loaded config: ${file.name}`);
    } catch (error) {
      setFileStatus(error instanceof Error ? error.message : 'Could not read that config file.');
    }
  }

  function useGeneratedConfig() {
    setPlaying(false);
    cursor.current = 0;
    speechDeadline.current = 0;
    setPosition(0);
    setSelectedConfigName(null);
    setSelectedConfigText(null);
    setFileStatus('Using the config currently generated by the app.');
  }

  async function chooseFlySightInfo(file?: File) {
    if (!file) return;
    setFileStatus('');
    try {
      const detected = detectSimulationFirmware(await file.text());
      if (!detected.version) {
        throw new Error('No Firmware_Ver entry was found in that file.');
      }
      if (detected.profile === 'window-audio' && !privateFirmwareAllowed) {
        throw new Error('This private firmware simulator is not available for the signed-in account.');
      }
      setPlaying(false);
      setFirmwareVersion(detected.version);
      setFirmwareProfile(detected.profile);
      setFileStatus(
        detected.profile === 'window-audio'
          ? `Detected your private firmware: ${detected.version}`
          : `Detected standard firmware: ${detected.version}`,
      );
    } catch (error) {
      setFileStatus(error instanceof Error ? error.message : 'Could not read FLYSIGHT.TXT.');
    }
  }

  async function play() {
    const request = ++playRequest.current;
    setAudioLoading(true); setStatus('');
    try {
      audio.current ??= new AudioContext();
      voice.current ??= new FlySightVoice(audio.current);
      await audio.current.resume();
      await voice.current.load(import.meta.env.BASE_URL);
      if (request !== playRequest.current) return;
      if (cursor.current >= duration) { cursor.current = 0; speechDeadline.current = 0; setPosition(0); }
      setPlaying(true);
    } catch { if (request === playRequest.current) setStatus('Could not load or play FlySight audio. Check your connection and browser audio permissions, then try again.'); }
    finally { if (request === playRequest.current) setAudioLoading(false); }
  }  function seek(value: number) { playRequest.current += 1; setAudioLoading(false); setPlaying(false); cursor.current = value; speechDeadline.current = value; setPosition(value); setHeard('Paused'); }

  return <section className="card config-simulation">
    <h2>Listen to your flight</h2>
    <p>Preview the generated config or choose a FlySight config file and play it alongside a track from your logbook.</p>
    {selectedConfigText === null && invalid && <p role="status">Enter a tone minimum and a higher tone maximum, or open the simulator and choose a complete config file.</p>}
    {selectedConfigInvalid && <p role="status">The selected config is missing settings needed by the simulator.</p>}
    {!open ? <button type="button" onClick={() => setOpen(true)}>Play simulation</button> : <>
      <div className="simulation-controls">
        <h3>Choose a logbook track</h3>
        <button type="button" onClick={() => { setPlaying(false); setOpen(false); }}>Close simulation</button>
      </div>
      <div className="simulation-file-controls">
        <label>
          Config to play
          <input
            type="file"
            accept=".txt,text/plain"
            onChange={event => {
              void chooseConfigFile(event.currentTarget.files?.[0]);
              event.currentTarget.value = '';
            }}
          />
        </label>
        <label>
          Firmware behaviour
          <select
            value={activeFirmwareProfile}
            onChange={event => {
              setPlaying(false);
              setFirmwareVersion(null);
              setFirmwareProfile(event.currentTarget.value as SimulationFirmwareProfile);
            }}
          >
            <option value="standard">Standard FlySight 2 firmware</option>
            {privateFirmwareAllowed && <option value="window-audio">Chris’s private window-audio firmware</option>}
          </select>
        </label>
        <label>
          Detect from FLYSIGHT.TXT
          <input
            type="file"
            accept=".txt,text/plain"
            onChange={event => {
              void chooseFlySightInfo(event.currentTarget.files?.[0]);
              event.currentTarget.value = '';
            }}
          />
        </label>
        {selectedConfigText !== null && <button type="button" onClick={useGeneratedConfig}>Use generated config</button>}
      </div>
      <p className="subtitle">
        Config: <strong>{selectedConfigName ?? `Generated ${task} config`}</strong> · Firmware: <strong>{firmwareLabel}</strong>
        {firmwareVersion ? ` (${firmwareVersion})` : ''}
      </p>
      <p className="subtitle">A config file contains settings but not the device firmware version. Select FLYSIGHT.TXT to detect it automatically, or choose the firmware behaviour manually.</p>
      {fileStatus && <p role="status">{fileStatus}</p>}
      {!userId ? <><p>Sign in to choose a saved flight.</p><button type="button" onClick={onSignIn}>Sign in to logbook</button></> : <>
        <div className="simulation-controls">
          <label>Track task<select value={filter} onChange={e => { setPlaying(false); setFilter(e.target.value); }}>
            <option value="distance">Distance</option><option value="speed">Speed</option><option value="time">Time</option><option value="all">All tasks</option>
          </select></label>
          <label>Logbook track<select value={selected} disabled={loading} onChange={e => { setPlaying(false); setSelected(e.target.value); }}>
            <option value="">Select a track…</option>
            {tracks.map(t => <option key={t.id} value={t.id}>{t.jump_date ? new Date(t.jump_date).toLocaleString() : 'Undated flight'} · {t.location_name || 'Unknown location'} · {t.task_type || 'Unassigned'}</option>)}
          </select></label>
        </div>
        <p>Previewing <strong>{selectedConfigName ?? `your ${task} config`}</strong>. Track filtering does not change the selected config.</p>
        {loading && <p role="status">Loading tracks…</p>}
        {status && <p role="status">{status}</p>}
        {missingVerticalAccuracy && <p role="status">This track has no vertical-accuracy data, so it cannot reproduce the private firmware’s flight-confirmation check. Choose a FlySight 2 track containing vAcc data.</p>}
        {sourcePoints.length > 0 && points.length < 2 && <p role="status">This track has no playable section between 3353 m and 1500 m above ground. Check your config’s ground elevation or choose another track.</p>}
        {point && points.length >= 2 && <>
          <p>Playing from 3353 m to the bottom of the competition window at 1500 m AGL, using the available track within this section.</p>
          {renderGraph(points, position)}
          <div className="simulation-readings">
            <span>Altitude <strong>{Math.round(point.altitudeM - settings.values.DZ_Elev)} m AGL</strong></span>
            <span>Horizontal <strong>{(point.horizontalSpeedMps * 3.6).toFixed(0)} km/h</strong></span>
            <span>Vertical <strong>{(point.verticalSpeedMps * 3.6).toFixed(0)} km/h</strong></span>
            <span>Glide ratio <strong>{point.glideRatio?.toFixed(2) ?? '—'}</strong></span>
            {activeFirmwareProfile === 'window-audio' && <span>Firmware state <strong>{firmwareState ?? 'pre-flight'}</strong></span>}
          </div>
          <label>Flight timeline · {position.toFixed(1)} / {duration.toFixed(1)} s
            <input className="simulation-timeline" aria-label="Flight position" type="range" min="0" max={duration} step="0.1" value={position} onChange={e => seek(Number(e.target.value))} />
          </label>
          <div className="simulation-controls">
            <button type="button" disabled={effectiveInvalid || audioLoading || missingVerticalAccuracy} onClick={() => playing ? setPlaying(false) : void play()}>{audioLoading ? 'Loading audio…' : playing ? 'Pause' : position >= duration ? 'Replay' : 'Play'}</button>
            <button type="button" onClick={() => seek(0)}>Restart</button>
            <label>Volume<input type="range" min="0" max="1" step="0.05" value={volume} onChange={e => { setPlaying(false); setVolume(Number(e.target.value)); }} /></label>
            <span>{heard}</span>
          </div>
        </>}
      </>}
      <p className="subtitle">Uses original FlySight voice and alarm recordings. The selected firmware behaviour is reproduced by the app; the compiled firmware is not executed and the app does not send simulated GNSS data to the physical FlySight. Browser sound and timing can differ from the device. Altitude uses the ground elevation in the selected config.</p>
    </>}
  </section>;
}
