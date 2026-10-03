using System;
using System.Buffers.Binary;
using System.Collections.Generic;
using System.Diagnostics;
using System.Globalization;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;

namespace Miku.Audio;

/// <summary>
/// A decoded audio stream (always interleaved stereo doubles in [-1, 1)) fed by a background
/// producer thread into a ring buffer so the real-time audio callback never waits on I/O.
/// </summary>
public abstract class PcmSource : IDisposable
{
    public const int Channels = 2;
    public Track Track { get; }
    public double StartOffset { get; }
    public int Rate { get; protected set; }
    public double Gain { get; set; } = 1.0;
    public string Error { get; protected set; }
    public virtual string DecoderName => Track.IsLive ? "WebView 音訊" : Track.IsDsd ? "MIKU 既有 DoP 封裝" : "FFmpeg";
    public virtual string ResamplerName => null;
    public virtual long OverloadSamples => 0;
    public virtual double ResamplerPeak => 0;
    public virtual bool ResamplingMeterAvailable => false;

    readonly object _lock = new();
    double[] _ring;
    long _written, _read;
    volatile bool _eof, _disposed;
    Thread _thread;

    protected PcmSource(Track track, double startOffset, int rate)
    {
        Track = track; StartOffset = startOffset; Rate = rate;
    }

    protected void StartProducer(double bufferSeconds = 3)
    {
        _ring = new double[(int)(Rate * Channels * bufferSeconds)];
        _thread = new Thread(ProducerLoop) { IsBackground = true, Name = "Miku decoder", Priority = ThreadPriority.AboveNormal };
        _thread.Start();
    }

    /// <summary>Fill buffer with up to buffer.Length/2 stereo frames. Return frames produced, 0 at end of stream.</summary>
    protected abstract int Produce(double[] buffer);

    void ProducerLoop()
    {
        var tmp = new double[8192 * Channels];
        try
        {
            while (!_disposed)
            {
                int frames = Produce(tmp);
                if (frames <= 0) break;
                Write(tmp, frames * Channels);
            }
        }
        catch (Exception ex)
        {
            if (!_disposed) { Error = ex.Message; Log.Error("Decoder", ex); }
        }
        finally
        {
            _eof = true;
            lock (_lock) Monitor.PulseAll(_lock);
        }
    }

    void Write(double[] src, int count)
    {
        int offset = 0;
        while (count > 0 && !_disposed)
        {
            lock (_lock)
            {
                int free;
                while ((free = _ring.Length - (int)(_written - _read)) == 0 && !_disposed) Monitor.Wait(_lock, 100);
                if (_disposed) return;
                int n = Math.Min(free, count);
                int pos = (int)(_written % _ring.Length);
                int first = Math.Min(n, _ring.Length - pos);
                Array.Copy(src, offset, _ring, pos, first);
                if (n > first) Array.Copy(src, offset + first, _ring, 0, n - first);
                _written += n; offset += n; count -= n;
                Monitor.PulseAll(_lock);
            }
        }
    }

    public double BufferedSeconds { get { lock (_lock) return (_written - _read) / (double)(Rate * Channels); } }
    public bool ProducerFinished => _eof;
    protected bool Disposed => _disposed;

    /// <summary>Drop the oldest buffered audio so at most `seconds` remain (keeps live latency low).</summary>
    protected void TrimTo(double seconds)
    {
        lock (_lock)
        {
            long keep = (long)(seconds * Rate) * Channels;
            if (_written - _read > keep) _read = _written - keep;
        }
    }
    public bool IsEnded { get { if (!_eof) return false; lock (_lock) return _written == _read; } }

    /// <summary>Called from the audio thread. Never blocks for long.</summary>
    public int Read(double[] dst, int dstOffset, int frames)
    {
        lock (_lock)
        {
            int avail = (int)((_written - _read) / Channels);
            int n = Math.Min(avail, frames);
            if (n <= 0) return 0;
            int count = n * Channels;
            int pos = (int)(_read % _ring.Length);
            int first = Math.Min(count, _ring.Length - pos);
            Array.Copy(_ring, pos, dst, dstOffset, first);
            if (count > first) Array.Copy(_ring, 0, dst, dstOffset + first, count - first);
            _read += count;
            Monitor.PulseAll(_lock);
            if (Gain != 1.0)
            {
                double g = Gain;
                for (int i = dstOffset, e = dstOffset + count; i < e; i++) dst[i] *= g;
            }
            return n;
        }
    }

