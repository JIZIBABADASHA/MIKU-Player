using System;
using System.Collections.Generic;
using System.Threading.Tasks;

namespace Miku.Audio;

/// <summary>
/// The playback core used by Player / MainForm: <see cref="AudioEngine"/> (MIKU's own core, "miku"), or one an extension
/// module provides (<see cref="IAudioCoreProvider"/>). Settings.AudioCore picks one by id.
/// </summary>
public interface IAudioEngine : IDisposable
{
    Func<Track> PeekNext { get; set; }
    /// <summary>Asks other audio inside MIKU (the YouTube Music page) to let go of the DAC before a local track opens it.</summary>
    Func<Task> ReleaseOthers { get; set; }

    event Action<Track> TrackStarted;   // gapless transition
    event Action Ended;
    event Action<string> Failed;
    event Action Changed;
    /// <summary>A track is about to be loaded (used to pause YouTube before a local track takes the DAC).</summary>
    event Action<Track> Loading;

    SignalInfo Signal { get; }
    /// <summary>The last load failed because the output device could not be opened (not because the file is bad).</summary>
    bool LastFailureWasDevice { get; }
    Track Track { get; }
    bool IsPlaying { get; }
    bool IsLoaded { get; }
    DeviceCaps Caps { get; }
    double Position { get; }

    Task LoadAsync(Track t, double seek, bool play);
    void Pause();
    void Resume();
    Task SeekAsync(double pos);
    void Stop();
    /// <summary>Output settings changed: reopen the device at the current position.</summary>
    Task ReconfigureAsync();
    void InvalidateNext();
    void ApplyVolume();
    void ApplyDsp();
    (double l, double r, long clips, long underruns) Meter();
    /// <summary>Pre-quantization SRC peak data, when the core exposes it.</summary>
    (long overloads, double peak) ResamplingMeter() => (0, 0);
    bool ResamplingMeterAvailable => false;
    void RefreshSignal();
    /// <summary>Seconds between a YouTube Music sample entering the core and being heard; null: MIKU's own estimate.</summary>
    double? LiveLatency => null;
    /// <summary>PCM rates the ASIO driver accepts, when the core has it open and knows (null: not known / not open).</summary>
    List<int> AsioRates(string driver) => null;
}
