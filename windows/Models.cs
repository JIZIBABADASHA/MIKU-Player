using System;
using System.Collections.Generic;
using System.IO;
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
    public bool HasPic { get; set; }
    public double? RgTrack { get; set; }
    public double? RgAlbum { get; set; }
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
    // Output
    public string AudioCore { get; set; } = "miku";       // miku（MIKU 原本的 NAudio 內核）| rplay（Rplay 內核，選用）
    public string RplayProfile { get; set; } = "fixed"; // Rplay 相容模式：fixed（修正，預設）| original（原行為，比對用）
    public int RplayMaxDsd { get; set; } = 512;           // Rplay：最高 DSD 倍數（64 / 128 / 256 / 512），超過的轉 PCM
    public string OutputMode { get; set; } = "exclusive"; // exclusive | shared | asio
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
    public bool Gapless { get; set; } = true;
    public string ReplayGain { get; set; } = "off"; // off | track | album
    public double ReplayGainPreamp { get; set; }
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
    // Phone remote (LAN web server)
    public bool RemoteEnabled { get; set; } = true;
    public int RemotePort { get; set; } = 8765;
    // Window
    public int[] Window { get; set; }
    public bool Maximized { get; set; }
}
