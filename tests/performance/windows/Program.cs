using System.Collections.Concurrent;
using System.Diagnostics;
using System.Net.Sockets;
using System.Reflection;
using System.Text;
using Miku;
using Miku.Audio;
using Miku.Library;

static class Check
{
    static readonly BindingFlags Private = BindingFlags.NonPublic | BindingFlags.Instance | BindingFlags.Static;
    static readonly string Scratch = Path.Combine(AppContext.BaseDirectory, "scratch", Guid.NewGuid().ToString("N"));
    static int _checks;

    static async Task Main()
    {
        Environment.SetEnvironmentVariable("MIKU_DATA_DIR", Scratch);
        AppPaths.Ensure();
        try
        {
            await ArtworkConcurrency();
            await QueueBehavior();
            await FileServerProtocol();
            BenchmarkShuffle();
            Console.WriteLine($"PASS: {_checks} Windows performance regression checks.");
        }
        finally { Directory.Delete(Scratch, true); }
    }

    static void Assert(bool ok, string message)
    {
        if (!ok) throw new Exception(message);
        _checks++;
    }

    static async Task ArtworkConcurrency()
    {
        var runOnce = typeof(ArtworkService).GetMethod("RunOnce", Private).MakeGenericMethod(typeof(byte[]));
        var pending = new ConcurrentDictionary<string, Lazy<Task<byte[]>>>();
        var release = new TaskCompletionSource<byte[]>(TaskCreationOptions.RunContinuationsAsynchronously);
        int calls = 0;
        Func<Task<byte[]>> work = () => { Interlocked.Increment(ref calls); return release.Task; };
        Task<byte[]> Invoke(string key, Func<Task<byte[]>> f) => (Task<byte[]>)runOnce.Invoke(null, new object[] { pending, key, f });
        var requests = await Task.WhenAll(Enumerable.Range(0, 100).Select(_ => Task.Run(() => (object)Invoke("same", work))));
        var tasks = requests.Cast<Task<byte[]>>().ToArray();
        var result = new byte[] { 1, 2, 3 };
        release.SetResult(result);
        var results = await Task.WhenAll(tasks).WaitAsync(TimeSpan.FromSeconds(5));
        Assert(calls == 1, "Concurrent artwork requests started duplicate work.");
        Assert(results.All(x => ReferenceEquals(x, result)), "Artwork callers did not share the same result.");
        Assert(pending.IsEmpty, "Completed artwork work leaked from the in-flight map.");
        try { await Invoke("fail", () => throw new InvalidOperationException("expected")); }
        catch (InvalidOperationException) { }
        Assert(pending.IsEmpty, "Failed artwork work leaked from the in-flight map.");
        Assert(ReferenceEquals(await Invoke("fail", () => Task.FromResult(result)), result), "Failed artwork could not retry.");

        var settings = new Settings { OnlineArt = false };
        var service = new ArtworkService(new MusicLibrary(settings), settings);
        var gate = (SemaphoreSlim)typeof(ArtworkService).GetField("_resize", Private).GetValue(service);
        int slots = 0;
        while (gate.Wait(0)) slots++;
        Assert(slots >= 1 && slots <= 4, "Full-resolution cover decodes must stay within their resource budget.");
        int sources = 0;
        var cached = typeof(ArtworkService).GetMethod("Cached", Private);
        var waiting = Enumerable.Range(0, 32).Select(i => (Task<byte[]>)cached.Invoke(service,
            new object[] { "blocked_" + i, 128, (Func<byte[]>)(() => { Interlocked.Increment(ref sources); return null; }) })).ToArray();
        try
        {
            await Task.Delay(150);
            Assert(sources == 0, "Queued thumbnail jobs loaded full source pictures before acquiring their concurrency slot.");
        }
        finally { gate.Release(slots); }
        await Task.WhenAll(waiting).WaitAsync(TimeSpan.FromSeconds(5));
        Assert(sources == waiting.Length, "Thumbnail jobs failed to resume after resize slots became available.");
    }

