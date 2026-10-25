using System;
using System.Collections.Generic;
using System.Text.Json;
using System.Text.Json.Serialization;

namespace Miku;

public sealed class Track
{
    public string Id { get; set; }
    public string Path { get; set; }
    public string Title { get; set; } = "";
    public string Artist { get; set; } = "";
    public string AlbumArtist { get; set; } = "";
    public string Album { get; set; } = "";
    public string Genre { get; set; } = "";
    public string Composer { get; set; } = "";
    public int Year { get; set; }
    public int TrackNo { get; set; }
    public int DiscNo { get; set; }
    public double Duration { get; set; }
    public int SampleRate { get; set; }
    public int Bits { get; set; }
    public int Channels { get; set; } = 2;
    public int Bitrate { get; set; }
    public string Codec { get; set; } = "";
    public long Size { get; set; }
    public long Mtime { get; set; }
    /// <summary>UTC ticks when this track first entered the library; preserved when its tags or path change.</summary>
    public long Added { get; set; }
    public bool HasPic { get; set; }
    public double? RgTrack { get; set; }
    public double? RgAlbum { get; set; }
    /// <summary>ReplayGain peaks (linear, 1.0 = full scale), so a core can raise a quiet track only as far as its peak allows.</summary>
    public double? RgTrackPeak { get; set; }
    public double? RgAlbumPeak { get; set; }
    /// <summary>Version of the tag reading rules this was read with (<see cref="Library.TagReader.Version"/>); 0 = before versions.</summary>
    public int ReadVer { get; set; }
    [JsonIgnore] public string AlbumId { get; set; }

    [JsonIgnore] public bool IsDsd => Codec == "DSF" || Codec == "DFF";
    [JsonIgnore] public bool IsLossy => Codec is "MP3" or "AAC" or "OGG" or "OPUS" or "WMA" or "YouTube";
    [JsonIgnore] public bool IsLive => Codec == "YouTube";
    [JsonIgnore] public string Ext => System.IO.Path.GetExtension(Path).ToLowerInvariant();
}

public sealed class Album
{
    public string Id { get; set; }
    public string Title { get; set; }
    public string Artist { get; set; }
    public int Year { get; set; }
    public string Genre { get; set; }
    public string Folder { get; set; }
    public string ArtPath { get; set; }
    public long Added { get; set; }
    public List<Track> Tracks { get; } = new();
    public bool Loose { get; set; }
    /// <summary>Albums that are versions of the same album (other folders, formats): same id; null when there is only this one.</summary>
    public string VersionGroup { get; set; }
}

public sealed class EqBand
{
    public bool On { get; set; } = true;
    public string Type { get; set; } = "PK"; // PK, LSC, HSC, LP, HP
    public double Fc { get; set; } = 1000;
    public double Gain { get; set; }
    public double Q { get; set; } = 0.707;
}

public sealed class CrossfeedConfig
{
    public bool On { get; set; }
    public double Fc { get; set; } = 700;
    public double Feed { get; set; } = 4.5;
}

public sealed class DspConfig
{
    public bool Enabled { get; set; }
    public bool EqOn { get; set; } = true;
    public double PreampDb { get; set; }
    public bool AutoPreamp { get; set; } = true;
    public List<EqBand> Bands { get; set; } = new();
    public string PresetName { get; set; } = "";
    public CrossfeedConfig Crossfeed { get; set; } = new();
    public double Balance { get; set; }
    public bool Invert { get; set; }
}

public sealed class EqPreset
{
    public string Name { get; set; }
    public double PreampDb { get; set; }
    public List<EqBand> Bands { get; set; } = new();
}

