using System;
using System.Collections.Generic;
using System.Linq;
using System.Threading;
using System.Threading.Tasks;
using NAudio.CoreAudioApi;
using Rplay.Core;
using Rplay.Core.Decoding;
using Rplay.Core.Playback;
using Rplay.Endpoint;
using Rplay.Protocol;

namespace Miku.Audio;

/// <summary>
/// The Rplay playback core (RAAT architecture, see B:\Vibe_Coding\player\notes\14–18).
///
/// Core (decoding, gapless, resampling, DSD→PCM) → RAAT over 127.0.0.1 → endpoint (WASAPI / ASIO) running inside MIKU.
/// Nothing listens on the network and no discovery is used.
///
/// MIKU features on this core:
///   • output mode / device / ASIO driver / buffer → endpoint output plugin
///   • DoP → WASAPI dsd_mode=dop; ASIO uses native DSD when the driver supports it (Roon's default), DoP when the switch is on
///   • upsampling (off / 2x / max / fixed) → Core sample rate conversion
///   • digital volume, EQ, crossfeed, balance, invert, level meter → MIKU's DspProcessor, run on the endpoint just before the
///     device (like Roon's [volume/software]) so changes are heard immediately; bit-perfect while it is transparent
///   • hardware volume → the WASAPI endpoint volume (also used for DSD like the MIKU core)
///   • ReplayGain → Core gain stage, decided per stream from the stream's first track
///   • YouTube live audio is not a file: it is played by the MIKU core, which takes the DAC while it plays
/// </summary>
public sealed class RplayEngine : IAudioEngine
{
    readonly Settings _s;
    readonly AudioEngine _live;          // MIKU's own core, only for YouTube live tracks
    readonly SemaphoreSlim _gate = new(1, 1);
    readonly object _stackLock = new();

    AudioOutput _output;
    EndpointServer _srv;
    RaatAudioEngine<Track> _rp;
    MikuProcessor _proc;
    string _deviceId;
    MMDevice _hwDevice;
    double? _hwRestoreDb;
    bool _liveActive;
    SignalInfo _signal;
    double? _rgDb;
    DeviceCaps _caps;

    public Func<Track> PeekNext { get; set; }
    public Func<Task> ReleaseOthers { get; set; }
    /// <summary>Testing only: use this output instead of the one in the settings (e.g. Rplay's NullOutput).</summary>
    public static Func<AudioOutput> OutputOverride;
    public event Action<Track> TrackStarted;
    public event Action Ended;
    public event Action<string> Failed;
    public event Action Changed;
    public event Action<Track> Loading;

    public RplayEngine(Settings settings, Action<Action> uiInvoke)
    {
        _s = settings;
        _live = new AudioEngine(settings, uiInvoke);
        _live.PeekNext = () => null;
        _live.TrackStarted += t => { if (_liveActive) TrackStarted?.Invoke(t); };
        _live.Ended += () => { if (_liveActive) Ended?.Invoke(); };
        _live.Failed += m => { if (_liveActive) Failed?.Invoke(m); };
        _live.Changed += () => { if (_liveActive) Changed?.Invoke(); };
        FfmpegDecoder.FfmpegPath = Ffmpeg.Path;
    }

    // ───────────────────────────── state ─────────────────────────────

    public SignalInfo Signal => _liveActive ? _live.Signal : _signal;
    public bool LastFailureWasDevice { get; private set; }
    Track _track;
    public Track Track => _liveActive ? _live.Track : _rp?.Track ?? _track;
    public bool IsPlaying => _liveActive ? _live.IsPlaying : _rp?.IsPlaying ?? false;
    public bool IsLoaded => _liveActive ? _live.IsLoaded : _rp?.IsLoaded ?? false;
    public DeviceCaps Caps => _liveActive ? _live.Caps : _caps;
    double _pausedAt;
    public double Position => _liveActive ? _live.Position : _rp != null && _rp.Track != null ? _rp.Position : _pausedAt;

    // ───────────────────────────── the Rplay stack ─────────────────────────────

