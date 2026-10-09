using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Globalization;
using System.Linq;
using System.Text.Json;
using System.Threading;
using System.Threading.Tasks;
using NAudio.CoreAudioApi;
using NAudio.Wave;

namespace Miku.Audio;

public sealed record OutputPlan(string Mode, string DeviceId, string AsioDriver, int Rate, int OutChannels, SampleFormat Format, bool Dop, int BufferMs);

public sealed class SourcePlan
{
    public bool Dop;
    public DsdInfo Dsd;
    public bool Resample;
    public int SourceRate;
    public string Note;   // why the requested DSD path (DoP / PCM rate) could not be used
}

public sealed class SignalInfo
{
    public string Codec { get; set; }
    public int SourceRate { get; set; }
    public int SourceBits { get; set; }
    public bool Dsd { get; set; }
    public string DsdLabel { get; set; }
    public bool Lossy { get; set; }
    public bool Dop { get; set; }
    public bool Resampled { get; set; }
    public bool DsdDirect { get; set; }
    public string DsdTransport { get; set; }
    public int OutputRate { get; set; }
    public string OutputFormat { get; set; }
    public int OutputBits { get; set; }
    public string Mode { get; set; }
    public string Device { get; set; }
    public bool DspActive { get; set; }
    public string DspSummary { get; set; }
    public string VolumeMode { get; set; }
    public double? ReplayGainDb { get; set; }
    public string Quality { get; set; } // bitperfect | enhanced | high | low
    public string Note { get; set; }
    /// <summary>
    /// A playback core from an extension module may describe its own signal path: any object with an "ext" member
    /// naming the module, drawn by that module's page script (MikuExt signalPath). Null: the standard layout.
    /// </summary>
    public object Custom { get; set; }
    public string Decoder { get; set; }
    public string Resampler { get; set; }
    public double? ResamplerBandwidth { get; set; }
    public double? ResamplerGainDb { get; set; }
    public string Quantization { get; set; }
    public bool? EventDriven { get; set; }
    public int SourceChannels { get; set; }
    public bool SourceFloatingPoint { get; set; }
    public bool OutputFloatingPoint { get; set; }
}

public sealed class AudioEngine : IAudioEngine
{
    readonly Settings _s;
    readonly Action<Action> _ui;
    readonly SemaphoreSlim _gate = new(1, 1);
    readonly Timer _monitor;
    int _loadVersion;

    IWavePlayer _out;
    MMDevice _device;
    DeviceCaps _caps;
    PlaybackChain _chain;
    OutputPlan _plan;
    Segment _lastAudible;
    PcmSource _preloadTriedFor;
    volatile bool _paused;
    double? _pausedAt;    // audible position kept while paused, even if the output clock resets
    bool _wasapiStopped;  // WASAPI is stopped (but still initialized) until the source is rebuilt for Resume
    long _wasapiFrameBase; // frames submitted before the most recent WASAPI clock reset
    double? _hwRestoreDb;
    bool _reopenFailed;   // the DAC couldn't be reopened recently: prefer keeping the open output over reopening
    bool _sharedFallback; // last open fell back to shared mode because another program held the DAC
    readonly object _deviceLock = new();   // _device is released by device changes while volume code may use it
    string _deviceId;     // ID of _device, read once when it was opened (a removed device can't be asked any more)
    int _activeVersion;   // the load request the gate is working on (Stop and newer loads make it stale)
    readonly DeviceWatcher _watcher;
    int _deviceEventSeq;
    readonly List<DateTime> _recoveries = new();
    volatile bool _disposed;

    public Func<Track> PeekNext { get; set; }
    /// <summary>Asks other audio inside MIKU (the YouTube Music page) to let go of the DAC before a local track opens it.</summary>
    public Func<Task> ReleaseOthers { get; set; }
    public event Action<Track> TrackStarted;  // gapless transition
    public event Action Ended;
    public event Action<string> Failed;
    public event Action Changed;
    /// <summary>A track is about to be loaded (used to pause YouTube before a local track takes the DAC).</summary>
    public event Action<Track> Loading;
    /// <summary>An output device was connected, removed, enabled / disabled, or the system output changed.</summary>
    public event Action DevicesChanged;

    public SignalInfo Signal { get; private set; }
    /// <summary>The last load failed because the output device could not be opened (not because the file is bad).</summary>
    public bool LastFailureWasDevice { get; private set; }
    public Track Track { get; private set; }
    public bool IsPlaying => _out != null && _out.PlaybackState == PlaybackState.Playing && !_paused;
    public bool IsLoaded => _out != null && _chain != null;
    public DeviceCaps Caps => _caps;

    public AudioEngine(Settings settings, Action<Action> uiInvoke)
    {
        _s = settings;
        _ui = uiInvoke;
        _monitor = new Timer(_ => Monitor(), null, 40, 40);
        try { _watcher = new DeviceWatcher(OnDeviceEvent); }
        catch (Exception ex) { Log.Error("Device notifications", ex); }
    }

    // ───────────────────────────── device changes ─────────────────────────────

    /// <summary>Windows sends bursts (state, removed, new default …): act once, after they have settled, off the COM thread.</summary>
    void OnDeviceEvent(string what)
    {
        int seq = Interlocked.Increment(ref _deviceEventSeq);
        Task.Delay(400).ContinueWith(_ =>
        {
            if (seq != Volatile.Read(ref _deviceEventSeq) || _disposed) return Task.CompletedTask;
            return HandleDeviceChangeAsync(what);
        }).Unwrap().ContinueWith(t => { if (t.IsFaulted) Log.Error("Device change", t.Exception); });
    }

    async Task HandleDeviceChangeAsync(string what)
    {
        DevicesChanged?.Invoke();
        if (_plan?.Mode == "asio" || _s.OutputMode == "asio") return;
        string openId = _deviceId;
        if (openId == null) return;
        string want = string.IsNullOrEmpty(_s.DeviceId) ? null : _s.DeviceId;
        if (!Devices.IsActive(openId))
        {
            Log.Info($"Output device removed or disabled ({what})");
            await DeviceLostAsync(null);
            return;
        }
        // Following the system output and it moved, or the selected device is back after a fallback.
        bool moved = want == null ? Devices.DefaultId() is { } def && def != openId : openId != want && Devices.IsActive(want);
        if (!moved) return;
        Log.Info($"Output device changed ({what}): moving playback");
        if (_out == null)
        {
            // nothing open: forget the old device, the next Play opens the right one
            await _gate.WaitAsync();
            try { if (_out == null) ReleaseDevice(); } finally { _gate.Release(); }
            Changed?.Invoke();
            return;
        }
        if (AllowRecovery()) await ReconfigureAsync();
    }

