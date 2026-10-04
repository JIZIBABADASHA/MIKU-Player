using System;
using System.Collections.Generic;
using System.Text.Json;
using System.Threading.Tasks;

namespace Miku.Extensibility;

/// <summary>
/// An optional module that adds a feature to MIKU. MIKU finds it at start-up in <c>ext\&lt;id&gt;\</c> next to the
/// program, calls <see cref="Start"/> once, routes the page's <c>ext.&lt;id&gt;.*</c> calls to <see cref="HandleRpc"/>,
/// and calls <see cref="Stop"/> when it closes. A failing extension is logged and left out; MIKU carries on.
/// </summary>
public interface IMikuExtension
{
    /// <summary>Short lower-case id: the folder name, the RPC and event prefix, and the settings key.</summary>
    string Id { get; }

    /// <summary>Called on the UI thread once MIKU is up. Keep it quick: start background work on your own threads.</summary>
    void Start(IExtensionHost host);

    /// <summary>The page called <c>ext.&lt;id&gt;.&lt;method&gt;</c>. The result is sent back as JSON.</summary>
    Task<object> HandleRpc(string method, JsonElement args);

    /// <summary>MIKU is closing: stop background work and save.</summary>
    void Stop();
}

/// <summary>What MIKU offers an extension. Members may be used from any thread unless noted.</summary>
public interface IExtensionHost
{
    /// <summary>A writable folder for this extension's data (<c>…\MIKU\ext\&lt;id&gt;\</c>).</summary>
    string DataDir { get; }

    /// <summary>The folder the extension was deployed to (<c>ext\&lt;id&gt;\</c> next to MIKU), for helper programs and assets.</summary>
    string ExtensionDir { get; }

    /// <summary>Full path of ffmpeg.exe, or null when MIKU has none.</summary>
    string FfmpegPath { get; }

    /// <summary>A snapshot of the local library.</summary>
    IReadOnlyList<ExtTrack> Tracks { get; }

    /// <summary>The library was loaded or changed (a scan finished, files were added or removed).</summary>
    event Action LibraryChanged;

    /// <summary>Whether MIKU is playing right now.</summary>
    bool IsPlaying { get; }

    /// <summary>Playback started, paused, stopped or moved to another track.</summary>
    event Action PlaybackChanged;

    /// <summary>Replaces the queue with these tracks and plays them; <paramref name="start"/> = index to start at, -1 = first.</summary>
    Task Play(IReadOnlyList<string> trackIds, bool shuffle, int start = -1);

    /// <summary>Sends an event to the page; it arrives there as <c>ext.&lt;id&gt;.&lt;ev&gt;</c>.</summary>
    void Post(string ev, object data);

    /// <summary>A value saved with MIKU's settings for this extension, or null.</summary>
    JsonElement? GetSetting(string key);

    /// <summary>Saves a value with MIKU's settings for this extension (null removes it).</summary>
    void SetSetting(string key, object value);

    /// <summary>Writes a line to MIKU's log.</summary>
    void Log(string message);
}

/// <summary>One track of the local library, as an extension sees it.</summary>
public sealed record ExtTrack(
    string Id, string Path, string Title, string Artist, string Album, string AlbumArtist, string Genre,
    double Duration, int SampleRate, int Bits, int Channels, string Codec, long Size, long Mtime);