    void EnsureStack()
    {
        lock (_stackLock)
        {
            if (_rp != null) return;
            RoonCompat.Profile = RoonCompat.Parse(string.IsNullOrEmpty(_s.RplayProfile) ? "roon_fix" : _s.RplayProfile);
            int maxDsd = (_s.RplayMaxDsd > 0 ? _s.RplayMaxDsd : 512) * 44100;
            AudioOutput output;
            if (OutputOverride != null)
            {
                output = OutputOverride();
                _deviceId = null;
                _caps = null;
            }
            else if (_s.OutputMode == "asio")
            {
                string driver = _s.AsioDriver ?? Devices.AsioDrivers().FirstOrDefault() ?? throw new InvalidOperationException("找不到 ASIO 驅動程式");
                // DoP 開關打開 → DoP；關閉 → Roon 的預設（驅動程式支援原生 DSD 就用原生，否則轉 PCM）
                output = new AsioOutput(driver, _s.Dop ? DsdMode.Dop : null, maxDsd);
                _deviceId = null;
                _caps = null;
            }
            else
            {
                // MIKU: 沒有選裝置 = Windows 預設裝置（Rplay / Roon 對「預設裝置」會強制共享，所以這裡換成實際的裝置 ID）
                using (var d = Devices.Open(_s.DeviceId)) { _deviceId = d.ID; try { _caps = Devices.Probe(d); } catch { _caps = null; } }
                bool exclusive = _s.OutputMode != "shared";
                output = new WasapiOutput(_deviceId, exclusive, exclusive && _s.Dop ? DsdMode.Dop : DsdMode.None, maxDsd)
                {
                    BufferDuration = Math.Clamp(_s.BufferMs, 30, 1000) / 1000.0,
                };
            }
            _proc = new MikuProcessor(_s);
            _proc.SetGain(DigitalGain());
            output.Processor = _proc;
            output.Lost += reason => Log.Info("[rplay] output lost: " + reason);
            var srv = new EndpointServer(output, "127.0.0.1", 0);
            srv.Start();
            var rp = new RaatAudioEngine<Track>(t => t.Path, () => ZonePlayer.ConnectAsync("127.0.0.1", srv.ControlPort));
            rp.PeekNext = () => { var n = PeekNext?.Invoke(); return n == null || n.IsLive ? null : n; };
            rp.ConfigureDsp = ConfigureStream;
            rp.TrackStarted += t => { _signal = BuildSignal(t); TrackStarted?.Invoke(t); };
            rp.Ended += () => Ended?.Invoke();
            rp.Failed += m => { Log.Info("[rplay] " + m); Failed?.Invoke(m); };
            rp.Changed += () => Changed?.Invoke();
            rp.Info += m => Log.Info("[rplay] " + m);
            _output = output; _srv = srv; _rp = rp;
            Log.Info($"[rplay] core ready: {output.Name}, {RoonCompat.Describe()}");
        }
    }

    void TearDownStack()
    {
        lock (_stackLock)
        {
            try { _rp?.Dispose(); } catch (Exception ex) { Log.Error("rplay dispose", ex); }
            try { _srv?.Dispose(); } catch { }
            try { _output?.Dispose(); } catch { }
            _rp = null; _srv = null; _output = null; _proc = null;
            RestoreHardwareVolume();
            _hwDevice?.Dispose(); _hwDevice = null;
        }
    }

    /// <summary>每條串流開始前（第一首的設定）：升頻、ReplayGain。DSD 直送時不做任何 PCM 處理（和 MIKU 的 DoP 一樣）。</summary>
    void ConfigureStream(Track t, DspSettings d)
    {
        d.Upsampling = _s.Upsampling switch
        {
            "2x" => "2x",
            "max" => "max_family",
            "fixed" => "fixed:" + _s.FixedRate,
            _ => "none",
        };
        d.HeadroomDb = 0;
        _rgDb = null;
        if (t.IsDsd) { d.Upsampling = "none"; return; }
        if (_s.ReplayGain != "off")
        {
            double? rg = _s.ReplayGain == "album" ? (t.RgAlbum ?? t.RgTrack) : (t.RgTrack ?? t.RgAlbum);
            if (rg.HasValue) { _rgDb = rg.Value + _s.ReplayGainPreamp; d.HeadroomDb = _rgDb.Value; }
        }
    }

    // ───────────────────────────── transport ─────────────────────────────

    public async Task LoadAsync(Track t, double seek, bool play)
    {
        LastFailureWasDevice = false;
        if (t == null) return;
        if (t.IsLive)
        {
            // YouTube live：交給 MIKU 原本的內核，先放開 DAC
            await _gate.WaitAsync();
            try { _rp?.Stop(); TearDownStack(); _liveActive = true; }
            finally { _gate.Release(); }
            await _live.LoadAsync(t, seek, play);
            LastFailureWasDevice = _live.LastFailureWasDevice;
            return;
        }
        Loading?.Invoke(t);
        if (_liveActive) { _live.Stop(); _liveActive = false; }
        if (play && ReleaseOthers != null)
        {
            try { await Task.WhenAny(ReleaseOthers(), Task.Delay(1500)); } catch (Exception ex) { Log.Error("ReleaseOthers", ex); }
        }
        await _gate.WaitAsync();
        try
        {
            try { await Task.Run(EnsureStack); }
            catch (Exception ex)
            {
                Log.Error("rplay output", ex);
                LastFailureWasDevice = true;
                _track = t; _signal = null;
                TearDownStack();
                Failed?.Invoke("Rplay 內核無法開啟輸出裝置：" + ex.Message);
                return;
            }
            _track = t;
            _pausedAt = seek;
            await _rp.LoadAsync(t, seek, play);
            LastFailureWasDevice = _rp.LastFailureWasDevice;
            _signal = _rp.IsLoaded ? BuildSignal(t) : null;
            ApplyHardwareVolume();
        }
        finally { _gate.Release(); Changed?.Invoke(); }
    }

