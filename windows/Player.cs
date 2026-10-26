using System;
using System.Collections.Generic;
using System.Linq;
using System.Text.Json;
using System.Threading;
using System.Threading.Tasks;
using Miku.Audio;
using Miku.Library;

namespace Miku;

/// <summary>Queue, shuffle and repeat on top of the audio engine.</summary>
public sealed class Player
{
    readonly MusicLibrary _lib;
    readonly Settings _s;
    public IAudioEngine Engine { get; private set; }
    readonly object _lock = new();
    List<string> _queue = new();
    List<string> _unshuffled;
    int _index = -1;
    int _failures;

    public event Action QueueChanged;
    public event Action NowChanged;
    public event Action<string> Error;

    /// <summary>
    /// A track stopped playing (extension modules' TrackPlayed): the track, the seconds it played, whether the listener
    /// moved on (skipped) or stopped playback, and the queue's source while it played. Once per track that started.
    /// </summary>
    public event Action<Track, double, bool, bool, JsonElement?> Played;

    /// <summary>
    /// A module that chooses what plays when the queue runs out (Miku.Extensibility.IQueueContinuation): its id, and
    /// how to ask it (the queue's tracks up to the one playing, the queue's source, whether 「佇列播完後」 chose it).
    /// </summary>
    public string ContinuationId;
    public Func<IReadOnlyList<string>, JsonElement?, bool, Task<IReadOnlyList<string>>> Continuation;

    /// <summary>
    /// Where the queue goes on with what a module chose (「佇列播完後」 handed to it: its Smart Playlist): the index of the
    /// first track it added, -1 while there is none. The bar shows the module's slot from there on (QueueDto).
    /// </summary>
    public int ContinuedFrom { get { lock (_lock) return _continuedFrom; } }
    int _continuedFrom = -1;

    Track _playing;                 // the track playing now, reported (Played) once it is left
    JsonElement? _playingSource;
    int _asking;                    // a module is being asked what comes next

    public Player(IAudioEngine engine, MusicLibrary lib, Settings s)
    {
        _lib = lib; _s = s;
        _queue = s.Queue?.ToList() ?? new();
        _index = Math.Clamp(s.QueueIndex, -1, _queue.Count - 1);
        _continuedFrom = s.QueueContinuedFrom >= 0 && s.QueueContinuedFrom < _queue.Count ? s.QueueContinuedFrom : -1;   // kept with the queue
        Attach(engine);
    }

    void Attach(IAudioEngine engine)
    {
        Engine = engine;
        engine.PeekNext = PeekNext;
        engine.TrackStarted += OnGaplessStart;
        engine.Ended += OnEnded;
        engine.Failed += OnFailed;
    }

    /// <summary>Switch to another playback core (Settings.AudioCore). The old engine must be stopped by the caller.</summary>
    public void ReplaceEngine(IAudioEngine engine)
    {
        var old = Engine;
        if (old != null)
        {
            old.PeekNext = null;
            old.TrackStarted -= OnGaplessStart;
            old.Ended -= OnEnded;
            old.Failed -= OnFailed;
        }
        Attach(engine);
    }

    public List<string> Queue { get { lock (_lock) return _queue.ToList(); } }
    /// <summary>Who made the queue (an extension module's source object), kept while the queue is the same list.</summary>
    public System.Text.Json.JsonElement? Source { get { lock (_lock) return _s.QueueSource; } }
    public int Index { get { lock (_lock) return _index; } }
    public Track Current { get { lock (_lock) return _index >= 0 && _index < _queue.Count ? _lib.GetTrack(_queue[_index]) : null; } }

    void Persist()
    {
        lock (_lock) { _s.Queue = _queue.ToList(); _s.QueueIndex = _index; _s.QueueContinuedFrom = _continuedFrom; }
    }

    Track PeekNext()
    {
        lock (_lock)
        {
            if (_queue.Count == 0) return null;
            if (_s.Repeat == "one") return Current;
            int n = _index + 1;
            if (n >= _queue.Count) { if (_s.Repeat != "all") return null; n = 0; }
            var t = _lib.GetTrack(_queue[n]);
            // a CD track not yet all in the cache isn't opened ahead of time: it starts when it is its turn (Load waits for it)
            if (t != null && t.Codec == "CD" && CdService.Instance?.IsReady(t) != true) return null;
            return t;
        }
    }

