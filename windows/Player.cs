using System;
using System.Collections.Generic;
using System.Linq;
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

    public Player(IAudioEngine engine, MusicLibrary lib, Settings s)
    {
        _lib = lib; _s = s;
        _queue = s.Queue?.ToList() ?? new();
        _index = Math.Clamp(s.QueueIndex, -1, _queue.Count - 1);
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
    public int Index { get { lock (_lock) return _index; } }
    public Track Current { get { lock (_lock) return _index >= 0 && _index < _queue.Count ? _lib.GetTrack(_queue[_index]) : null; } }

    void Persist()
    {
        lock (_lock) { _s.Queue = _queue.ToList(); _s.QueueIndex = _index; }
    }

    Track PeekNext()
    {
        lock (_lock)
        {
            if (_queue.Count == 0) return null;
            if (_s.Repeat == "one") return Current;
            int n = _index + 1;
            if (n >= _queue.Count) { if (_s.Repeat != "all") return null; n = 0; }
            return _lib.GetTrack(_queue[n]);
        }
    }

    void OnGaplessStart(Track t)
    {
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
        NowChanged?.Invoke();
        await Engine.LoadAsync(t, pos, play);
        if (Engine.IsLoaded) { _failures = 0; if (play) EnsureAutoNext(); }
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

    public Task PlayList(IList<string> ids, int start, bool shuffle)
    {
        var list = ids.Where(id => _lib.GetTrack(id) != null).ToList();
        if (list.Count == 0) return Task.CompletedTask;
        bool startExplicit = start >= 0;
        start = Math.Clamp(start, 0, list.Count - 1);
        lock (_lock)
        {
            _s.Shuffle = shuffle;
            if (shuffle)
            {
                _unshuffled = list.ToList();
                // start < 0 means "shuffle everything"; otherwise the chosen track plays first
                var order = list.OrderBy(_ => Random.Shared.Next()).ToList();
                if (startExplicit)
                {
                    order.Remove(list[start]);
                    order.Insert(0, list[start]);
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
        return Load(Current, 0, true);
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
            if (playNext && _index >= 0) _queue.InsertRange(_index + 1, valid);
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
            if (_index >= _queue.Count) _index = _queue.Count - 1;
        }
        Engine.InvalidateNext();
        Persist();
        QueueChanged?.Invoke();
        if (wasCurrent)
        {
            var t = Current;
            if (t != null) _ = Load(t, 0, Engine.IsPlaying);
            else Engine.Stop();
        }
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
                var rest = _queue.Where((_, i) => i > _index).OrderBy(_ => Random.Shared.Next()).ToList();
                _queue = _queue.Take(_index + 1).Concat(rest).ToList();
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

    public void SetRepeat(string mode)
    {
        _s.Repeat = mode is "all" or "one" ? mode : "off";
        Engine.InvalidateNext();
        QueueChanged?.Invoke();
        if (Engine.IsPlaying) EnsureAutoNext();
    }

    /// <summary>
    /// Auto continue: when the last song in the queue is playing, add a random album (or a random song) from the
    /// library so playback never stops. Albums / songs played recently are avoided while there are others left.
    /// </summary>
    public void EnsureAutoNext()
    {
        string mode = _s.AutoContinue;
        if (mode != "albums" && mode != "tracks") return;
        if (_s.Repeat != "off") return;
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
                add = pool.OrderBy(_ => Random.Shared.Next()).Take(5).Select(t => t.Id).ToList();
            }
            _queue.AddRange(add);
            _unshuffled?.AddRange(add);
        }
        Engine.InvalidateNext();
        Persist();
        QueueChanged?.Invoke();
    }

    /// <summary>Drop queue entries whose files disappeared after a rescan.</summary>
    public void Validate()
    {
        lock (_lock)
        {
            string cur = _index >= 0 && _index < _queue.Count ? _queue[_index] : null;
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
