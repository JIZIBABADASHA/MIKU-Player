using System;
using System.Collections.Generic;
using System.Threading;
using NAudio.Wave;

namespace Miku.Audio;

public sealed class Segment
{
    public long StartFrame;
    public Track Track;      // null = silence after the end of the queue
    public double Offset;    // seconds into the track at StartFrame
    public bool FromSeek;
}

/// <summary>
/// The provider handed to the output device. Pulls stereo doubles from the current source,
/// switches to the pre-loaded next source sample-accurately (gapless), runs DSP and converts
/// to the exact output sample format.
/// </summary>
public sealed class PlaybackChain : IWaveProvider
{
    public WaveFormat WaveFormat { get; }
    public int Rate { get; }
    public int OutChannels { get; }
    public SampleFormat Format { get; }
    public bool Dop { get; }
    public DspProcessor Dsp { get; }

    PcmSource _current, _next;
    readonly object _lock = new();
    readonly List<Segment> _segments = new();
    long _framesOut;
    double[] _work = new double[0];
    uint _rng = 0x9E3779B9;
    public long QuantizationClips;
    public long Underruns;
    public volatile bool Ended;

    public PlaybackChain(int rate, int outChannels, SampleFormat format, bool dop, DspConfig dsp, double gain, bool asio = false)
    {
        Rate = rate; OutChannels = outChannels; Format = format; Dop = dop;
        // ASIO's converter only understands plain PCM / IEEE float headers
        WaveFormat = !asio ? Formats.Create(rate, outChannels, format)
            : format == SampleFormat.Float32 ? WaveFormat.CreateIeeeFloatWaveFormat(rate, outChannels)
            : new WaveFormat(rate, Formats.ContainerBits(format), outChannels);
        Dsp = new DspProcessor(rate, dsp, gain) { ForceBypass = dop };
    }

    public long FramesOut => Interlocked.Read(ref _framesOut);
    public PcmSource Current { get { lock (_lock) return _current; } }
    public PcmSource Next { get { lock (_lock) return _next; } }

    /// <summary>Replace what is playing (track change or seek). Old sources are returned for disposal.</summary>
    public List<PcmSource> SetSource(PcmSource src, bool fromSeek)
    {
        var dead = new List<PcmSource>();
        lock (_lock)
        {
            if (_current != null) dead.Add(_current);
            if (_next != null) dead.Add(_next);
            _current = src; _next = null;
            Ended = false;
            _segments.Add(new Segment { StartFrame = _framesOut, Track = src.Track, Offset = src.StartOffset, FromSeek = fromSeek });
            Trim();
        }
        return dead;
    }

    public void SetNext(PcmSource src)
    {
        PcmSource old;
        lock (_lock) { old = _next; _next = src; }
        old?.Dispose();
    }

    public void ClearNext() => SetNext(null);

    void Trim()
    {
        if (_segments.Count > 16) _segments.RemoveRange(0, _segments.Count - 16);
    }

    /// <summary>Segment that is audible at the given played-frame position, and the latest one.</summary>
    public (Segment audible, Segment latest) SegmentAt(long playedFrames)
    {
        lock (_lock)
        {
            Segment audible = null;
            foreach (var s in _segments) if (s.StartFrame <= playedFrames) audible = s;
            audible ??= _segments.Count > 0 ? _segments[0] : null;
            return (audible, _segments.Count > 0 ? _segments[^1] : null);
        }
    }

    public int Read(byte[] buffer, int offset, int count)
    {
        int frames = count / WaveFormat.BlockAlign;
        if (frames <= 0) return 0;
        if (_work.Length < frames * 2) _work = new double[frames * 2];
        var work = _work;
        int filled = 0;
        List<PcmSource> finished = null;
        lock (_lock)
        {
            while (filled < frames)
            {
                var src = _current;
                if (src == null) break;
                int got = src.Read(work, filled * 2, frames - filled);
                filled += got;
                if (filled >= frames) break;
                if (src.IsEnded)
                {
                    (finished ??= new()).Add(src);
                    if (_next != null)
                    {
                        _current = _next; _next = null;
                        _segments.Add(new Segment { StartFrame = _framesOut + filled, Track = _current.Track, Offset = _current.StartOffset });
                        Trim();
                        continue;
                    }
                    _current = null;
                    _segments.Add(new Segment { StartFrame = _framesOut + filled, Track = null });
                    Ended = true;
                    break;
                }
                if (got == 0) { Underruns++; break; }
            }
        }
        // silence for whatever could not be filled
        if (filled < frames)
        {
            if (Dop) FillDopSilence(work, filled, frames);
            else Array.Clear(work, filled * 2, (frames - filled) * 2);
        }
        Dsp.Process(work, frames);
        bool dither = !Dsp.Bypassed && (Format == SampleFormat.Int16 || Format == SampleFormat.Int24 || Format == SampleFormat.Int32Valid24);
        Convert(work, frames, buffer, offset, dither);
        Interlocked.Add(ref _framesOut, frames);
        if (finished != null)
            foreach (var f in finished) ThreadPool.QueueUserWorkItem(_ => f.Dispose());
        return frames * WaveFormat.BlockAlign;
    }