    void OnGaplessStart(Track t)
    {
        Left(_playing?.Duration ?? 0, false, false);
        Started(t);
        lock (_lock)
        {
            if (_s.Repeat == "one" && Current?.Id == t.Id) { }
            else
            {
                int n = _index + 1 < _queue.Count ? _index + 1 : 0;
                if (n < _queue.Count && _queue[n] == t.Id) _index = n;
                else { int i = _queue.IndexOf(t.Id); if (i >= 0) _index = i; }
            }
        }
        _failures = 0;
        Persist();
        NowChanged?.Invoke();
        QueueChanged?.Invoke();
        EnsureAutoNext();
    }

    void OnEnded()
    {
        Left(_playing?.Duration ?? Engine.Position, false, false);
        EnsureAutoNext();
        Track next = null;
        lock (_lock)
        {
            if (_queue.Count > 0)
            {
                if (_s.Repeat == "one") next = Current;
                else if (_index + 1 < _queue.Count) { _index++; next = Current; }
                else if (_s.Repeat == "all") { _index = 0; next = Current; }
            }
        }
        Persist();
        if (next != null) _ = Load(next, 0, true);
        else
        {
            _s.ResumePosition = 0;
            Task.Run(() => { Engine.Stop(); NowChanged?.Invoke(); });
        }
        QueueChanged?.Invoke();
        NowChanged?.Invoke();
    }

    void OnFailed(string message)
    {
        Error?.Invoke(message);
    }

    async Task Load(Track t, double pos, bool play)
    {
        if (t == null) return;
        // another track replaces the one playing: the listener moved on (the same one again: a reload, not a leave)
        if (_playing != null && _playing.Id != t.Id) Left(Engine.Position, true, false);
        NowChanged?.Invoke();
        if (t.Codec == "CD" && CdService.Instance != null)
        {
            // an audio CD: the track is read into the cache first (playback starts once enough of it is there)
            try { await CdService.Instance.Prepare(t); }
            catch (Exception ex) { Error?.Invoke(ex.Message); NowChanged?.Invoke(); return; }
        }
        await Engine.LoadAsync(t, pos, play);
        // loaded paused (previous / next while paused): a module going on with the queue is still asked if this is its
        // last track, or nothing comes after it when play goes on; no random songs until it plays
        if (Engine.IsLoaded) { _failures = 0; if (play) { Started(t); EnsureAutoNext(); } else EnsureAutoNext(false); }
        // only skip ahead for an unreadable file; if the DAC couldn't be opened every track would fail the same way,
        // so stay on the chosen one (the error is shown) instead of jumping to the next song
        else if (play && !Engine.LastFailureWasDevice && ++_failures < 3 && Engine.Track == t)
        {
            // unreadable file: move on rather than stalling the queue
            Track next = null;
            lock (_lock) if (_index + 1 < _queue.Count) { _index++; next = Current; }
            if (next != null) { Persist(); QueueChanged?.Invoke(); await Load(next, 0, true); }
        }
        NowChanged?.Invoke();
    }

    // ───────────────────────────── commands ─────────────────────────────

    /// <param name="at">Where the first track starts, in seconds.</param>
    /// <param name="source">Who made the list (shown by the player bar); a list without one clears it.</param>
    public Task PlayList(IList<string> ids, int start, bool shuffle, double at = 0, System.Text.Json.JsonElement? source = null)
    {
        var list = ids.Where(id => _lib.GetTrack(id) != null).ToList();
        if (list.Count == 0) return Task.CompletedTask;
        bool startExplicit = start >= 0;
        start = Math.Clamp(start, 0, list.Count - 1);
        lock (_lock)
        {
            _s.QueueSource = source;
            _s.Shuffle = shuffle;
            _continuedFrom = -1;
            if (shuffle)
            {
                _unshuffled = list.ToList();
                // start < 0 means "shuffle everything"; otherwise the chosen track plays first
                string first = list[start];
                var order = list;
                ShuffleRange(order, 0);
                if (startExplicit)
                {
                    order.Remove(first);
                    order.Insert(0, first);
                }
                _queue = order;
                _index = 0;
            }
            else
            {
                _unshuffled = null;
                _queue = list;
                _index = start;
            }
        }
        Engine.InvalidateNext();
        Persist();
        QueueChanged?.Invoke();
        return Load(Current, Math.Max(0, at), true);
    }

    public Task JumpTo(int i)
    {
        lock (_lock)
        {
            if (i < 0 || i >= _queue.Count) return Task.CompletedTask;
            _index = i;
        }
        Engine.InvalidateNext();
        Persist();
        QueueChanged?.Invoke();
        return Load(Current, 0, true);
    }

