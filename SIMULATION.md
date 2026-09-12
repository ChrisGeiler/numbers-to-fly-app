Simulation audio reference
==========================

The preview supports settings emitted by the config builder or loaded from a selected FlySight config TXT: horizontal/vertical speed or GR tones, change-in-value rate mode, clamped tone limits, speed or GR speech, file/beep alarms, and silence windows. It plays the available 3353–1500 m AGL section.

Standard FlySight 2 behaviour remains the default. For the authorized `starcruza@hotmail.com` account, the optional private window-audio profile reproduces the private firmware, including sustained-descent flight confirmation, the Time/Distance approach GR guide, descending window entry, and the post-entry flare-climb latch. Selecting `FLYSIGHT.TXT` automatically chooses this profile and its version-specific behaviour when a supported private version is detected; otherwise the authorized user can select the latest behaviour manually. Config files do not contain a firmware version.

Checked against official firmware on 2026-09-09:
- https://github.com/flysight/flysight-2-firmware/blob/master/FlySight/audio_control.c
- https://github.com/flysight/flysight/blob/master/src/UBX.c

Speech deadlines continue through silence and alarms. With standard firmware an alarm interrupts speech, but does not start a fresh speech interval. After the private firmware's flare latch, a crossed alarm waits for the active spoken performance value to finish, then plays normally. Pending speech waits for the alarm beep/recording to finish. Entering an alarm margin stops ordinary audio before the private flare latch. Speed thresholds use absolute vertical speed. Decimal readings are truncated, not rounded. Normal speed and GR readings use digit recordings.

For the latest private firmware, app-generated Time and Distance configs enable a 50%-volume GR guide from the descending “3” alarm crossing to the window-start beep. Its pitch range is GR 1.0–2.5, it reuses the configured tone-rate rules, and it never schedules performance speech. Countdown alarms retain priority. App-generated Speed configs explicitly disable this guide.

FlySight 2 tone pitch spans 220–1760 Hz linearly. Tones and alarm beeps last 125 ms. Change-in-value tone rate uses two GPS sample intervals and is normalized by the configured tone range, rather than the current reading.

Limits: this is a browser model, not execution of the compiled firmware or a physical-device validation. The current FlySight 2 interfaces do not accept replayed GNSS samples from the app. The preview uses recorded sample times, floating-point calculations and browser scheduling rather than firmware fixed-point arithmetic and its hardware clock. Audio output and volume response differ from the device. FlySight 1's tone implementation differs; the preview currently uses FlySight 2 pitch. Startup/GPS acquisition audio is outside the clipped flight. Imported configurations using navigation, SAS, altitude-step speech, other limit modes or other rate modes are not fully supported. Pause cancels the current utterance; seeking starts a fresh preview at the chosen point.