    bool _silenceToggle;
    void FillDopSilence(double[] work, int from, int to)
    {
        for (int f = from; f < to; f++)
        {
            double v = DopSource.ToDouble(_silenceToggle ? 0xFA : 0x05, 0x69, 0x69);
            _silenceToggle = !_silenceToggle;
            work[2 * f] = v; work[2 * f + 1] = v;
        }
    }

    double Tpdf(double lsb)
    {
        _rng ^= _rng << 13; _rng ^= _rng >> 17; _rng ^= _rng << 5;
        double a = _rng / 4294967296.0;
        _rng ^= _rng << 13; _rng ^= _rng >> 17; _rng ^= _rng << 5;
        double b = _rng / 4294967296.0;
        return (a - b) * lsb;
    }

    unsafe void Convert(double[] work, int frames, byte[] buffer, int offset, bool dither)
    {
        int outCh = OutChannels;
        fixed (byte* basePtr = &buffer[offset])
        {
            switch (Format)
            {
                case SampleFormat.Int16:
                {
                    short* p = (short*)basePtr;
                    for (int f = 0; f < frames; f++)
                    {
                        for (int c = 0; c < outCh; c++)
                        {
                            double x = c < 2 ? work[2 * f + c] : 0;
                            if (x > 1 || x < -1) QuantizationClips++;
                            if (dither) x += Tpdf(1.0 / 32768);
                            double v = Math.Round(x * 32768.0);
                            p[f * outCh + c] = (short)(v > 32767 ? 32767 : v < -32768 ? -32768 : v);
                        }
                    }
                    break;
                }
                case SampleFormat.Int24:
                {
                    byte* p = basePtr;
                    for (int f = 0; f < frames; f++)
                    {
                        for (int c = 0; c < outCh; c++)
                        {
                            double x = c < 2 ? work[2 * f + c] : 0;
                            if (x > 1 || x < -1) QuantizationClips++;
                            if (dither) x += Tpdf(1.0 / 8388608);
                            double v = Math.Round(x * 8388608.0);
                            int i = (int)(v > 8388607 ? 8388607 : v < -8388608 ? -8388608 : v);
                            p[0] = (byte)i; p[1] = (byte)(i >> 8); p[2] = (byte)(i >> 16);
                            p += 3;
                        }
                    }
                    break;
                }
                case SampleFormat.Int32Valid24:
                {
                    int* p = (int*)basePtr;
                    for (int f = 0; f < frames; f++)
                    {
                        for (int c = 0; c < outCh; c++)
                        {
                            double x = c < 2 ? work[2 * f + c] : 0;
                            if (x > 1 || x < -1) QuantizationClips++;
                            if (dither) x += Tpdf(1.0 / 8388608);
                            double v = Math.Round(x * 8388608.0);
                            int i = (int)(v > 8388607 ? 8388607 : v < -8388608 ? -8388608 : v);
                            p[f * outCh + c] = i << 8;
                        }
                    }
                    break;
                }
                case SampleFormat.Int32:
                {
                    int* p = (int*)basePtr;
                    for (int f = 0; f < frames; f++)
                    {
                        for (int c = 0; c < outCh; c++)
                        {
                            double x = c < 2 ? work[2 * f + c] : 0;
                            if (x > 1 || x < -1) QuantizationClips++;
                            double v = Math.Round(x * 2147483648.0);
                            p[f * outCh + c] = (int)(v > 2147483647.0 ? 2147483647.0 : v < -2147483648.0 ? -2147483648.0 : v);
                        }
                    }
                    break;
                }
                default:
                {
                    float* p = (float*)basePtr;
                    for (int f = 0; f < frames; f++)
                        for (int c = 0; c < outCh; c++)
                            p[f * outCh + c] = c < 2 ? (float)work[2 * f + c] : 0f;
                    break;
                }
            }
        }
    }

    public void DisposeSources()
    {
        lock (_lock)
        {
            _current?.Dispose(); _next?.Dispose();
            _current = null; _next = null;
        }
    }
}