    /// <summary>Tracks whose files were renamed (their ids come from the path): the queue keeps them under the new ids.</summary>
    public void RenameIds(IReadOnlyDictionary<string, string> map)
    {
        lock (_lock)
        {
            _queue = _queue.Select(id => map.TryGetValue(id, out var n) ? n : id).ToList();
            if (_unshuffled != null) _unshuffled = _unshuffled.Select(id => map.TryGetValue(id, out var n) ? n : id).ToList();
        }
        Persist();
    }

    /// <summary>Loads the current track again at <paramref name="pos"/> (after its file was rewritten, e.g. new tags).</summary>
    public Task Reload(double pos, bool play)
    {
        Engine.InvalidateNext();
        return Load(Current, pos, play);
    }

    public Task Next()
    {
        lock (_lock)
        {
            if (_queue.Count == 0) return Task.CompletedTask;
            if (_index + 1 < _queue.Count) _index++;
            else if (_s.Repeat != "off") _index = 0;
            else return Task.CompletedTask;
        }
        Engine.InvalidateNext();
        Persist();
        QueueChanged?.Invoke();
        return Load(Current, 0, Engine.IsPlaying || Engine.Track == null);
    }

    public Task Previous()
    {
        if (Engine.Position > 3 && Engine.Track != null) return Engine.SeekAsync(0);
        lock (_lock)
        {
            if (_queue.Count == 0) return Task.CompletedTask;
            if (_index > 0) _index--;
            else if (_s.Repeat == "all") _index = _queue.Count - 1;
            else return Engine.SeekAsync(0);
        }
        Engine.InvalidateNext();
        Persist();
        QueueChanged?.Invoke();
        return Load(Current, 0, Engine.IsPlaying || Engine.Track == null);
    }

    public Task Toggle()
    {
        if (Engine.IsLoaded)
        {
            if (Engine.IsPlaying) Engine.Pause(); else Engine.Resume();
            return Task.CompletedTask;
        }
        var t = Current;
        if (t == null) return Task.CompletedTask;
        double pos = Engine.Track?.Id == t.Id ? Engine.Position : _s.ResumePosition;
        return Load(t, pos, true);
    }

    public Task Seek(double pos)
    {
        if (Engine.IsLoaded) return Engine.SeekAsync(pos);
        _s.ResumePosition = pos;
        var t = Current;
        return t == null ? Task.CompletedTask : Load(t, pos, false);
    }

    public void Add(IList<string> ids, bool playNext)
    {
        lock (_lock)
        {
            var valid = ids.Where(id => _lib.GetTrack(id) != null).ToList();
            if (playNext && _index >= 0)
            {
                _queue.InsertRange(_index + 1, valid);
                if (_continuedFrom > _index) _continuedFrom += valid.Count;   // played next, before the Smart Playlist's part
            }
            else _queue.AddRange(valid);
            if (_index < 0 && _queue.Count > 0) _index = 0;
            _unshuffled?.AddRange(valid);
        }
        Engine.InvalidateNext();
        Persist();
        QueueChanged?.Invoke();
    }

    public void Remove(int i)
    {
        bool wasCurrent;
        lock (_lock)
        {
            if (i < 0 || i >= _queue.Count) return;
            wasCurrent = i == _index;
            string id = _queue[i];
            _queue.RemoveAt(i);
            _unshuffled?.Remove(id);
            if (i < _index) _index--;
            if (i < _continuedFrom) _continuedFrom--;
            if (_continuedFrom >= _queue.Count) _continuedFrom = -1;
            if (_index >= _queue.Count) _index = _queue.Count - 1;
        }
        Engine.InvalidateNext();
        Persist();
        QueueChanged?.Invoke();
        if (wasCurrent)
        {
            var t = Current;
            if (t != null) _ = Load(t, 0, Engine.IsPlaying);
            else { Left(Engine.Position, true, false); Engine.Stop(); }
        }
        // the queue may now end with the track playing: a module going on with it is asked at once (a track it had
        // picked taken out, e.g. after a 👎: the next pick knows it), not only when the track is over; paused too
        else if (Engine.IsLoaded) EnsureAutoNext(false);
    }