    static async Task QueueBehavior()
    {
        var settings = new Settings { AutoContinue = "off", Repeat = "off" };
        var library = new MusicLibrary(settings);
        var tracks = Enumerable.Range(0, 80).Select(i => new Track
        {
            Id = "id" + i, Path = Path.Combine(Scratch, "album", i + ".flac"),
            Title = "Track " + i, Album = "Album", Artist = "Artist", Duration = 100 + i
        }).ToList();
        typeof(MusicLibrary).GetMethod("Build", Private).Invoke(library, new object[] { tracks, new Dictionary<string, string>() });
        var player = new Player(new FakeEngine(), library, settings);
        var original = tracks.Take(30).Select(t => t.Id).ToList();
        original.Add("id4"); // repeated tracks must remain repeated
        await player.PlayList(original, 12, true);
        Assert(player.Queue[0] == original[12], "Explicit shuffle start moved away from the first position.");
        Assert(SameItems(original, player.Queue), "Shuffle lost or duplicated queue entries.");
        player.SetShuffle(false);
        Assert(player.Queue.SequenceEqual(original), "Disabling shuffle did not restore the original order.");
        await player.PlayList(original, 8, false);
        player.SetShuffle(true);
        Assert(player.Queue.Take(9).SequenceEqual(original.Take(9)), "Shuffle changed the played/current queue prefix.");
        Assert(SameItems(original, player.Queue), "Suffix shuffle lost queue entries.");
        player.SetShuffle(false);
        Assert(player.Queue.SequenceEqual(original) && player.Index == 8, "Shuffle restoration changed the current track.");
        await player.PlayList(original, -1, true);
        Assert(SameItems(original, player.Queue), "Shuffle-all lost queue entries.");
        await player.PlayList(new[] { "id0" }, 0, false);
        settings.Recent = tracks.Skip(1).Take(40).Select(t => t.Id).ToList();
        settings.AutoContinue = "tracks";
        player.EnsureAutoNext();
        var next = player.Queue.Skip(1).ToArray();
        Assert(next.Length == 5 && next.Distinct().Count() == 5, "Random continuation must choose five distinct tracks.");
        Assert(next.All(id => id != "id0" && !settings.Recent.Contains(id)), "Random continuation did not avoid current/recent tracks.");
        await player.PlayList(new[] { "id79" }, 0, true);
        Assert(player.Queue[0] == "id79", "Single-track shuffle failed.");
    }

    static bool SameItems(IEnumerable<string> a, IEnumerable<string> b) => a.OrderBy(x => x).SequenceEqual(b.OrderBy(x => x));

    static async Task FileServerProtocol()
    {
        byte[] data = Enumerable.Range(0, 131111).Select(i => (byte)(i % 251)).ToArray();
        string file = Path.Combine(Scratch, "stream.flac");
        await File.WriteAllBytesAsync(file, data);
        var uri = new Uri(FileServer.Url(file));
        using var client = new TcpClient();
        await client.ConnectAsync(uri.Host, uri.Port);
        var stream = client.GetStream();
        string Request(string method, string range = null, int padding = 0) =>
            $"{method} {uri.AbsolutePath} HTTP/1.1\r\nHost: localhost\r\n" +
            (range == null ? "" : "Range: bytes=" + range + "\r\n") +
            (padding == 0 ? "" : "X-Padding: " + new string('x', padding) + "\r\n") + "\r\n";

        // Pipeline multiple requests in one TCP write; large headers exercise compaction of buffered leftovers.
        string pipeline = Request("GET", "123-456", 15900) + Request("HEAD", "100-199", 15000) + Request("GET", "-31") + Request("GET");
        await stream.WriteAsync(Encoding.ASCII.GetBytes(pipeline));
        var first = await Response(stream);
        Assert(first.status == 206 && first.body.SequenceEqual(data.Skip(123).Take(334)), "Pipelined byte range response was incorrect.");
        var head = await Response(stream, true);
        Assert(head.status == 206 && head.length == 100 && head.body.Length == 0, "HEAD returned data or the wrong range length.");
        var suffix = await Response(stream);
        Assert(suffix.status == 206 && suffix.body.SequenceEqual(data.TakeLast(31)), "Suffix range response was incorrect.");
        var full = await Response(stream);
        Assert(full.status == 200 && full.body.SequenceEqual(data), "Full streaming response changed audio file bytes.");

        byte[] fragmented = Encoding.ASCII.GetBytes(Request("GET", "1-2"));
        // The header terminator crosses socket writes.
        await stream.WriteAsync(fragmented.AsMemory(0, fragmented.Length - 2));
        await Task.Delay(20);
        await stream.WriteAsync(fragmented.AsMemory(fragmented.Length - 2));
        var partial = await Response(stream);
        Assert(partial.status == 206 && partial.body.SequenceEqual(data.Skip(1).Take(2)), "Fragmented request header was not reconstructed.");
        await stream.WriteAsync(Encoding.ASCII.GetBytes(Request("GET", (data.Length + 1) + "-")));
        Assert((await Response(stream)).status == 416, "Unsatisfiable range lost its 416 response.");
    }

