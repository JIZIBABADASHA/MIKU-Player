using System;
using System.Collections.Generic;

namespace Miku.Audio;

/// <summary>
/// A playback core from an extension module (../MIKU.Extensibility/README.md): the module's IMikuExtension also
/// implements this, and its core is offered in Settings → 播放方案 next to MIKU's own. The module's assembly
/// references MIKU (Private=false), so the types here are MIKU's own.
/// </summary>
public interface IAudioCoreProvider
{
    /// <summary>Settings.AudioCore value (lower case, not "miku").</summary>
    string CoreId { get; }
    /// <summary>What the settings and the log call it.</summary>
    string CoreName { get; }
    /// <summary>What the settings page needs to know about the core (sent to the page as is).</summary>
    AudioCoreInfo Info { get; }
    /// <summary>A new engine; <paramref name="ui"/> runs an action on MIKU's UI thread.</summary>
    IAudioEngine CreateEngine(Settings settings, Action<Action> ui);
}

/// <summary>A core's capabilities as the settings page shows them.</summary>
public sealed class AudioCoreInfo
{
    public string Id { get; set; }
    public string Name { get; set; }
    /// <summary>ASIO output can send DSD as DSD (native or DoP); MIKU's own core converts DSD to PCM on ASIO.</summary>
    public bool AsioDsd { get; set; }
    /// <summary>The core uses Settings.DsdPcmRate (MIKU's own does; a core that picks the rate itself has no field).</summary>
    public bool DsdPcmRate { get; set; } = true;
    /// <summary>The 升頻 field's title and the description of each choice (off / 2x / max / fixed); null: MIKU's own.</summary>
    public string UpsamplingTitle { get; set; }
    public Dictionary<string, string> UpsamplingText { get; set; }
}