public sealed class Settings
{
    public List<string> Folders { get; set; } = new();
    /// <summary>Watch the library folders and add new / changed music by itself (MusicLibrary.Watch).</summary>
    public bool WatchFolders { get; set; } = true;
    // Output
    public string AudioCore { get; set; } = "miku";       // miku（MIKU 本身的內核）| 擴充模組提供的內核 id
    public string OutputMode { get; set; } = "exclusive"; // exclusive | shared | asio
    // YouTube Music's own output (the YouTube bar): null = as set above; shared | asio = switched to while YouTube plays
    public string YtOutputMode { get; set; }
    // set while YouTube plays in YtOutputMode: the output mode the library's tracks go back to
    public string YtRestoreMode { get; set; }
    public string DeviceId { get; set; }
    public string AsioDriver { get; set; }
    public int BufferMs { get; set; } = 100;
    public string Upsampling { get; set; } = "off"; // off | 2x | max | fixed
    public int FixedRate { get; set; } = 192000;
    public bool Dop { get; set; } = false;                // older on/off setting, read when DsdMode isn't set
    /// <summary>How DSD files are played: native (ASIO native DSD) | dop | pcm. null = from the older Dop switch.</summary>
    public string DsdMode { get; set; }
    /// <summary>
    /// DSD playback as chosen, for an output. ASIO: native | dop | pcm (native falls back to PCM when the driver has
    /// no native DSD). WASAPI: dop | pcm — DoP only in exclusive mode; "native" (the older switch off) means PCM.
    /// </summary>
    public string DsdFor(string outputMode)
    {
        string m = DsdMode is "native" or "dop" or "pcm" ? DsdMode : (Dop ? "dop" : "native");
        if (outputMode == "asio") return m;
        return m == "dop" && outputMode != "shared" ? "dop" : "pcm";
    }
    public int DsdPcmRate { get; set; } = 176400;
    /// <summary>
    /// The highest DSD multiple the DAC takes (64 | 128 | 256 | 512); 0 = no limit. Some drivers accept DSD rates their
    /// DAC cannot play without reporting an error, so every core keeps DSD output at or below it (DSD files above it play
    /// as PCM). Shared by the cores.
    /// </summary>
    public int MaxDsd { get; set; }
    /// <summary>MaxDsd when it is one of the multiples, else 0 (no limit).</summary>
    public int DsdLimit() => MaxDsd is 64 or 128 or 256 or 512 ? MaxDsd : 0;
    public bool Gapless { get; set; } = true;
    public string ReplayGain { get; set; } = "off"; // off | track | album | source（只在播放量測響度的模組的頻道時，依曲目）
    public double ReplayGainPreamp { get; set; }
    /// <summary>
    /// ReplayGain for a track (dB, preamp included), or null when off or the track has no gain tag. A track is raised
    /// only as far as its peak tag allows (the peak reaches full scale at most: foobar2000's "prevent clipping
    /// according to peak"); without a peak tag the gain only lowers the level. Every core uses this rule.
    /// </summary>
    public double? ReplayGainDb(Track t)
    {
        if (ReplayGain == "off" || t == null) return null;
        // a module that measures loudness (Miku.Extensibility.ILoudnessProvider): its measurement first (ReplayGain 2's
        // -18 LUFS reference, true peak), tags where it has none. "album": the album's loudness from its tracks', once
        // every track is measured (MeasuredAlbum), so an album is never half measured, half tagged
        if (ReplayGain == "source" && !PlayingLoudnessSource()) return null;
        if ((ReplayGain == "album" ? MeasuredAlbum?.Invoke(t) : Measured?.Invoke(t)) is var (lufs, tp) && double.IsFinite(lufs))
        {
            double top = tp > 0 ? -20 * Math.Log10(tp) : 0;
            return Math.Clamp(Math.Min(-18 - lufs + ReplayGainPreamp, top), -24, 24);
        }
        bool album = ReplayGain == "album";
        double? g = album ? (t.RgAlbum ?? t.RgTrack) : (t.RgTrack ?? t.RgAlbum);
        if (!g.HasValue) return null;
        double? peak = album ? (t.RgAlbum.HasValue ? t.RgAlbumPeak : t.RgTrackPeak) : (t.RgTrack.HasValue ? t.RgTrackPeak : t.RgAlbumPeak);
        double max = peak is > 0 ? -20 * Math.Log10(peak.Value) : 0;
        return Math.Clamp(Math.Min(g.Value + ReplayGainPreamp, max), -24, 24);
    }
    /// <summary>
    /// The loudness module's measurement of a track (LUFS, true peak linear), or null when not measured; LUFS is
    /// -∞ for a track measured as silent (nothing to level). Set at start-up.
    /// </summary>
    public static Func<Track, (double Lufs, double Peak)?> Measured;
    /// <summary>The same for the track's album: from all its tracks (null until every one is measured). Set at start-up.</summary>
    public static Func<Track, (double Lufs, double Peak)?> MeasuredAlbum;