    public void Pause()
    {
        if (_liveActive) { _live.Pause(); return; }
        _rp?.Pause();
        Changed?.Invoke();
    }

    public void Resume()
    {
        if (_liveActive) { _live.Resume(); return; }
        if (_rp != null && _rp.Track != null) { _rp.Resume(); Changed?.Invoke(); return; }
        var t = _track;
        if (t != null) _ = LoadAsync(t, _pausedAt, true);
    }

    public Task SeekAsync(double pos)
    {
        if (_liveActive) return _live.SeekAsync(pos);
        if (_rp == null || _rp.Track == null) { _pausedAt = pos; return Task.CompletedTask; }
        return _rp.SeekAsync(pos).ContinueWith(_ => { _signal = _rp?.IsLoaded == true ? BuildSignal(_rp.Track) : _signal; Changed?.Invoke(); });
    }

    public void Stop()
    {
        if (_liveActive) { _live.Stop(); _liveActive = false; }
        _rp?.Stop();
        _track = null; _signal = null; _pausedAt = 0;
        RestoreHardwareVolume();
        Changed?.Invoke();
    }

    public async Task ReconfigureAsync()
    {
        if (_liveActive) { await _live.ReconfigureAsync(); return; }
        var t = Track; double pos = Position; bool play = IsPlaying;
        await _gate.WaitAsync();
        try { _rp?.Stop(); TearDownStack(); }
        finally { _gate.Release(); }
        if (t != null) await LoadAsync(t, pos, play);
    }

    public void InvalidateNext()
    {
        _rp?.InvalidateNext();
        _live.InvalidateNext();
    }

    // ───────────────────────────── volume & dsp ─────────────────────────────

    double DigitalGain()
    {
        if (_s.VolumeMode != "digital") return _s.Muted && _s.VolumeMode == "fixed" ? 0 : 1;
        if (_s.Muted) return 0;
        return Math.Pow(10, Math.Clamp(_s.VolumeDb, -100, 0) / 20);
    }

    bool DsdDirect => _rp?.Chain?.WireFormat.IsDsd == true;

    public void ApplyVolume()
    {
        if (_liveActive) { _live.ApplyVolume(); return; }
        _proc?.SetGain(DigitalGain());
        ApplyHardwareVolume();
        if (_signal != null && _rp?.Track != null) _signal = BuildSignal(_rp.Track);
    }

    /// <summary>硬體音量：硬體模式，或 DSD 直送時的數位模式（DSD 不能做數位音量，和 MIKU 的 DoP 一樣改用 DAC 的音量）。</summary>
    void ApplyHardwareVolume()
    {
        bool dsd = DsdDirect;
        bool hw = _s.VolumeMode == "hardware" || (dsd && _s.VolumeMode == "digital");
        if (!hw || _deviceId == null) { if (!dsd) RestoreHardwareVolume(); return; }
        try
        {
            _hwDevice ??= Devices.Open(_deviceId);
            var v = _hwDevice.AudioEndpointVolume;
            if (dsd && _s.VolumeMode == "digital" && _hwRestoreDb == null) _hwRestoreDb = v.MasterVolumeLevel;
            v.MasterVolumeLevel = (float)Math.Clamp(_s.VolumeDb, v.VolumeRange.MinDecibels, v.VolumeRange.MaxDecibels);
            v.Mute = _s.Muted;
        }
        catch (Exception ex) { Log.Error("rplay HW volume", ex); }
    }

    void RestoreHardwareVolume()
    {
        if (_hwRestoreDb == null || _hwDevice == null) return;
        try { var v = _hwDevice.AudioEndpointVolume; v.MasterVolumeLevel = (float)_hwRestoreDb.Value; v.Mute = false; } catch { }
        _hwRestoreDb = null;
    }

    public void ApplyDsp()
    {
        if (_liveActive) { _live.ApplyDsp(); return; }
        _proc?.SetConfig(_s.Dsp);
        if (_signal != null && _rp?.Track != null) _signal = BuildSignal(_rp.Track);
        Changed?.Invoke();
    }

