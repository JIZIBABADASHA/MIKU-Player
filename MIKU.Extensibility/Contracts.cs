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

    /// <summary>
    /// The library ids of the track playing (or loaded) and of the ones after it in the queue, in playing order, at
    /// most <paramref name="count"/>; empty when the queue is empty.
    /// </summary>
    IReadOnlyList<string> Upcoming(int count);

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

    /// <summary>
    /// A track stopped playing: it ended, or the listener moved on (next, another track, another list, removed it,
    /// stopped). Raised once per track that played, from any thread. Not on an older MIKU: there it is never raised.
    /// </summary>
    event Action<ExtPlayed> TrackPlayed;

    /// <summary>The library ids of the tracks played lately, most recent first (at most 200).</summary>
    IReadOnlyList<string> RecentlyPlayed { get; }

    /// <summary>Adds tracks to the end of the queue (<paramref name="next"/>: right after the track playing).</summary>
    void Enqueue(IReadOnlyList<string> trackIds, bool next = false);

    /// <summary>Who made the queue playing: the source object a module played it with (ext = its id), or null.</summary>
    JsonElement? QueueSource { get; }
}

/// <summary>
/// One track that played (IExtensionHost.TrackPlayed): how far it got, and whether it ended by itself or the listener
/// moved on (<see cref="Skipped"/>; stopping playback or closing MIKU counts as neither: <see cref="Stopped"/>; going
/// back to the previous track neither: <see cref="Back"/>).
/// </summary>
public sealed record ExtPlayed(string Id, double Seconds, double Duration, bool Skipped, bool Stopped, JsonElement? Source)
{
    /// <summary>
    /// The listener went back to the previous track (previous, in the first 3 s of this one): they want to hear that one
    /// again, which says nothing against this one. Not <see cref="Skipped"/>. An older MIKU has no Back: it reports this
    /// as skipped.
    /// </summary>
    public bool Back { get; init; }
}

/// <summary>
/// Optional, on an <see cref="IMikuExtension"/>: the module chooses what plays when the queue runs out. The module turns
/// it on in its own settings by setting MIKU's 「佇列播完後」 (Settings.AutoContinue) to "similar"; MIKU's own choice is
/// then greyed out, noted 「<see cref="ContinueName"/> 已開啟」. While the last track of the queue plays, MIKU asks
/// <see cref="Continue"/> and adds what it returns (random tracks when it returns none).
/// Also asked while the queue playing is the module's own (its <c>source.ext</c>), whatever that setting: a module's
/// endless list (a radio) goes on by itself.
/// </summary>
public interface IQueueContinuation
{
    /// <summary>The feature's name as the listener knows it, for MIKU's setting (「… 已開啟」).</summary>
    string ContinueName { get; }

    /// <summary>
    /// What to add after the queue's last track: library ids, a few at a time (they show in the queue). Called from
    /// any thread, at most once at a time, while that track plays: answer within a second or two.
    /// </summary>
    Task<IReadOnlyList<string>> Continue(ExtContinue request);
}

/// <summary>
/// What a queue continuation is asked with: the queue's tracks up to the one playing (the last of them, in playing
/// order, at most 50), the queue's source, and whether the listener chose the module in 「佇列播完後」 (false: only
/// because the queue is the module's own).
/// </summary>
public sealed record ExtContinue(IReadOnlyList<string> Played, JsonElement? Source, bool Chosen);

/// <summary>
/// Optional, on an <see cref="IMikuExtension"/>: the module measures each track's loudness (ITU-R BS.1770), so MIKU's
/// ReplayGain can level tracks that carry no ReplayGain tags. With such a module, ReplayGain "track" uses its
/// measurements first (tags where it has none), "album" the album's loudness worked out from its tracks' once all are
/// measured, and ReplayGain "source" levels only while the queue playing is the module's (played from its page),
/// named after <see cref="LoudnessName"/>.
/// </summary>
public interface ILoudnessProvider
{
    /// <summary>The module's name as the listener knows it, for the setting ("在播放 … 時開啟").</summary>
    string LoudnessName { get; }

    /// <summary>
    /// The file's integrated loudness (LUFS) and true peak (linear, 1.0 = full scale), when measured; a file measured
    /// as silent (or that could not be measured) gives true with -∞ LUFS. Called as a track loads (and for every
    /// track of its album), from any thread: keep it a lookup.
    /// </summary>
    bool TryGetLoudness(string path, out double lufs, out double peak);
}

/// <summary>One track of the local library, as an extension sees it.</summary>
public sealed record ExtTrack(
    string Id, string Path, string Title, string Artist, string Album, string AlbumArtist, string Genre,
    double Duration, int SampleRate, int Bits, int Channels, string Codec, long Size, long Mtime);
