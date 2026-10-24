using System.Reflection;
using System.Runtime.InteropServices;
using DaphneMiku;
using Miku;

static class LifetimeCheck
{
    [DllImport("daphne_core")] static extern void test_reset();
    [DllImport("daphne_core")] static extern void test_block_state();
    [DllImport("daphne_core")] static extern int test_wait_entered();
    [DllImport("daphne_core")] static extern void test_release();
    [DllImport("daphne_core")] static extern int test_destroy_count();
    [DllImport("daphne_core")] static extern int test_destroyed_busy();
    [DllImport("daphne_core")] static extern int test_next_count();
    [DllImport("daphne_core")] static extern int test_load_count();
    static int checks;
    static void Assert(bool value, string message) { if (!value) throw new Exception(message); checks++; }

    static async Task Main(string[] args)
    {
        if (args.Contains("--real")) { await RealNative(); return; }
        // Initialize the actual native wrapper's resolver before any test P/Invoke.
        using (var warmup = DaphneNative.dc_create()) { }
        // Reproduce the former timeout-then-destroy order against the tombstone ABI only.
        // This demonstrates the race without dereferencing genuinely freed native memory.
        test_reset();
        var originalOrder = DaphneNative.dc_create();
        test_block_state();
        var originalCall = Task.Run(() => DaphneNative.State(originalOrder));
        Assert(test_wait_entered() == 1, "Baseline native call did not enter");
        try
        {
            Assert(!originalCall.Wait(500), "Baseline call must still be active after the former join timeout");
            DaphneNative.dc_destroy(originalOrder.DangerousGetHandle());
            Assert(test_destroyed_busy() == 1, "Former destruction race was not reproduced");
        }
        finally { originalOrder.SetHandleAsInvalid(); test_release(); }
        await originalCall;
        Console.WriteLine("Reproduced former 500 ms timeout order: native player destroyed during an active call (test ABI).");

        test_reset();
        var handle = DaphneNative.dc_create();
        test_block_state();
        var state = Task.Run(() => DaphneNative.State(handle));
        Assert(test_wait_entered() == 1, "Native call did not enter");
        try
        {
            handle.Dispose();
            handle.Dispose();
            Assert(test_destroy_count() == 0, "Player destroyed during an active P/Invoke");
        }
        finally { test_release(); }
        Assert((await state.WaitAsync(TimeSpan.FromSeconds(5))).Contains("report"), "Active call did not complete");
        Assert(test_destroy_count() == 1 && test_destroyed_busy() == 0, "Native player not safely released exactly once");
        bool rejected = false;
        try { DaphneNative.State(handle); } catch (ObjectDisposedException) { rejected = true; }
        Assert(rejected, "Closed handle entered native code");

        test_reset();
        using (var pooled = DaphneNative.dc_create())
        {
            for (int i = 0; i < 20; i++) DaphneNative.PollEvent(pooled);
            long start = GC.GetAllocatedBytesForCurrentThread();
            bool empty = true;
            for (int i = 0; i < 1000; i++) empty &= DaphneNative.PollEvent(pooled) == null;
            long bytes = GC.GetAllocatedBytesForCurrentThread() - start;
            Assert(empty, "Empty poll changed");
            Assert(bytes < 1_000_000, "Polling still allocates a 16 KiB buffer per call");
            Console.WriteLine($"1000 empty polls: {bytes:N0} managed allocated bytes (previous buffer arrays alone: 16,384,000 bytes)");
        }

        for (int attempt = 0; attempt < 25; attempt++)
        {
            test_reset();
            var raced = DaphneNative.dc_create();
            var workers = Enumerable.Range(0, 8).Select(_ => Task.Run(() =>
            {
                for (int i = 0; i < 100; i++)
                    try { DaphneNative.State(raced); } catch (ObjectDisposedException) { break; }
            })).ToArray();
            raced.Dispose();
            await Task.WhenAll(workers).WaitAsync(TimeSpan.FromSeconds(5));
            if (test_destroy_count() != 1 || test_destroyed_busy() != 0) throw new Exception("Concurrent polling/disposal released the player unsafely");
        }
        Assert(true, "Concurrent polling/disposal completed safely");

        test_reset();
        var engine = new DaphneEngine(new Settings(), a => a(), new DaphneOptions());
        engine.InvalidateNext();
        Assert(test_next_count() == 0, "Unloaded/loading engine sent a blocking native gapless command");
        var gate = (SemaphoreSlim)typeof(DaphneEngine).GetField("_gate", BindingFlags.Instance | BindingFlags.NonPublic)!.GetValue(engine)!;
        await gate.WaitAsync();
        var queued = engine.LoadAsync(new Track { Id = "queued", Path = "unused.flac" }, 0, false);
        engine.Dispose();
        engine.Dispose();
        gate.Release();
        await queued.WaitAsync(TimeSpan.FromSeconds(5));
        Assert(test_load_count() == 0, "A queued load entered the native core after disposal");
        Assert(test_destroy_count() == 1, "Engine disposal released its native player more than once");
        Assert(!engine.IsPlaying && !engine.IsLoaded, "Disposed engine still reports playback active");
        engine.Pause(); engine.Resume(); engine.Stop(); engine.InvalidateNext();
        engine.ApplyVolume(); engine.ApplyDsp(); engine.RefreshSignal();
        await engine.SeekAsync(10); await engine.ReconfigureAsync();
        Assert(engine.Meter() == (0d, 0d, 0L, 0L), "Disposed engine accessed native meters");
        Console.WriteLine($"PASS: {checks} Daphne lifetime/allocation assertions (test native ABI; no audio output).");
    }

    static async Task RealNative()
    {
        for (int attempt = 0; attempt < 25; attempt++)
        {
            var handle = DaphneNative.dc_create();
            Assert(!handle.IsInvalid && DaphneNative.State(handle) != null, "Real native player did not initialize");
            var readers = Enumerable.Range(0, 4).Select(_ => Task.Run(() =>
            {
                for (int i = 0; i < 200; i++)
                    try { DaphneNative.State(handle); } catch (ObjectDisposedException) { break; }
            })).ToArray();
            await Task.Yield();
            handle.Dispose(); handle.Dispose();
            await Task.WhenAll(readers).WaitAsync(TimeSpan.FromSeconds(10));
            Assert(handle.IsClosed, "Real player handle did not close");
        }
        var engine = new DaphneEngine(new Settings(), a => a(), new DaphneOptions());
        engine.InvalidateNext();
        engine.Dispose(); engine.Dispose();
        await engine.LoadAsync(new Track { Id = "closed", Path = "unused.flac" }, 0, false);
        Assert(!engine.IsLoaded && !engine.IsPlaying, "Real disposed engine restarted");
        Console.WriteLine("PASS: 25 real Daphne native create/poll/dispose cycles and disposed-engine guard (no files loaded or audio output).");
    }
}
