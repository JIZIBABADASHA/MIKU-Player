using System;
using System.Threading;

namespace Miku.Audio;

/// <summary>
/// Shared memory written by the YouTube Music page (Web Audio tap) and read by the engine.
/// Layout: uint32 write index (frames, wraps) | 12 bytes reserved | float32 stereo ring.
/// </summary>
public static class LiveBus
{
    public const int Rate = 48000;
    public static IntPtr Ptr;
    public static int CapFrames;
    public static bool Ready => Ptr != IntPtr.Zero && CapFrames > 0;
    /// <summary>Actual sample rate of the page's AudioContext (reported by the page).</summary>
    public static volatile int SourceRate = Rate;
    // diagnostics
    public static double Fill, Adj;
    public static int Resyncs, Starves;
}

/// <summary>
/// Streams the captured YouTube Music audio into the playback chain.
/// The browser and the DAC run on different clocks and the page delivers audio in irregular bursts,
/// so this keeps a jitter buffer of ~300 ms and gently adjusts the resampling ratio (at most ±0.3 %)
/// to hold it there. No samples are ever dropped or repeated, so there are no clicks.
/// </summary>
public sealed unsafe class LiveSource : PcmSource
{
    const double Target = 0.30;      // seconds of buffered audio we aim for
    const double Overflow = 1.2;     // beyond this something stalled: resynchronise once

    uint _read;          // integer read position in the shared ring (frames)
    double _frac;        // fractional position between _read and _read + 1
    bool _synced, _primed;
    double _adj;         // smoothed rate correction
    readonly int _outRate;

    public LiveSource(Track track, int outRate) : base(track, 0, outRate)
    {
        _outRate = outRate;
        StartProducer(1.5);
    }

    protected override int Produce(double[] buffer)
    {
        while (!Disposed)
        {
            if (!LiveBus.Ready) { Thread.Sleep(20); continue; }
            uint* hdr = (uint*)LiveBus.Ptr;
            float* ring = (float*)((byte*)LiveBus.Ptr + 16);
            uint cap = (uint)LiveBus.CapFrames;
            uint w = Volatile.Read(ref *hdr);

            if (!_synced || w < _read || w - _read > cap - 4096)
            {
                // first read, page reloaded, or the writer lapped us: restart close to the writer
                if (_synced) LiveBus.Resyncs++;
                _read = w; _frac = 0; _synced = true; _primed = false; _adj = 0;
                continue;
            }
            int avail = (int)(w - _read);
            if (!_primed)
            {
                if (avail < Target * LiveBus.SourceRate) { Thread.Sleep(5); continue; }
                _primed = true;
            }
            double fill = avail / (double)LiveBus.SourceRate + BufferedSeconds;
            LiveBus.Fill = fill;
            if (fill > Overflow)
            {
                LiveBus.Resyncs++;
                _read = w - (uint)(Target * LiveBus.SourceRate); _frac = 0; _adj = 0;
                TrimTo(0.05);
                continue;
            }
            if (avail < 4) { if (BufferedSeconds < 0.02) LiveBus.Starves++; Thread.Sleep(3); continue; }

            // proportional control of the buffer level through a tiny rate change
            double err = fill - Target;
            double want = Math.Clamp(err * 0.02, -0.005, 0.005);
            _adj += (want - _adj) * 0.02;
            LiveBus.Adj = _adj;
            double step = (double)LiveBus.SourceRate / _outRate * (1 + _adj);

            int maxFrames = buffer.Length / 2;
            int produced = 0;
            while (produced < maxFrames)
            {
                int i0 = (int)_frac;
                if (i0 + 2 >= avail) break;
                double t = _frac - i0;
                uint b = _read + (uint)i0;
                int pm = (int)((b - 1) % cap) * 2, p0 = (int)(b % cap) * 2, p1 = (int)((b + 1) % cap) * 2, p2 = (int)((b + 2) % cap) * 2;
                buffer[2 * produced] = Hermite(ring[pm], ring[p0], ring[p1], ring[p2], t);
                buffer[2 * produced + 1] = Hermite(ring[pm + 1], ring[p0 + 1], ring[p1 + 1], ring[p2 + 1], t);
                produced++;
                _frac += step;
            }
            int whole = (int)_frac;
            _read += (uint)whole;
            _frac -= whole;
            avail -= whole;
            if (produced > 0) return produced;
            Thread.Sleep(3);
        }
        return 0;
    }

    /// <summary>4-point, 3rd-order Hermite interpolation.</summary>
    static double Hermite(double xm1, double x0, double x1, double x2, double t)
    {
        double c1 = 0.5 * (x1 - xm1);
        double c2 = xm1 - 2.5 * x0 + 2 * x1 - 0.5 * x2;
        double c3 = 0.5 * (x2 - xm1) + 1.5 * (x0 - x1);
        return ((c3 * t + c2) * t + c1) * t + x0;
    }
}