    /// <summary>A few automatic reopenings in a row are fine; more means something keeps fighting over the device.</summary>
    bool AllowRecovery()
    {
        lock (_recoveries)
        {
            var now = DateTime.UtcNow;
            _recoveries.RemoveAll(t => now - t > TimeSpan.FromSeconds(15));
            if (_recoveries.Count >= 3) return false;
            _recoveries.Add(now);
            return true;
        }
    }

    double SafePosition() { try { return Position; } catch { return _pausedAt ?? 0; } }

    /// <summary>
    /// The output stopped by itself (device unplugged, disabled, or its format changed / taken by another program).
    /// The track stays, paused at the place it was; if the device is still there it is opened again right away.
    /// </summary>
    async Task DeviceLostAsync(object output, Exception error = null)
    {
        var t = Track;
        double pos = SafePosition();
        bool wasPlaying = !_paused && _out != null;
        string id = _deviceId, name = _caps?.Name ?? "輸出裝置";
        await _gate.WaitAsync();
        try
        {
            if (output != null && !ReferenceEquals(output, _out)) return;   // already replaced by a newer output
            TearDown();
            ReleaseDevice();
            if (t != null) { Track = t; _pausedAt = t.IsLive ? 0 : Math.Max(0, pos); _paused = true; Signal = null; }
        }
        finally { _gate.Release(); }
        bool stillThere = Devices.IsActive(id);
        if (t != null && wasPlaying && stillThere && AllowRecovery())
        {
            Log.Info($"Output stopped but {name} is still there: reopening at {pos:0.00}s");
            await LoadAsync(t, t.IsLive ? 0 : pos, true);
            return;
        }
        if (t != null && wasPlaying)
            Failed?.Invoke(stillThere ? "輸出中斷：" + error?.Message
                : $"「{name}」已中斷連線，已暫停播放。重新連接或選擇其他輸出裝置後按播放即可從原位置繼續。");
        Changed?.Invoke();
    }

    void ReleaseDevice()
    {
        MMDevice d;
        lock (_deviceLock) { d = _device; _device = null; _deviceId = null; _caps = null; }
        Devices.Release(d);
    }

    // ───────────────────────────── planning ─────────────────────────────

    [ThreadStatic] static bool _liveDesired;

    (OutputPlan, SourcePlan) BuildPlan(Track t) => BuildPlan(t, _sharedFallback);

    (OutputPlan, SourcePlan) BuildPlan(Track t, bool forceShared)
    {
        _liveDesired = t.IsLive; // live YouTube audio stays at 48 kHz, no upsampling
        var sp = new SourcePlan { SourceRate = t.SampleRate };
        if (t.IsDsd)
        {
            try { sp.Dsd = DsdInfo.Read(t.Path); } catch (Exception ex) { Log.Error("DSD header", ex); }
        }
        if (t.IsLive) sp.SourceRate = LiveBus.Rate;
        else if (sp.SourceRate <= 0 && !t.IsDsd) sp.SourceRate = ProbeRate(t.Path);
        int bufferMs = Math.Clamp(_s.BufferMs, 30, 1000);

        if (_s.OutputMode == "asio")
        {
            string driver = _s.AsioDriver ?? Devices.AsioDrivers().FirstOrDefault() ?? throw new InvalidOperationException("找不到 ASIO 驅動程式");
            var rates = AsioRates(driver);
            int src = sp.Dsd != null ? _s.DsdPcmRate : (sp.SourceRate > 0 ? sp.SourceRate : 44100);
            int rate = ChooseRate(DesiredRate(src, rates), rates);
            if (rate == 0) throw new InvalidOperationException("ASIO 驅動程式沒有回報可用的取樣率");
            sp.Resample = sp.Dsd != null || rate != sp.SourceRate;
            return (new OutputPlan("asio", null, driver, rate, 2, SampleFormat.Int32, false, bufferMs), sp);
        }

        EnsureDevice();
        if (_s.OutputMode == "shared" || forceShared)
        {
            int rate = _caps.MixRate > 0 ? _caps.MixRate : 48000;
            int ch = Math.Max(2, _caps.MixChannels);
            sp.Resample = sp.Dsd != null || rate != sp.SourceRate;
            return (new OutputPlan("shared", _deviceId, null, rate, ch, SampleFormat.Float32, false, bufferMs), sp);
        }

        // exclusive
        if (sp.Dsd != null && _s.DsdFor("exclusive") == "dop" && !sp.Dsd.Compressed && sp.Dsd.Channels == 2)
        {
            int dopRate = DopSource.DopRate(sp.Dsd);
            var f = _caps.BestFormat(dopRate, needInteger24: true);
            if (f != null)
            {
                sp.Dop = true;
                return (new OutputPlan("exclusive", _deviceId, null, dopRate, 2, f.Value, true, bufferMs), sp);
            }
            sp.Note = $"DAC 目前沒有回報支援 {dopRate / 1000.0:0.#} kHz 24-bit，無法以 DoP 輸出，改為轉 PCM 播放。";
        }
        var supported = _caps.Rates.ToList();
        if (supported.Count == 0) throw new InvalidOperationException($"「{_caps.Name}」不支援 WASAPI 獨佔模式，請在設定改用共享模式。");
        int source = sp.Dsd != null ? _s.DsdPcmRate : (sp.SourceRate > 0 ? sp.SourceRate : 44100);
        int r = ChooseRate(DesiredRate(source, supported), supported);
        var fmt = _caps.BestFormat(r) ?? SampleFormat.Int16;
        sp.Resample = sp.Dsd != null || r != sp.SourceRate;
        if (sp.Dsd != null && r != _s.DsdPcmRate)
            sp.Note ??= $"DAC 目前沒有回報支援 {_s.DsdPcmRate / 1000.0:0.#} kHz，DSD 改轉為 {r / 1000.0:0.#} kHz PCM。";
        if (sp.Note != null)
            Log.Info($"DSD plan: {sp.Note} (exclusive rates: {string.Join(", ", supported)}{(_caps.Partial ? ", partial probe" : "")})");
        return (new OutputPlan("exclusive", _deviceId, null, r, 2, fmt, false, bufferMs), sp);
    }