    public void Move(int from, int to)
    {
        lock (_lock)
        {
            if (from < 0 || from >= _queue.Count || to < 0 || to >= _queue.Count || from == to) return;
            string id = _queue[from];
            _queue.RemoveAt(from);
            _queue.Insert(to, id);
            if (_index == from) _index = to;
            else if (from < _index && to >= _index) _index--;
            else if (from > _index && to <= _index) _index++;
            if (_continuedFrom >= 0)
            {
                if (from < _continuedFrom && to >= _continuedFrom) _continuedFrom--;
                else if (from >= _continuedFrom && to < _continuedFrom) _continuedFrom++;
            }
        }
        Engine.InvalidateNext();
        Persist();
        QueueChanged?.Invoke();
    }

    public void ClearUpcoming()
    {
        lock (_lock)
        {
            if (_index >= 0 && _index < _queue.Count) _queue = _queue.Take(_index + 1).ToList();
            else _queue.Clear();
            _unshuffled = null;
            if (_continuedFrom > _index) _continuedFrom = -1;
        }
        Engine.InvalidateNext();
        Persist();
        QueueChanged?.Invoke();
    }

    public void SetShuffle(bool on)
    {
        lock (_lock)
        {
            if (on == _s.Shuffle) return;
            _s.Shuffle = on;
            string cur = _index >= 0 && _index < _queue.Count ? _queue[_index] : null;
            if (on)
            {
                _unshuffled = _queue.ToList();
                ShuffleRange(_queue, _index + 1);
            }
            else if (_unshuffled != null)
            {
                _queue = _unshuffled;
                _unshuffled = null;
                _index = cur == null ? -1 : _queue.IndexOf(cur);
            }
        }
        Engine.InvalidateNext();
        Persist();
        QueueChanged?.Invoke();
    }

    // Fisher-Yates: linear time, without sorting keys or allocating a second queue.
    static void ShuffleRange<T>(List<T> items, int start)
    {
        for (int i = items.Count - 1; i > start; i--)
        {
            int j = Random.Shared.Next(start, i + 1);
            (items[i], items[j]) = (items[j], items[i]);
        }
    }

    public void SetRepeat(string mode)
    {
        _s.Repeat = mode is "all" or "one" ? mode : "off";
        Engine.InvalidateNext();
        QueueChanged?.Invoke();
        if (Engine.IsPlaying) EnsureAutoNext();
    }

    /// <summary>
    /// Auto continue: when the last song in the queue is playing, add more so playback never stops: what a module
    /// chooses (「佇列播完後」 = similar, or the queue is the module's own list, e.g. its radio), or a random album or a
    /// few random songs from the library (albums / songs played recently are avoided while there are others left).
    /// </summary>
    public void EnsureAutoNext() => EnsureAutoNext(true);

    /// <param name="random">false: only a module going on with the queue is asked (its end changed while a track plays or is paused); no random songs yet.</param>
    void EnsureAutoNext(bool random)
    {
        if (_s.Repeat != "off") return;
        string mode = _s.AutoContinue;
        string ext = null;
        var src = Source;
        if (src is { ValueKind: JsonValueKind.Object } o && o.TryGetProperty("ext", out var e) && e.ValueKind == JsonValueKind.String) ext = e.GetString();
        bool chosen = mode == "similar" && Continuation != null;
        if (chosen || Continuation != null && ext != null && ext == ContinuationId) { AskContinuation(chosen, src); return; }
        if (random) AddRandom(mode == "similar" ? "tracks" : mode);   // similar without its module: random songs
    }

    /// <summary>Asks the module what comes after the last track (in the background) and adds it; random songs when it has none and 「佇列播完後」 chose it.</summary>
    void AskContinuation(bool chosen, JsonElement? src)
    {
        List<string> played;
        int count;
        lock (_lock)
        {
            if (_queue.Count == 0 || _index < _queue.Count - 1) return;
            played = _queue.Take(_index + 1).Skip(Math.Max(0, _index + 1 - 50)).ToList();
            count = _queue.Count;
        }
        if (Interlocked.Exchange(ref _asking, 1) == 1) return;
        var ask = Continuation;
        _ = Task.Run(async () =>
        {
            IReadOnlyList<string> add = null;
            try { add = await ask(played, src, chosen).WaitAsync(TimeSpan.FromSeconds(10)); }
            catch (Exception ex) { Log.Error("[ext] continue", ex); }
            finally { Interlocked.Exchange(ref _asking, 0); }
            bool added = false, again;
            lock (_lock)
            {
                // the queue changed meanwhile (a pick taken out after a vote): asked again if it still ends at the track playing
                bool changed = _queue.Count != count || _index != count - 1;
                again = changed && _queue.Count > 0 && _index == _queue.Count - 1;
                if (changed && !again) return;
                var valid = changed ? new List<string>() : (add ?? Array.Empty<string>()).Where(id => _lib.GetTrack(id) != null).ToList();
                if (valid.Count > 0)
                {
                    if (chosen && _continuedFrom < 0) _continuedFrom = _queue.Count;   // the module's own list (a radio) is all its own already
                    _queue.AddRange(valid);
                    _unshuffled?.AddRange(valid);
                    added = true;
                }
            }
            if (again) { if (Engine.IsLoaded) EnsureAutoNext(false); }
            else if (added)
            {
                Engine.InvalidateNext();
                Persist();
                QueueChanged?.Invoke();
            }
            else if (chosen) AddRandom("tracks");
        });
    }