    static async Task<(int status, int length, byte[] body)> Response(NetworkStream stream, bool headOnly = false)
    {
        using var timeout = new CancellationTokenSource(TimeSpan.FromSeconds(10));
        var header = new StringBuilder();
        byte[] one = new byte[1];
        while (true)
        {
            int read = await stream.ReadAsync(one, timeout.Token);
            if (read == 0) throw new IOException("Unexpected end of HTTP response.");
            header.Append((char)one[0]);
            if (header.Length >= 4 && header.ToString(header.Length - 4, 4) == "\r\n\r\n") break;
        }
        string[] lines = header.ToString().Split("\r\n");
        int status = int.Parse(lines[0].Split(' ')[1]);
        int length = int.Parse(lines.Single(x => x.StartsWith("Content-Length:")).Split(':')[1].Trim());
        byte[] body = new byte[headOnly ? 0 : length];
        await stream.ReadExactlyAsync(body, timeout.Token);
        return (status, length, body);
    }

    static void BenchmarkShuffle()
    {
        var shuffle = (Action<List<string>, int>)typeof(Player).GetMethod("ShuffleRange", Private)
            .MakeGenericMethod(typeof(string)).CreateDelegate(typeof(Action<List<string>, int>));
        var input = Enumerable.Range(0, 100000).Select(i => "id" + i).ToList();
        long Measure(string label, Func<List<string>> action)
        {
            for (int i = 0; i < 3; i++) action();
            long before = GC.GetAllocatedBytesForCurrentThread();
            var watch = Stopwatch.StartNew();
            for (int i = 0; i < 10; i++) GC.KeepAlive(action());
            watch.Stop();
            long allocated = GC.GetAllocatedBytesForCurrentThread() - before;
            Console.WriteLine($"100k queue / 10 runs, {label}: {watch.Elapsed.TotalMilliseconds:F1} ms, {allocated:N0} allocated bytes");
            return allocated;
        }
        long oldBytes = Measure("random-key sort", () => input.OrderBy(_ => Random.Shared.Next()).ToList());
        long newBytes = Measure("Fisher-Yates", () => { var list = input.ToList(); shuffle(list, 0); return list; });
        Assert(newBytes < oldBytes, "Shuffle allocation regression.");
    }
}

sealed class FakeEngine : IAudioEngine
{
    public Func<Track> PeekNext { get; set; }
    public Func<Task> ReleaseOthers { get; set; }
#pragma warning disable CS0067
    public event Action<Track> TrackStarted;
    public event Action Ended;
    public event Action<string> Failed;
    public event Action Changed;
    public event Action<Track> Loading;
#pragma warning restore CS0067
    public SignalInfo Signal => null;
    public bool LastFailureWasDevice => false;
    public Track Track { get; private set; }
    public bool IsPlaying { get; private set; }
    public bool IsLoaded => Track != null;
    public DeviceCaps Caps => null;
    public double Position => 0;
    public Task LoadAsync(Track track, double seek, bool play) { Track = track; IsPlaying = play; return Task.CompletedTask; }
    public void Pause() => IsPlaying = false;
    public void Resume() => IsPlaying = true;
    public Task SeekAsync(double pos) => Task.CompletedTask;
    public void Stop() => IsPlaying = false;
    public Task ReconfigureAsync() => Task.CompletedTask;
    public void InvalidateNext() { }
    public void ApplyVolume() { }
    public void ApplyDsp() { }
    public (double l, double r, long clips, long underruns) Meter() => (0, 0, 0, 0);
    public void RefreshSignal() { }
    public void Dispose() { }
}