    int DesiredRate(int src, List<int> supported)
    {
        if (_liveDesired) return src;
        switch (_s.Upsampling)
        {
            case "2x": return supported.Contains(src * 2) ? src * 2 : src;
            case "max":
                int fam = Formats.Family(src);
                var same = supported.Where(r => Formats.Family(r) == fam).ToList();
                return same.Count > 0 ? same.Max() : src;
            case "fixed": return _s.FixedRate;
            default: return src;
        }
    }

    static int ChooseRate(int desired, List<int> supported)
    {
        if (supported.Count == 0) return 0;
        if (supported.Contains(desired)) return desired;
        int fam = Formats.Family(desired);
        var sameBelow = supported.Where(r => Formats.Family(r) == fam && r <= desired).ToList();
        if (sameBelow.Count > 0) return sameBelow.Max();
        var above = supported.Where(r => r >= desired).ToList();
        if (above.Count > 0) return above.Min();
        return supported.Max();
    }

    static int ProbeRate(string path)
    {
        try
        {
            using var p = Ffmpeg.Start(new[] { "-v", "error", "-select_streams", "a:0", "-show_entries", "stream=sample_rate", "-of", "csv=p=0", path }, Ffmpeg.ProbePath);
            string s = p.StandardOutput.ReadToEnd();
            p.WaitForExit(3000);
            return int.TryParse(s.Trim().Split('\n')[0].Trim(), out int r) ? r : 0;
        }
        catch { return 0; }
    }

    readonly Dictionary<string, List<int>> _asioRates = new();
    /// <summary>Sample rates the ASIO driver accepts (probed once, cached).</summary>
    public List<int> AsioRates(string driver)
    {
        lock (_asioRates)
            if (_asioRates.TryGetValue(driver, out var cached)) return cached;
        var list = new List<int>();
        _ui(() =>
        {
            using var asio = new AsioOut(driver);
            foreach (int r in Formats.ProbeRates)
            {
                try { if (asio.IsSampleRateSupported(r)) list.Add(r); } catch { }
            }
        });
        lock (_asioRates) _asioRates[driver] = list;
        return list;
    }

    void EnsureDevice()
    {
        string want = string.IsNullOrEmpty(_s.DeviceId) ? null : _s.DeviceId;
        if (_device != null)
        {
            if (DeviceStillRight())
            {
                // a probe taken while another app (Roon…) was playing only lists that app's rate: probe again
                if (_caps == null || _caps.Partial) _caps = Devices.Probe(_device);
                return;
            }
            ReleaseDevice();
        }
        var d = Devices.Open(want);
        string id;
        try { id = d.ID; } catch { Devices.Release(d); throw; }
        lock (_deviceLock) { _device = d; _deviceId = id; }
        _caps = Devices.Probe(d);
    }

    /// <summary>
    /// The open device is still the right one: still connected, and still the system output (when MIKU follows it) or
    /// the selected device (or the fallback while the selected one is missing). The old code kept a device that had
    /// been unplugged, so every later track failed to open.
    /// </summary>
    bool DeviceStillRight()
    {
        string want = string.IsNullOrEmpty(_s.DeviceId) ? null : _s.DeviceId;
        MMDevice d; string id;
        lock (_deviceLock) { d = _device; id = _deviceId; }
        if (d == null) return false;
        try
        {
            return d.State == DeviceState.Active
                && (want == null ? id == Devices.DefaultId() : id == want || !Devices.IsActive(want));
        }
        catch { return false; }
    }

    /// <summary>The device's name without asking a device that may already be gone.</summary>
    string DeviceName => _caps?.Name ?? "輸出裝置";

    /// <summary>The selected device isn't connected, so the system output is used.</summary>
    bool OnFallbackDevice => !string.IsNullOrEmpty(_s.DeviceId) && _deviceId != null && _deviceId != _s.DeviceId;

    PcmSource CreateSource(Track t, double seek, SourcePlan sp, OutputPlan op)
    {
        if (t.IsLive) return new LiveSource(t, op.Rate);
        if (sp.Dop) return new DopSource(t, sp.Dsd, seek);
        double gain = 1;
        if (_s.ReplayGain != "off")
        {
            double? rg = _s.ReplayGain == "album" ? (t.RgAlbum ?? t.RgTrack) : (t.RgTrack ?? t.RgAlbum);
            if (rg.HasValue) gain = Math.Pow(10, (rg.Value + _s.ReplayGainPreamp) / 20);
        }
        return new FfmpegSource(t, seek, op.Rate, sp.Resample, gain);
    }

    // ───────────────────────────── transport ─────────────────────────────

    public async Task LoadAsync(Track t, double seek, bool play)
    {
        int version = Interlocked.Increment(ref _loadVersion);
        LastFailureWasDevice = false;
        Loading?.Invoke(t);
        if (play && !t.IsLive && ReleaseOthers != null)
        {
            try { await Task.WhenAny(ReleaseOthers(), Task.Delay(1500)); } catch (Exception ex) { Log.Error("ReleaseOthers", ex); }
        }
        await _gate.WaitAsync();
        try
        {
            if (version != Volatile.Read(ref _loadVersion)) return; // superseded by a newer request
            _activeVersion = version;
            await Task.Run(() => LoadCore(t, seek, play));
        }
        catch (OperationCanceledException)
        {
            Log.Info("Load superseded while opening the output");
            TearDown();
        }
        catch (Exception ex)
        {
            Log.Error("Load " + (t.IsLive ? "YouTube" : t.Path), ex);
            LastFailureWasDevice = IsDeviceError(ex) || ex.Message.Contains("無法開啟") || ex.Message.Contains("獨佔模式");
            TearDown();
            // a device that failed (removed meanwhile, invalidated…) is opened afresh next time
            if (LastFailureWasDevice) ReleaseDevice();
            Track = t;
            Signal = null;
            // keep the place, so Play tries again from there
            if (!t.IsLive) { _pausedAt = Math.Max(0, seek); _paused = true; }
            Failed?.Invoke(ex.Message);
        }
        finally { _gate.Release(); Changed?.Invoke(); }
    }

    /// <summary>Set while a newer request (or Stop) has replaced the one being opened.</summary>
    bool Superseded => _activeVersion != Volatile.Read(ref _loadVersion);