    public (double l, double r, long clips, long underruns) Meter()
    {
        if (_liveActive) return _live.Meter();
        var p = _proc;
        if (p == null || !IsLoaded) return (0, 0, 0, 0);
        return (p.PeakL, p.PeakR, p.Clips, 0);
    }

    // ───────────────────────────── signal path ─────────────────────────────

    SignalInfo BuildSignal(Track t)
    {
        var chain = _rp?.Chain; var src = _rp?.SourceFormat; var output = _output;
        if (t == null || chain == null || output == null) return null;
        var wire = chain.WireFormat;
        var dev = output.DeviceFormat ?? wire;
        bool dsdOut = wire.IsDsd;
        bool encapsulated = dsdOut && output.ActiveDsdMode is DsdMode.Dop or DsdMode.Dcs;
        bool isDsd = t.IsDsd;
        int srcRate = src?.SampleRate ?? t.SampleRate;
        string mode = _s.OutputMode switch { "asio" => "ASIO", "shared" => "WASAPI 共享", _ => "WASAPI 獨佔" };
        var info = new SignalInfo
        {
            Codec = t.Codec,
            SourceRate = srcRate,
            SourceBits = isDsd ? 1 : t.Bits,
            Dsd = isDsd,
            DsdLabel = isDsd && srcRate > 0 ? "DSD" + (srcRate / 44100) : null,
            Lossy = t.IsLossy,
            Dop = encapsulated,
            Resampled = isDsd ? !dsdOut : wire.SampleRate != srcRate,
            OutputRate = dev.SampleRate,
            OutputFormat = dsdOut && !encapsulated ? "DSD 原生" : output is WasapiOutput w && w.DeviceFormatText != null ? w.DeviceFormatText : $"{output.DeviceValidBits}-bit",
            OutputBits = dsdOut && !encapsulated ? 1 : output.DeviceValidBits,
            Mode = mode,
            Device = output.Name,
            DspActive = _s.Dsp.Enabled && !dsdOut,
            DspSummary = dsdOut ? null : DspSummary(),
            VolumeMode = dsdOut && _s.VolumeMode == "digital" ? (_caps != null && _caps.HardwareVolume ? "hardware" : "none") : _s.VolumeMode,
            ReplayGainDb = dsdOut ? null : _rgDb,
        };
        var notes = new List<string> { "Rplay 內核：" + chain.Description };
        if (dsdOut && _s.VolumeMode == "digital" && (_caps == null || !_caps.HardwareVolume))
            notes.Add("DSD 直送時無法使用數位音量，DAC 會以原始音量輸出，請用 DAC 的音量旋鈕調整。");
        info.Note = string.Join("\n", notes);
        info.Quality = Quality(info);
        return info;
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

    string Quality(SignalInfo i)
    {
        if (i.Lossy) return "low";
        if (i.Mode == "WASAPI 共享") return "high";
        bool volumeTouches = i.VolumeMode == "digital" && !i.Dop && i.OutputBits != 1 && Math.Abs(_s.VolumeDb) > 1e-9;
        if (i.DspActive || i.ReplayGainDb.HasValue) return "enhanced";
        if (i.Resampled) return "enhanced";
        if (volumeTouches) return "enhanced";
        return "bitperfect";
    }

    public void RefreshSignal()
    {
        if (_liveActive) { _live.RefreshSignal(); return; }
        if (_signal != null) _signal.Quality = Quality(_signal);
    }

    public void Dispose()
    {
        try { _rp?.Stop(); } catch { }
        TearDownStack();
        _live.Dispose();
    }

    /// <summary>MIKU 的 DspProcessor（音量、EQ、Crossfeed、平衡、反相、音量表），在 Rplay 輸出端處理即將送進裝置的樣本。</summary>
    sealed class MikuProcessor : IOutputProcessor
    {
        readonly Settings _s;
        DspProcessor _p;
        double _gain = 1;
        int _channels = 2;
        public MikuProcessor(Settings s) { _s = s; }

        public double PeakL => _p?.PeakL ?? 0;
        public double PeakR => _p?.PeakR ?? 0;
        public long Clips => _p?.Clips ?? 0;

        public void Start(int sampleRate, int channels)
        {
            _channels = channels;
            _p = new DspProcessor(sampleRate, _s.Dsp, _gain);
        }

        public bool Transparent => _p == null || _channels != 2 || _p.Bypassed;

        public void Process(double[] buf, int frames)
        {
            if (_channels == 2) _p?.Process(buf, frames);
        }

        public void SetGain(double g) { _gain = g; _p?.SetGain(g); }
        public void SetConfig(DspConfig cfg) => _p?.SetConfig(cfg);
    }
}