    /// <summary>Wait until enough audio is decoded to start without an underrun.</summary>
    public bool WaitPrefill(double seconds, int timeoutMs)
    {
        var sw = Stopwatch.StartNew();
        lock (_lock)
        {
            while (!_eof && (_written - _read) < seconds * Rate * Channels && sw.ElapsedMilliseconds < timeoutMs)
                Monitor.Wait(_lock, 20);
            return _written > _read || _eof;
        }
    }

    public virtual void Dispose()
    {
        _disposed = true;
        lock (_lock) Monitor.PulseAll(_lock);
    }
}

/// <summary>Decodes any format FFmpeg understands into 64-bit float PCM, optionally resampling with SoX VHQ.</summary>
public sealed class FfmpegSource : PcmSource
{
    readonly Process _proc;
    readonly Stream _out;
    readonly StringBuilder _stderr = new();
    readonly byte[] _bytes = new byte[8192 * Channels * 8];
    int _carry;
    readonly bool _resample;
    long _overloadSamples;
    double _resamplerPeak;
    public override string ResamplerName => _resample ? "FFmpeg / SoX" : null;
    public override bool ResamplingMeterAvailable => _resample;
    public override long OverloadSamples => Interlocked.Read(ref _overloadSamples);
    public override double ResamplerPeak => Volatile.Read(ref _resamplerPeak);

    public FfmpegSource(Track track, double seek, int outRate, bool resample, double gain = 1) : base(track, seek, outRate)
    {
        Gain = gain;
        _resample = resample;
        var args = new List<string> { "-nostdin", "-hide_banner", "-loglevel", "error" };
        if (seek > 0.01) { args.Add("-ss"); args.Add(seek.ToString("0.000", CultureInfo.InvariantCulture)); }
        args.AddRange(new[] { "-i", track.Path, "-map", "0:a:0", "-vn", "-sn", "-dn" });
        // 1 dB of headroom when resampling: the band-limited reconstruction can overshoot 0 dBFS (inter-sample peaks)
        if (resample) { args.Add("-af"); args.Add($"volume=-1dB:precision=double,aresample={outRate}:resampler=soxr:precision=28:cheby=1"); }
        args.AddRange(new[] { "-ac", "2", "-c:a", "pcm_f64le", "-f", "f64le", "pipe:1" });
        _proc = Ffmpeg.Start(args);
        if (_proc == null) throw new IOException("無法啟動 FFmpeg");
        try { _proc.PriorityClass = ProcessPriorityClass.AboveNormal; } catch { }
        _out = _proc.StandardOutput.BaseStream;
        _proc.ErrorDataReceived += (_, e) => { if (e.Data != null) lock (_stderr) _stderr.AppendLine(e.Data); };
        _proc.BeginErrorReadLine();
        StartProducer();
    }

    protected override int Produce(double[] buffer)
    {
        int frameBytes = Channels * 8;
        int maxBytes = Math.Min(_bytes.Length, buffer.Length * 8);
        while (true)
        {
            int n = _out.Read(_bytes, _carry, maxBytes - _carry);
            if (n <= 0)
            {
                _proc.WaitForExit(2000);
                if (_proc.HasExited && _proc.ExitCode != 0)
                {
                    string err; lock (_stderr) err = _stderr.ToString().Trim();
                    Error = string.IsNullOrEmpty(err) ? "解碼失敗 (FFmpeg " + _proc.ExitCode + ")" : err;
                }
                return 0;
            }
            int total = _carry + n;
            int whole = total / frameBytes * frameBytes;
            if (whole == 0) { _carry = total; continue; }
            var src = MemoryMarshal.Cast<byte, double>(_bytes.AsSpan(0, whole));
            src.CopyTo(buffer);
            // Observe FFmpeg's output after its existing SRC/headroom and before ReplayGain/DSP.
            // The decoder reads ahead; these are accumulated decoded-sample statistics, not a DAC meter.
            if (_resample)
            {
                long overloads = 0;
                double peak = Volatile.Read(ref _resamplerPeak);
                foreach (double sample in src)
                {
                    double magnitude = Math.Abs(sample);
                    if (!double.IsFinite(magnitude)) continue;
                    peak = Math.Max(peak, magnitude);
                    if (magnitude > 1) overloads++;
                }
                Interlocked.Add(ref _overloadSamples, overloads);
                Volatile.Write(ref _resamplerPeak, peak);
            }
            _carry = total - whole;
            if (_carry > 0) Buffer.BlockCopy(_bytes, whole, _bytes, 0, _carry);
            return whole / frameBytes;
        }
    }

    public override void Dispose()
    {
        base.Dispose();
        try { if (!_proc.HasExited) _proc.Kill(true); } catch { }
        try { _out.Dispose(); } catch { }
        try { _proc.Dispose(); } catch { }
    }
}