    /// <summary>The failure is about the output device (busy, removed, none at all), not the file.</summary>
    static bool IsDeviceError(Exception ex)
    {
        for (var e = ex; e != null; e = e.InnerException)
        {
            if (e is DeviceBusyException || e is NoOutputDeviceException) return true;
            uint hr = unchecked((uint)e.HResult);
            if ((hr & 0xFFFF0000) == 0x88890000) return true;   // AUDCLNT_E_*: device invalidated, in use, format…
            if (hr == 0x80070490 || hr == 0x8007048F) return true;   // element not found / device not connected
        }
        return IsDeviceInUse(ex);
    }

    void LoadCore(Track t, double seek, bool play)
    {
        if (!play || _s.OutputMode != "exclusive") { LoadCore(t, seek, play, false); return; }
        try
        {
            // always try exclusive first, so MIKU goes back to bit-perfect as soon as the DAC is free again
            LoadCore(t, seek, play, false);
            _sharedFallback = false;
        }
        catch (DeviceBusyException busy)
        {
            Log.Info("Exclusive busy (" + busy.Holders + "), falling back to shared mode");
            try { LoadCore(t, seek, play, true); }
            catch (Exception ex) when (IsDeviceInUse(ex))
            {
                // shared fails too: the other program holds the DAC exclusively
                throw new InvalidOperationException(busy.Message);
            }
            _sharedFallback = true;
            if (Signal != null)
                Signal.Note = $"DAC 正被 {busy.Holders} 使用，這首暫時以共享模式播放（非 bit-perfect）。對方放開後，換下一首就會自動回到獨佔模式。";
        }
    }

    void LoadCore(Track t, double seek, bool play, bool forceShared)
    {
        var (plan, sp) = BuildPlan(t, forceShared);
        seek = Math.Max(0, Math.Min(seek, Math.Max(0, t.Duration - 0.5)));
        if (!play)
        {
            // loaded but paused: remember the track and position without opening (and locking) the DAC
            TearDown();
            Track = t;
            _pausedAt = seek;
            _paused = true;
            Signal = BuildSignal(t, sp, plan);
            return;
        }
        // Switching between YouTube (48 kHz) and an album (44.1 kHz…) normally closes the DAC and reopens it at the
        // new rate. When another player (Roon's RAATServer) is registered on the DAC it grabs the device in that
        // gap and MIKU can't get it back. So while such a program is present, keep the open output and resample
        // the new source to its rate instead of letting go of the DAC.
        // Likewise when switching between YouTube and a local track (either direction), and after a reopen has
        // already failed once this session: reopening the DAC there is exactly what keeps failing, so stay on the
        // open output. Album → album changes still reopen at the native rate (bit-perfect) when nothing is in the way.
        string keptNote = null;
        if (_out != null && _chain != null && _plan != null && plan != _plan && plan.Mode == _plan.Mode && plan.DeviceId == _plan.DeviceId
            && plan.Mode != "asio" && !plan.Dop && !_plan.Dop && _device != null)
        {
            bool sourceSwitch = Track != null && Track.IsLive != t.IsLive;
            bool others = OthersOnDevice(_device, out string who);
            if (sourceSwitch || others || _reopenFailed)
            {
                string why = others ? $"{who} 也掛在這個 DAC 上" : sourceSwitch ? "YouTube 與專輯切換" : "先前重新開啟 DAC 失敗過";
                Log.Info($"Keeping the open {_plan.Rate} Hz output instead of reopening at {plan.Rate} Hz (switch={sourceSwitch}, others={who}, reopenFailed={_reopenFailed})");
                keptNote = $"{why}，為了避免切換時 DAC 開不回來，這首沿用目前的 {_plan.Rate / 1000.0:0.#} kHz 輸出（重新取樣）。下一首專輯曲目會再回到原生取樣率。";
                plan = _plan;
                sp.Resample = sp.Dsd != null || plan.Rate != sp.SourceRate;
            }
        }
        var src = CreateSource(t, seek, sp, plan);
        try
        {
            src.WaitPrefill(t.IsLive ? 0.25 : 0.6, 4000);
            if (src.IsEnded && src.Error != null) throw new InvalidOperationException(src.Error);
            if (_out == null || _chain == null || plan != _plan)
            {
                TearDown();
                OpenOutput(plan);
                plan = _plan; // ASIO may select a different output sample format.
            }
            Track = t;
            _lastAudible = null;
            _preloadTriedFor = null;
            var dead = _chain.SetSource(src, fromSeek: true);
            foreach (var d in dead) d.Dispose();
            src = null;
            ApplyVolume();
            Signal = BuildSignal(t, sp, plan);
            if (keptNote != null && Signal != null) Signal.Note = keptNote;
            if (OnFallbackDevice && Signal != null && plan.Mode != "asio")
                Signal.Note = "找不到選定的輸出裝置，暫時改用系統預設輸出；裝置接回後會自動切回。" + (Signal.Note == null ? "" : " " + Signal.Note);
            _wasapiStopped = false;
            _pausedAt = null;
            _paused = false;
            _out.Play();
        }
        finally { src?.Dispose(); }
    }