    /// <summary>
    /// An album's loudness from its tracks' (BS.1770 sums energy over time: the tracks' powers weighted by their
    /// length) and its highest peak; silent tracks add nothing. Null while a track is not measured. Each track is
    /// gated on its own, so it can differ a little from measuring the album in one go (well under 1 dB but for long
    /// silences).
    /// </summary>
    public static (double Lufs, double Peak)? AlbumLoudness(IEnumerable<Track> tracks)
    {
        double energy = 0, time = 0, peak = 0;
        foreach (var x in tracks)
        {
            if (Measured?.Invoke(x) is not var (l, p)) return null;
            if (!double.IsFinite(l)) continue;
            double w = x.Duration > 0 ? x.Duration : 1;
            energy += w * Math.Pow(10, l / 10);
            time += w;
            peak = Math.Max(peak, p);
        }
        return time > 0 ? (10 * Math.Log10(energy / time), peak) : null;
    }
    /// <summary>The loudness module's id (the queue source's "ext"), or null when there is none.</summary>
    public static string LoudnessSource;

    /// <summary>Whether the queue playing came from the loudness module (ReplayGain "source").</summary>
    bool PlayingLoudnessSource()
    {
        var src = QueueSource;
        return LoudnessSource != null && src is { ValueKind: JsonValueKind.Object } q
            && q.TryGetProperty("ext", out var ext) && ext.ValueKind == JsonValueKind.String && ext.GetString() == LoudnessSource;
    }

    /// <summary>What the ReplayGain of a track is based on, for the signal path ("MoodWave 量測", "依曲目" …).</summary>
    public string ReplayGainBasis(Track t)
    {
        if (ReplayGain == "album") return MeasuredAlbum?.Invoke(t) is var (al, _) && double.IsFinite(al) ? "measured-album" : "album";
        if (ReplayGain is "track" or "source" && Measured?.Invoke(t) is var (l, _) && double.IsFinite(l) && (ReplayGain == "track" || PlayingLoudnessSource()))
            return "measured";
        return "track";
    }

    // Volume
    public string VolumeMode { get; set; } = "digital"; // digital | hardware | fixed
    public double VolumeDb { get; set; } = -20;
    public bool Muted { get; set; }
    // DSP
    public DspConfig Dsp { get; set; } = new();
    public List<EqPreset> Presets { get; set; } = new();
    // Online
    public bool OnlineArt { get; set; } = true;
    public bool OnlineLyrics { get; set; } = true;
    public bool ArtistImages { get; set; } = true;
    public bool LyricsTranslation { get; set; } = true;
    /// <summary>AcoustID application key for the tag editor's 聲紋辨識 (acoustid.org/new-application).</summary>
    public string AcoustIdKey { get; set; }
    // Player state
    public string Repeat { get; set; } = "off"; // off | all | one
    public string AutoContinue { get; set; } = "off"; // off | albums | tracks: keep playing random music when the queue runs out
    public bool Shuffle { get; set; }
    public List<string> Queue { get; set; } = new();
    public int QueueIndex { get; set; } = -1;
    public int QueueContinuedFrom { get; set; } = -1;   // where the queue goes on with a module's Smart Playlist (Player.ContinuedFrom)
    public double ResumePosition { get; set; }
    /// <summary>Where the queue came from, when an extension module started it (MikuExt play's source); null otherwise.</summary>
    public JsonElement? QueueSource { get; set; }
    public HashSet<string> Favorites { get; set; } = new();
    public List<string> Recent { get; set; } = new();         // track ids, most recent first
    public List<string> SearchHistory { get; set; } = new();  // search queries, most recent first
    public HashSet<string> ArtConfirmed { get; set; } = new();
    public Dictionary<string, double> LyricOffsets { get; set; } = new();
    public Dictionary<string, string> Ui { get; set; } = new();
    /// <summary>Settings of extension modules: id → key → value (see Host/Extensions.cs).</summary>
    public Dictionary<string, Dictionary<string, JsonElement>> Ext { get; set; } = new();
    /// <summary>Check GitHub for a new MIKU and download it in the background (Host/Updater.cs; 設定 → 其他).</summary>
    public bool AutoUpdate { get; set; } = true;
    // Phone remote (LAN web server)
    public bool RemoteEnabled { get; set; } = true;
    public int RemotePort { get; set; } = 8765;
    // Window
    public int[] Window { get; set; }
    public int WindowDpi { get; set; } // DPI associated with the saved physical size; 0 for older settings
    public bool Maximized { get; set; }
}