/// <summary>Native DSD header information for DSF and DSDIFF (DFF) files.</summary>
public sealed class DsdInfo
{
    public bool Dff;
    public int Rate;          // DSD bit rate per channel, e.g. 2822400
    public int Channels;
    public long DataOffset;   // first byte of audio data
    public long DataBytesPerChannel;
    public int BlockSize;     // DSF only
    public bool LsbFirst;     // DSF bits per sample == 1
    public bool Compressed;   // DFF DST
    public long Id3Offset;    // -1 if none
    public long Id3Length;
    public double Duration => Rate > 0 ? DataBytesPerChannel * 8.0 / Rate : 0;
    public int Multiple => Rate / 44100 / 64; // 1 = DSD64

    public static DsdInfo Read(string path)
    {
        using var fs = new FileStream(path, FileMode.Open, FileAccess.Read, FileShare.ReadWrite, 4096);
        var br = new BinaryReader(fs);
        string magic = Encoding.ASCII.GetString(br.ReadBytes(4));
        return magic switch
        {
            "DSD " => ReadDsf(fs, br),
            "FRM8" => ReadDff(fs, br),
            _ => throw new InvalidDataException("不是 DSF/DFF 檔案"),
        };
    }

    static DsdInfo ReadDsf(FileStream fs, BinaryReader br)
    {
        var info = new DsdInfo { Id3Offset = -1 };
        br.ReadInt64(); // chunk size (28)
        br.ReadInt64(); // total file size
        long meta = br.ReadInt64();
        if (Encoding.ASCII.GetString(br.ReadBytes(4)) != "fmt ") throw new InvalidDataException("DSF fmt chunk 缺失");
        long fmtSize = br.ReadInt64();
        br.ReadInt32(); // version
        br.ReadInt32(); // format id (0 = raw)
        br.ReadInt32(); // channel type
        info.Channels = br.ReadInt32();
        info.Rate = br.ReadInt32();
        int bps = br.ReadInt32();
        long sampleCount = br.ReadInt64();
        info.BlockSize = br.ReadInt32();
        fs.Position = 28 + fmtSize; // DSD chunk (28 bytes) + fmt chunk
        if (Encoding.ASCII.GetString(br.ReadBytes(4)) != "data") throw new InvalidDataException("DSF data chunk 缺失");
        br.ReadInt64();
        info.DataOffset = fs.Position;
        info.LsbFirst = bps == 1;
        info.DataBytesPerChannel = (sampleCount + 7) / 8;
        if (meta > 0 && meta < fs.Length) { info.Id3Offset = meta; info.Id3Length = fs.Length - meta; }
        return info;
    }

    static long BE64(BinaryReader br) => BinaryPrimitives.ReadInt64BigEndian(br.ReadBytes(8));
    static int BE32(BinaryReader br) => BinaryPrimitives.ReadInt32BigEndian(br.ReadBytes(4));
    static short BE16(BinaryReader br) => BinaryPrimitives.ReadInt16BigEndian(br.ReadBytes(2));

    static DsdInfo ReadDff(FileStream fs, BinaryReader br)
    {
        var info = new DsdInfo { Dff = true, Id3Offset = -1 };
        long frmSize = BE64(br);
        br.ReadBytes(4); // "DSD "
        long end = Math.Min(fs.Length, 12 + frmSize);
        while (fs.Position + 12 <= end)
        {
            string id = Encoding.ASCII.GetString(br.ReadBytes(4));
            long size = BE64(br);
            long start = fs.Position;
            switch (id)
            {
                case "PROP":
                    br.ReadBytes(4); // "SND "
                    long propEnd = start + size;
                    while (fs.Position + 12 <= propEnd)
                    {
                        string sid = Encoding.ASCII.GetString(br.ReadBytes(4));
                        long ssize = BE64(br);
                        long sstart = fs.Position;
                        if (sid == "FS  ") info.Rate = BE32(br);
                        else if (sid == "CHNL") info.Channels = BE16(br);
                        else if (sid == "CMPR") info.Compressed = Encoding.ASCII.GetString(br.ReadBytes(4)) != "DSD ";
                        fs.Position = sstart + ssize + (ssize & 1);
                    }
                    break;
                case "DSD ":
                    info.DataOffset = start;
                    info.DataBytesPerChannel = info.Channels > 0 ? size / info.Channels : size / 2;
                    break;
                case "DST ":
                    info.Compressed = true;
                    info.DataOffset = start;
                    break;
                case "ID3 ":
                    info.Id3Offset = start; info.Id3Length = size;
                    break;
            }
            fs.Position = start + size + (size & 1);
        }
        if (info.Rate == 0 || info.Channels == 0) throw new InvalidDataException("DFF 標頭不完整");
        if (info.Compressed && info.DataBytesPerChannel == 0)
        {
            // DST: estimate duration from frame info is complex; leave 0 and let FFmpeg probe it.
        }
        return info;
    }
}