    void OpenOutput(OutputPlan plan)
    {
        double gain = plan.Dop ? 1 : DigitalGain();
        if (plan.Mode == "asio")
        {
            Exception last = null;
            foreach (var fmt in new[] { SampleFormat.Int32, SampleFormat.Float32 })
            {
                var chain = new PlaybackChain(plan.Rate, 2, fmt, false, _s.Dsp, gain, asio: true);
                AsioOut asio = null;
                try
                {
                    _ui(() =>
                    {
                        asio = new AsioOut(plan.AsioDriver);
                        asio.Init(chain);
                    });
                    asio.PlaybackStopped += OnStopped;
                    _out = asio; _chain = chain; _plan = plan;
                    return;
                }
                catch (Exception ex)
                {
                    last = ex;
                    try { _ui(() => asio?.Dispose()); } catch { }
                }
            }
            throw new InvalidOperationException("ASIO 初始化失敗：" + last?.Message);
        }

        EnsureDevice();
        var mode = plan.Mode == "shared" ? AudioClientShareMode.Shared : AudioClientShareMode.Exclusive;
        var c = new PlaybackChain(plan.Rate, plan.OutChannels, plan.Format, plan.Dop, _s.Dsp, gain);
        WasapiOut w = null;
        // Another stream (e.g. the YouTube page that was just paused) can keep the DAC for a moment after
        // it stops, so "device in use" is retried for a few seconds before it is reported.
        var sw = Stopwatch.StartNew();
        long budget = 4000;
        string holders = null;
        for (int attempt = 1; ; attempt++)
        {
            w = new WasapiOut(_device, mode, false, plan.BufferMs);
            try
            {
                w.Init(c);
                _reopenFailed = false;
                if (attempt > 1) Log.Info($"{(mode == AudioClientShareMode.Exclusive ? "Exclusive" : "Shared")} open succeeded after {attempt} attempts ({sw.ElapsedMilliseconds} ms)");
                break;
            }
            catch (Exception ex)
            {
                w.Dispose();
                bool busy = IsDeviceInUse(ex);
                if (busy && holders == null)
                {
                    holders = Holders(_device, out bool external);
                    // another application (Roon, a browser…) won't let go because MIKU paused YouTube:
                    // don't make the user wait, fall back quickly. Only MIKU's own streams get the long wait.
                    // (No external holder = it's MIKU's own previous stream that Windows is still releasing after
                    // a rate / mode change; that takes ~0.6–1 s, so it must get the full wait even right after a
                    // shared-mode fallback — otherwise every track change after Roon quits fails.)
                    if (external) budget = 400;
                    // nobody else on the device: almost always MIKU's own previous stream that Windows hasn't let go
                    // of yet. Give it longer, and force the release of any leftover COM wrappers.
                    else budget = mode == AudioClientShareMode.Exclusive ? 9000 : 3000;
                }
                if (busy && (attempt == 1 || attempt % 4 == 0)) ReleaseStaleAudio();
                // retried in shared mode too: right after MIKU's own exclusive stream closes, a shared open can
                // also report "device in use" for a moment
                if (busy && sw.ElapsedMilliseconds < budget)
                {
                    // Stop or another track was chosen meanwhile: give up now instead of holding the gate for seconds
                    if (Superseded) throw new OperationCanceledException();
                    Thread.Sleep(Math.Min(100 * attempt, 400));
                    continue;
                }
                string asio = null;
                if (busy) { LogSessions(_device); _reopenFailed = true; if (string.IsNullOrEmpty(holders)) { asio = AsioUsers(); Log.Info("Processes using an ASIO / TUSBAudio driver: " + (asio.Length == 0 ? "none" : asio)); } }
                Devices.Invalidate(_deviceId);
                if (busy)
                {
                    string who = !string.IsNullOrEmpty(holders) ? holders : !string.IsNullOrEmpty(asio) ? asio + "（ASIO）" : "Windows 尚未釋放的串流";
                    string hint = who.Contains("Roon")
                        ? "請在 Roon 的「設定 > 音訊」把這個 DAC 停用（或結束 Roon / RAATServer），或把 Roon 這個裝置的「獨佔模式」關掉。"
                        : who.StartsWith("Windows") ? "通常幾秒後就會恢復，請稍等一下再按播放；如果一直發生，請到「設定 → 音訊輸出」暫時改用共享模式，並把記錄檔傳給開發者。"
                        : "請先停止該程式的播放再試一次。";
                    throw new DeviceBusyException(who,
                        $"「{DeviceName}」正被 {who} 使用，MIKU 無法開啟（{plan.Rate / 1000.0:0.#} kHz）。{hint}");
                }
                throw new InvalidOperationException(mode == AudioClientShareMode.Exclusive
                    ? $"無法以獨佔模式開啟「{DeviceName}」（{plan.Rate / 1000.0:0.#} kHz / {Formats.Describe(plan.Format)}）。\n{ex.Message}"
                    : $"無法開啟「{DeviceName}」：{ex.Message}");
            }
        }
        var actual = w.OutputWaveFormat;
        if (actual.SampleRate != plan.Rate || actual.Channels != plan.OutChannels)
        {
            w.Dispose();
            throw new InvalidOperationException("音效驅動程式更改了輸出格式，為避免非預期的重新取樣已停止輸出。");
        }
        w.PlaybackStopped += OnStopped;
        _out = w; _chain = c; _plan = plan;
        if (plan.Dop) EnterDopVolume(); else LeaveDopVolume();
    }

    /// <summary>Other processes that have audio sessions on the device (excluding MIKU and system sounds).</summary>
    static string Holders(MMDevice device, out bool external)
    {
        external = false;
        var names = new List<string>();
        var active = new List<string>();
        try
        {
            var mgr = device.AudioSessionManager;
            mgr.RefreshSessions();
            var s = mgr.Sessions;
            int self = Environment.ProcessId;
            for (int i = 0; i < s.Count; i++)
            {
                var c = s[i];
                if (c.State == NAudio.CoreAudioApi.Interfaces.AudioSessionState.AudioSessionStateExpired) continue;
                uint pid = c.GetProcessID;
                if (pid == 0 || pid == self) continue;
                string name;
                try { name = Process.GetProcessById((int)pid).ProcessName; } catch { continue; }
                string lower = name.ToLowerInvariant();
                if (lower.StartsWith("msedgewebview2")) { names.Add("YouTube 頁面"); continue; }
                if (lower.Contains("raat") || lower.Contains("roon")) name = "Roon（" + name + "）";
                // An *inactive* session (e.g. an idle RAATServer) is only registered on the device, it doesn't hold it.
                // Counting it as a holder cut the wait to 400 ms, so MIKU gave up before its own previous stream
                // (YouTube ↔ album switch, 48 ↔ 44.1 kHz) was released and the load failed.
                if (c.State == NAudio.CoreAudioApi.Interfaces.AudioSessionState.AudioSessionStateActive) { external = true; active.Add(name); }
                names.Add(name);
            }
        }
        catch (Exception ex) { Log.Error("Holders", ex); }
        return string.Join("、", (active.Count > 0 ? active : names).Distinct());
    }

    /// <summary>Another program (not MIKU, not its YouTube page, not system sounds) has a session on the device.</summary>
    static bool OthersOnDevice(MMDevice device, out string names)
    {
        var list = new List<string>();
        try
        {
            var mgr = device.AudioSessionManager;
            mgr.RefreshSessions();
            var s = mgr.Sessions;
            int self = Environment.ProcessId;
            for (int i = 0; i < s.Count; i++)
            {
                var c = s[i];
                if (c.State == NAudio.CoreAudioApi.Interfaces.AudioSessionState.AudioSessionStateExpired) continue;
                uint pid = c.GetProcessID;
                if (pid == 0 || pid == self) continue;
                string name;
                try { name = Process.GetProcessById((int)pid).ProcessName; } catch { continue; }
                string lower = name.ToLowerInvariant();
                if (lower.StartsWith("msedgewebview2")) continue;
                list.Add(lower.Contains("raat") || lower.Contains("roon") ? "Roon" : name);
            }
        }
        catch (Exception ex) { Log.Error("OthersOnDevice", ex); }
        names = string.Join("、", list.Distinct());
        return list.Count > 0;
    }