    void AddRandom(string mode)
    {
        if (mode != "albums" && mode != "tracks") return;
        List<string> add = null;
        lock (_lock)
        {
            if (_queue.Count == 0 || _index < _queue.Count - 1) return;
            var cur = Current;
            var recent = new HashSet<string>(_s.Recent.Take(150));
            recent.UnionWith(_queue.Skip(Math.Max(0, _queue.Count - 300)));
            var albums = _lib.Albums.Where(a => a.Tracks.Count > 0).ToList();
            if (albums.Count == 0) return;
            if (mode == "albums")
            {
                var others = albums.Where(a => cur == null || a.Id != cur.AlbumId).ToList();
                if (others.Count == 0) others = albums;
                var fresh = others.Where(a => !a.Tracks.Any(t => recent.Contains(t.Id))).ToList();
                var pool = fresh.Count > 0 ? fresh : others;
                add = pool[Random.Shared.Next(pool.Count)].Tracks.Select(t => t.Id).ToList();
            }
            else
            {
                var all = albums.SelectMany(a => a.Tracks).Where(t => cur == null || t.Id != cur.Id).ToList();
                if (all.Count == 0) return;
                var fresh = all.Where(t => !recent.Contains(t.Id)).ToList();
                var pool = fresh.Count > 0 ? fresh : all;
                // a few songs at a time, so the queue shows what's coming up
                int take = Math.Min(5, pool.Count);
                add = new List<string>(take);
                for (int i = 0; i < take; i++)
                {
                    int j = Random.Shared.Next(i, pool.Count);
                    (pool[i], pool[j]) = (pool[j], pool[i]);
                    add.Add(pool[i].Id);
                }
            }
            _queue.AddRange(add);
            _unshuffled?.AddRange(add);
        }
        Engine.InvalidateNext();
        Persist();
        QueueChanged?.Invoke();
    }

    void Started(Track t)
    {
        lock (_lock) { _playing = t; _playingSource = _s.QueueSource; }
    }

    /// <summary>The track playing is left: reported once (Played).</summary>
    void Left(double seconds, bool skipped, bool stopped)
    {
        Track t;
        JsonElement? src;
        lock (_lock)
        {
            (t, src) = (_playing, _playingSource);
            _playing = null;
        }
        if (t == null) return;
        try { Played?.Invoke(t, Math.Max(0, seconds), skipped, stopped, src); }
        catch (Exception ex) { Log.Error("[player] played", ex); }
    }

    /// <summary>Playback was stopped (the stop button, a live stream taking over, MIKU closing): the track playing is reported as stopped.</summary>
    public void Stopped() => Left(Engine.Position, false, true);

    /// <summary>Drop queue entries whose files disappeared after a rescan.</summary>
    public void Validate()
    {
        lock (_lock)
        {
            string cur = _index >= 0 && _index < _queue.Count ? _queue[_index] : null;
            // the Smart Playlist's part starts where it did, less the entries dropped before it (a tag edit or a rescan
            // changes the library and so comes here: the boundary must not go with it)
            if (_continuedFrom >= 0)
            {
                int before = _queue.Take(_continuedFrom).Count(id => _lib.GetTrack(id) != null);
                bool any = _queue.Skip(_continuedFrom).Any(id => _lib.GetTrack(id) != null);
                _continuedFrom = any ? before : -1;
            }
            _queue = _queue.Where(id => _lib.GetTrack(id) != null).ToList();
            _index = cur == null ? (_queue.Count > 0 ? 0 : -1) : Math.Max(_queue.IndexOf(cur), _queue.Count > 0 ? 0 : -1);
        }
        Persist();
        QueueChanged?.Invoke();
    }

    public void SaveState()
    {
        Persist();
        if (Engine.Track != null) _s.ResumePosition = Engine.Position;
    }
}