/// <summary>Streams native DSD as DoP (DSD over PCM, 24-bit words with 0x05/0xFA markers).</summary>
public sealed class DopSource : PcmSource
{
    static readonly byte[] Reverse = BuildReverse();
    static byte[] BuildReverse()
    {
        var t = new byte[256];
        for (int i = 0; i < 256; i++)
        {
            int r = 0;
            for (int b = 0; b < 8; b++) if ((i & (1 << b)) != 0) r |= 1 << (7 - b);
            t[i] = (byte)r;
        }
        return t;
    }

    readonly DsdInfo _info;
    readonly FileStream _fs;
    long _bytePos;        // per channel byte position (even)
    bool _markerToggle;
    readonly byte[] _block;
    readonly byte[] _l, _r;

    public static int DopRate(DsdInfo info) => info.Rate / 16;

    public DopSource(Track track, DsdInfo info, double seek) : base(track, seek, info.Rate / 16)
    {
        if (info.Channels != 2) throw new NotSupportedException("DoP 目前只支援雙聲道 DSD");
        _info = info;
        _fs = new FileStream(track.Path, FileMode.Open, FileAccess.Read, FileShare.ReadWrite, 1 << 16);
        long start = (long)(seek * info.Rate / 8);
        start -= start % 2;
        if (!info.Dff) start -= start % info.BlockSize;
        _bytePos = Math.Clamp(start, 0, info.DataBytesPerChannel);
        int chunk = info.Dff ? 16384 : info.BlockSize;
        _block = new byte[chunk * 2];
        _l = new byte[chunk];
        _r = new byte[chunk];
        StartProducer(2);
    }

    protected override int Produce(double[] buffer)
    {
        long remaining = _info.DataBytesPerChannel - _bytePos;
        if (remaining <= 1) return 0;
        int perCh;
        if (_info.Dff)
        {
            perCh = (int)Math.Min(Math.Min(_l.Length, remaining), buffer.Length);
            perCh -= perCh % 2;
            _fs.Position = _info.DataOffset + _bytePos * 2;
            int got = ReadFully(_block, perCh * 2);
            perCh = got / 2; perCh -= perCh % 2;
            for (int i = 0; i < perCh; i++) { _l[i] = _block[2 * i]; _r[i] = _block[2 * i + 1]; }
        }
        else
        {
            int bs = _info.BlockSize;
            long blockIndex = _bytePos / bs;
            _fs.Position = _info.DataOffset + blockIndex * bs * 2;
            int got = ReadFully(_block, bs * 2);
            if (got < bs * 2) return 0;
            perCh = (int)Math.Min(bs, remaining);
            perCh -= perCh % 2;
            if (_info.LsbFirst)
                for (int i = 0; i < perCh; i++) { _l[i] = Reverse[_block[i]]; _r[i] = Reverse[_block[bs + i]]; }
            else
            {
                Buffer.BlockCopy(_block, 0, _l, 0, perCh);
                Buffer.BlockCopy(_block, bs, _r, 0, perCh);
            }
        }
        if (perCh <= 0) return 0;
        int frames = Math.Min(perCh / 2, buffer.Length / 2);
        for (int f = 0; f < frames; f++)
        {
            int marker = _markerToggle ? 0xFA : 0x05;
            _markerToggle = !_markerToggle;
            buffer[2 * f] = ToDouble(marker, _l[2 * f], _l[2 * f + 1]);
            buffer[2 * f + 1] = ToDouble(marker, _r[2 * f], _r[2 * f + 1]);
        }
        _bytePos += frames * 2;
        return frames;
    }

    public static double ToDouble(int marker, int b1, int b2)
    {
        int word = (marker << 16) | (b1 << 8) | b2;
        if ((word & 0x800000) != 0) word -= 0x1000000;
        return word / 8388608.0;
    }

    int ReadFully(byte[] buf, int count)
    {
        int total = 0;
        while (total < count)
        {
            int n = _fs.Read(buf, total, count - total);
            if (n <= 0) break;
            total += n;
        }
        return total;
    }

    public override void Dispose()
    {
        base.Dispose();
        try { _fs.Dispose(); } catch { }
    }
}