    /// <summary>Runs the finalizers of discarded audio COM wrappers (on an MTA thread) so their streams are released now.</summary>
    static void ReleaseStaleAudio()
    {
        try
        {
            Task.Run(() =>
            {
                GC.Collect();
                GC.WaitForPendingFinalizers();
                GC.Collect();
            }).Wait(2000);
        }
        catch (Exception ex) { Log.Error("ReleaseStaleAudio", ex); }
    }

    /// <summary>Processes (other than MIKU) that have an ASIO / TUSBAudio driver loaded: they can hold the DAC without a WASAPI session.</summary>
    static string AsioUsers()
    {
        var names = new List<string>();
        int self = Environment.ProcessId;
        foreach (var p in Process.GetProcesses())
        {
            try
            {
                if (p.Id == self || p.Id <= 4) continue;
                foreach (ProcessModule m in p.Modules)
                {
                    string n = m.ModuleName.ToLowerInvariant();
                    if (n.Contains("asio") || n.Contains("tusbaudioapi") || n.Contains("tusbaudio_")) { names.Add(p.ProcessName); break; }
                }
            }
            catch { }
            finally { p.Dispose(); }
        }
        return string.Join("、", names.Distinct());
    }

    const int AUDCLNT_E_DEVICE_IN_USE = unchecked((int)0x8889000A);

    /// <summary>Diagnostics: which processes have audio sessions open on the device.</summary>
    static void LogSessions(MMDevice device)
    {
        try
        {
            var mgr = device.AudioSessionManager;
            mgr.RefreshSessions();
            var s = mgr.Sessions;
            var parts = new List<string>();
            for (int i = 0; i < s.Count; i++)
            {
                var c = s[i];
                uint pid = c.GetProcessID;
                string name = "?";
                try { name = pid == 0 ? "System" : Process.GetProcessById((int)pid).ProcessName; } catch { }
                parts.Add($"{name}({pid}):{c.State}");
            }
            string roon = "";
            try
            {
                roon = string.Join(", ", Process.GetProcesses()
                    .Where(p => { var n = p.ProcessName.ToLowerInvariant(); return n.Contains("roon") || n.Contains("raat"); })
                    .Select(p => p.ProcessName + "(" + p.Id + ")").Distinct());
            }
            catch { }
            Log.Info($"Device busy, sessions on {device.FriendlyName}: " + (parts.Count == 0 ? "none" : string.Join(", ", parts))
                     + $" | Roon processes running: {(roon.Length == 0 ? "none" : roon)}");
        }
        catch (Exception ex) { Log.Error("LogSessions", ex); }
    }

    static bool IsDeviceInUse(Exception ex)
    {
        for (var e = ex; e != null; e = e.InnerException)
            if (e.HResult == AUDCLNT_E_DEVICE_IN_USE || (e.Message?.Contains("8889000A", StringComparison.OrdinalIgnoreCase) ?? false))
                return true;
        return false;
    }

    void OnStopped(object sender, StoppedEventArgs e)
    {
        if (!ReferenceEquals(sender, _out)) return;
        if (e.Exception != null)
        {
            // Typically AUDCLNT_E_DEVICE_INVALIDATED: unplugged, disabled, its format changed, or another program took it.
            Log.Error("Output stopped", e.Exception);
            var ex = e.Exception;
            Task.Run(() => DeviceLostAsync(sender, ex)).ContinueWith(t => { if (t.IsFaulted) Log.Error("Output stopped", t.Exception); });
        }
    }

    /// <summary>Pause the stream while keeping the initialized output (and the exclusive-mode DAC) open.</summary>
    public void Pause()
    {
        var o = _out;
        if (o == null || _paused) return;
        var c = _chain;
        if (c != null)
        {
            // The DAC may have crossed a gapless boundary since the last 40 ms monitor tick.
            // Resume must reload the track that was actually audible when Pause was pressed.
            var (aud, _) = c.SegmentAt(PlayedFrames());
            FollowAudibleTrack(aud);
        }
        _pausedAt = Position;
        _paused = true;
        try
        {
            if (o is AsioOut) o.Pause();
            else
            {
                // NAudio 2.2.1's WasapiOut.Pause only stops feeding the render buffer: the audio client and
                // its clock keep running. Some exclusive-mode drivers replay that buffer instead of silence.
                // Stop also resets the clock and discards queued samples, but keeps the DAC initialized.
                o.Stop();
                _wasapiFrameBase = _chain?.FramesOut ?? 0;
                _wasapiStopped = true;
            }
        }
        catch (Exception ex) { Log.Error("Pause", ex); Failed?.Invoke(ex.Message); }
        Changed?.Invoke();
    }

    public void Resume()
    {
        var t = Track;
        if (_out == null || _wasapiStopped)
        {
            // WASAPI Stop flushed samples the decoder already consumed. Rebuild from the audible pause
            // position, reusing the initialized output when its plan still matches, so no music is skipped.
            // This also handles a track restored paused at startup (no output open yet).
            if (t != null) _ = LoadAsync(t, t.IsLive ? 0 : (_pausedAt ?? 0), true);
            return;
        }
        try { _out.Play(); _pausedAt = null; _paused = false; }
        catch (Exception ex) { Log.Error("Resume", ex); Failed?.Invoke(ex.Message); }
        Changed?.Invoke();
    }

    public async Task SeekAsync(double pos)
    {
        var t = Track;
        if (t == null || t.IsLive) return;
        if (_paused) _pausedAt = Math.Clamp(pos, 0, Math.Max(0, t.Duration - 0.5));
        if (!IsLoaded) { await LoadAsync(t, pos, false); return; }
        await _gate.WaitAsync();
        try
        {
            _activeVersion = Volatile.Read(ref _loadVersion);
            await Task.Run(() =>
            {
                var (plan, sp) = BuildPlan(t);
                if (plan != _plan) { LoadCore(t, pos, !_paused); return; }
                var src = CreateSource(t, Math.Clamp(pos, 0, Math.Max(0, t.Duration - 0.25)), sp, plan);
                src.WaitPrefill(0.12, 2000);
                _preloadTriedFor = null;
                foreach (var d in _chain.SetSource(src, fromSeek: true)) d.Dispose();
            });
        }
        catch (Exception ex) { Failed?.Invoke(ex.Message); }
        finally { _gate.Release(); Changed?.Invoke(); }
    }

    public void Stop()
    {
        // A load still waiting for a busy DAC gives up at its next retry.
        Interlocked.Increment(ref _loadVersion);
        if (!_gate.Wait(3000))
        {
            // Stop is called on the UI thread: don't freeze the window behind a device that is slow to open or close.
            Log.Info("Stop: output busy, finishing in the background");
            Track = null; Signal = null; _pausedAt = null;
            Task.Run(async () =>
            {
                await _gate.WaitAsync();
                try { TearDown(); Track = null; Signal = null; _pausedAt = null; }
                catch (Exception ex) { Log.Error("Stop", ex); }
                finally { _gate.Release(); }
                Changed?.Invoke();
            });
            Changed?.Invoke();
            return;
        }
        try { TearDown(); Track = null; Signal = null; _pausedAt = null; }
        finally { _gate.Release(); }
        Changed?.Invoke();
    }

    /// <summary>Output settings changed: reopen the device at the current position.</summary>
    public async Task ReconfigureAsync()
    {
        var t = Track; double pos = Position; bool play = IsPlaying;
        await _gate.WaitAsync();
        try { TearDown(); ReleaseDevice(); }
        finally { _gate.Release(); }
        if (t != null) await LoadAsync(t, pos, play);
    }

    public void InvalidateNext()
    {
        _preloadTriedFor = null;
        _chain?.ClearNext();
    }

    void TearDown()
    {
        var o = _out; var c = _chain;
        _out = null; _chain = null; _plan = null; _lastAudible = null;
        _wasapiStopped = false; _wasapiFrameBase = 0;
        if (o != null)
        {
            o.PlaybackStopped -= OnStopped;
            try
            {
                if (o is AsioOut) _ui(() => { try { o.Stop(); } catch { } o.Dispose(); });
                else { try { o.Stop(); } catch { } o.Dispose(); }
            }
            catch (Exception ex) { Log.Error("TearDown", ex); }
            // make sure no COM wrapper of the closed stream keeps the DAC locked until some later garbage collection
            if (o is WasapiOut) ReleaseStaleAudio();
        }
        c?.DisposeSources();
        LeaveDopVolume();
    }

    // ───────────────────────────── volume & dsp ─────────────────────────────

    double DigitalGain()
    {
        if (_s.VolumeMode != "digital") return _s.Muted && _s.VolumeMode == "fixed" ? 0 : 1;
        if (_s.Muted) return 0;
        return Math.Pow(10, Math.Clamp(_s.VolumeDb, -100, 0) / 20);
    }

    public void ApplyVolume()
    {
        var c = _chain;
        if (c != null) c.Dsp.SetGain(c.Dop ? 1 : DigitalGain());
        bool hw = _s.VolumeMode == "hardware" || (c != null && c.Dop && _s.VolumeMode == "digital");
        if (hw && _plan?.Mode != "asio")
        {
            lock (_deviceLock)
            {
                if (_device == null) return;
                try
                {
                    var v = _device.AudioEndpointVolume;
                    if (c != null && c.Dop && _hwRestoreDb == null) _hwRestoreDb = v.MasterVolumeLevel;
                    v.MasterVolumeLevel = (float)Math.Clamp(_s.VolumeDb, v.VolumeRange.MinDecibels, v.VolumeRange.MaxDecibels);
                    v.Mute = _s.Muted;
                }
                catch (Exception ex) { Log.Error("HW volume", ex); }
            }
        }
    }

    void EnterDopVolume() { /* applied by ApplyVolume after the source is attached */ }

    void LeaveDopVolume()
    {
        if (_hwRestoreDb == null) return;
        lock (_deviceLock)
        {
            if (_device == null) { _hwRestoreDb = null; return; }
            try
            {
                var v = _device.AudioEndpointVolume;
                v.MasterVolumeLevel = (float)_hwRestoreDb.Value;
                v.Mute = false;
            }
            catch { }
        }
        _hwRestoreDb = null;
    }

    public void ApplyDsp()
    {
        _chain?.Dsp.SetConfig(_s.Dsp);
        if (Signal != null && Track != null && _chain != null)
        {
            Signal.DspActive = _s.Dsp.Enabled && !_chain.Dop;
            Signal.DspSummary = DspSummary();
            Signal.Quality = Quality(Signal);
        }
        Changed?.Invoke();
    }

    string DspSummary()
    {
        var d = _s.Dsp;
        if (!d.Enabled) return null;
        var parts = new List<string>();
        int n = d.EqOn ? d.Bands.Count(b => b.On && !Biquad.IsIdentity(b)) : 0;
        if (n > 0) parts.Add(string.IsNullOrEmpty(d.PresetName) ? $"參數 EQ · {n} 段" : $"EQ · {d.PresetName}");
        if (d.Crossfeed.On) parts.Add("Crossfeed");
        if (Math.Abs(d.Balance) > 0.001) parts.Add("平衡");
        if (d.Invert) parts.Add("反相");
        return parts.Count == 0 ? null : string.Join(" · ", parts);
    }

    // ───────────────────────────── status ─────────────────────────────

    long PlayedFrames()
    {
        var c = _chain; var o = _out;
        if (c == null || o == null) return 0;
        try
        {
            if (o is IWavePosition w) return _wasapiFrameBase + w.GetPosition() / c.WaveFormat.BlockAlign;
            if (o is AsioOut a) return Math.Max(0, c.FramesOut - a.FramesPerBuffer * 2L);
        }
        catch { }
        return c.FramesOut;
    }

    public double Position
    {
        get
        {
            if (_paused && _pausedAt.HasValue) return _pausedAt.Value;
            var c = _chain;
            if (c == null) return _pausedAt ?? _s.ResumePosition;
            long played = PlayedFrames();
            var (aud, latest) = c.SegmentAt(played);
            if (latest != null && latest.FromSeek && latest.StartFrame > played && latest.Track != null) return latest.Offset;
            if (aud == null || aud.Track == null) return aud == null ? 0 : (Track?.Duration ?? 0);
            return aud.Offset + Math.Max(0, played - aud.StartFrame) / (double)c.Rate;
        }
    }

    public (double l, double r, long clips, long underruns) Meter()
    {
        var c = _chain;
        return c == null ? (0, 0, 0, 0) : (c.Dsp.PeakL, c.Dsp.PeakR, c.Dsp.Clips + c.QuantizationClips, c.Underruns);
    }

    public bool ResamplingMeterAvailable => _chain?.Current?.ResamplingMeterAvailable == true;

    public (long overloads, double peak) ResamplingMeter()
    {
        var src = _chain?.Current;
        return src == null || !src.ResamplingMeterAvailable ? (0, 0) : (src.OverloadSamples, src.ResamplerPeak);
    }

    bool _endedRaised;
    void FollowAudibleTrack(Segment aud)
    {
        if (aud?.Track == null || aud.FromSeek || ReferenceEquals(aud.Track, Track)) return;
        Track = aud.Track;
        if (Signal != null) Signal = BuildSignal(aud.Track, null, _plan);
        TrackStarted?.Invoke(aud.Track);
    }

    void Monitor()
    {
        var c = _chain;
        if (c == null || _paused) return;
        try
        {
            long played = PlayedFrames();
            var (aud, _) = c.SegmentAt(played);
            if (aud != null && !ReferenceEquals(aud, _lastAudible))
            {
                _lastAudible = aud;
                if (aud.Track == null)
                {
                    if (!_endedRaised) { _endedRaised = true; Ended?.Invoke(); }
                }
                else
                {
                    _endedRaised = false;
                    FollowAudibleTrack(aud);
                }
            }
            // gapless pre-loading once the current decoder has finished reading its file
            var cur = c.Current;
            if (_s.Gapless && !_sharedFallback && cur != null && cur.ProducerFinished && c.Next == null && !ReferenceEquals(_preloadTriedFor, cur))
            {
                _preloadTriedFor = cur;
                var next = PeekNext?.Invoke();
                if (next != null) Task.Run(() => Preload(c, cur, next));
            }
        }
        catch (Exception ex) { Log.Error("Monitor", ex); }
    }

    void Preload(PlaybackChain c, PcmSource cur, Track next)
    {
        try
        {
            // runs outside the gate: never switch devices here (a device change reopens through the gate)
            if (!DeviceStillRight()) return;
            var (plan, sp) = BuildPlan(next);
            if (plan != _plan || !ReferenceEquals(c, _chain)) return;
            var src = CreateSource(next, 0, sp, plan);
            src.WaitPrefill(0.5, 3000);
            if (ReferenceEquals(c.Current, cur) && ReferenceEquals(c, _chain)) c.SetNext(src);
            else src.Dispose();
        }
        catch (Exception ex) { Log.Error("Preload", ex); }
    }

    // ───────────────────────────── signal path ─────────────────────────────

    SignalInfo BuildSignal(Track t, SourcePlan sp, OutputPlan plan)
    {
        if (plan == null) return null;
        var dsd = sp?.Dsd;
        bool isDsd = t.IsDsd;
        int srcRate = isDsd ? (dsd?.Rate ?? t.SampleRate) : t.SampleRate;
        var info = new SignalInfo
        {
            Codec = t.Codec,
            SourceRate = srcRate,
            SourceBits = isDsd ? 1 : t.Bits,
            Dsd = isDsd,
            DsdLabel = isDsd && srcRate > 0 ? "DSD" + (srcRate / 44100) : null,
            Lossy = t.IsLossy,
            Dop = plan.Dop,
            Resampled = isDsd ? !plan.Dop : plan.Rate != (t.IsLive ? LiveBus.Rate : srcRate),
            OutputRate = plan.Rate,
            OutputFormat = Formats.Describe(plan.Format),
            OutputBits = Formats.ValidBits(plan.Format),
            Mode = plan.Mode switch { "asio" => "ASIO", "shared" => "WASAPI 共享", _ => "WASAPI 獨佔" },
            Device = plan.Mode == "asio" ? plan.AsioDriver : (_caps?.Name ?? ""),
            DspActive = _s.Dsp.Enabled && !plan.Dop,
            DspSummary = plan.Dop ? null : DspSummary(),
            Decoder = plan.Dop ? "MIKU 既有 DoP 封裝" : t.IsLive ? "WebView 音訊" : "FFmpeg",
            Resampler = "FFmpeg / SoX",
            ResamplerGainDb = t.IsLive || plan.Dop ? null : -1,
            Quantization = "既有量化規則",
            EventDriven = false,
            SourceChannels = t.Channels,
            OutputFloatingPoint = plan.Format == SampleFormat.Float32,
            VolumeMode = plan.Dop && _s.VolumeMode == "digital" ? (_caps != null && _caps.HardwareVolume ? "hardware" : "none") : _s.VolumeMode,
        };
        if (_s.ReplayGain != "off" && !plan.Dop)
        {
            double? rg = _s.ReplayGain == "album" ? (t.RgAlbum ?? t.RgTrack) : (t.RgTrack ?? t.RgAlbum);
            if (rg.HasValue) info.ReplayGainDb = rg.Value + _s.ReplayGainPreamp;
        }
        if (plan.Dop && _s.VolumeMode == "digital" && (_caps == null || !_caps.HardwareVolume))
            info.Note = "DoP 播放時無法使用數位音量，DAC 會以原始音量輸出，請用 DAC 的音量旋鈕調整。";
        if (info.Note == null && sp?.Note != null) info.Note = sp.Note;
        info.Quality = Quality(info);
        return info;
    }

    string Quality(SignalInfo i)
    {
        if (i.Lossy) return "low";
        if (i.Mode == "WASAPI 共享") return "high";
        bool volumeTouches = i.VolumeMode == "digital" && !i.Dop && Math.Abs(_s.VolumeDb) > 1e-9;
        if (i.DspActive || i.ReplayGainDb.HasValue) return "enhanced";
        if (i.Resampled) return "enhanced";
        if (volumeTouches) return "enhanced";
        if (_s.Muted && !i.Dop) return "enhanced";
        int precision = i.OutputFloatingPoint ? 24 : i.OutputBits;
        if (!i.Dop && (i.SourceBits > precision || i.SourceChannels != 2)) return "enhanced";
        return "bitperfect";
    }

    public void RefreshSignal()
    {
        if (Signal != null) Signal.Quality = Quality(Signal);
    }

    public void Dispose()
    {
        _disposed = true;
        try { _watcher?.Dispose(); } catch { }
        _monitor.Dispose();
        TearDown();
        ReleaseDevice();
    }
}

public sealed class DeviceBusyException : InvalidOperationException
{
    public string Holders { get; }
    public DeviceBusyException(string holders, string message) : base(message) { Holders = holders; HResult = unchecked((int)0x8889000A); }
}
