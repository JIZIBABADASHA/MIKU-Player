using System;
using System.Buffers.Binary;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Linq;
using System.Runtime.InteropServices;
using NAudio.Wave;

namespace Miku.Audio;

public enum SampleFormat { Int16, Int24, Int32Valid24, Int32, Float32 }

public static class Formats
{
    static readonly Guid PcmGuid = new("00000001-0000-0010-8000-00aa00389b71");
    static readonly Guid FloatGuid = new("00000003-0000-0010-8000-00aa00389b71");

    public static int ContainerBits(SampleFormat f) => f switch { SampleFormat.Int16 => 16, SampleFormat.Int24 => 24, _ => 32 };
    public static int ValidBits(SampleFormat f) => f switch { SampleFormat.Int16 => 16, SampleFormat.Int24 => 24, SampleFormat.Int32Valid24 => 24, _ => 32 };
    public static bool IsInteger(SampleFormat f) => f != SampleFormat.Float32;

    public static string Describe(SampleFormat f) => f switch
    {
        SampleFormat.Int16 => "16-bit",
        SampleFormat.Int24 => "24-bit",
        SampleFormat.Int32Valid24 => "24-bit（32-bit 容器）",
        SampleFormat.Int32 => "32-bit",
        _ => "32-bit 浮點",
    };

    /// <summary>Build a WAVEFORMATEXTENSIBLE with an explicit sub-format and valid-bits field.</summary>
    public static WaveFormat Create(int rate, int channels, SampleFormat f)
    {
        int bits = ContainerBits(f), valid = ValidBits(f);
        byte[] b = new byte[40];
        BinaryPrimitives.WriteUInt16LittleEndian(b.AsSpan(0), 0xFFFE);
        BinaryPrimitives.WriteUInt16LittleEndian(b.AsSpan(2), (ushort)channels);
        BinaryPrimitives.WriteInt32LittleEndian(b.AsSpan(4), rate);
        BinaryPrimitives.WriteInt32LittleEndian(b.AsSpan(8), rate * channels * bits / 8);
        BinaryPrimitives.WriteUInt16LittleEndian(b.AsSpan(12), (ushort)(channels * bits / 8));
        BinaryPrimitives.WriteUInt16LittleEndian(b.AsSpan(14), (ushort)bits);
        BinaryPrimitives.WriteUInt16LittleEndian(b.AsSpan(16), 22);
        BinaryPrimitives.WriteUInt16LittleEndian(b.AsSpan(18), (ushort)valid);
        uint mask = channels switch { 1 => 4u, 2 => 3u, 4 => 0x33u, 6 => 0x3Fu, 8 => 0x63Fu, _ => (uint)((1L << channels) - 1) };
        BinaryPrimitives.WriteUInt32LittleEndian(b.AsSpan(20), mask);
        (f == SampleFormat.Float32 ? FloatGuid : PcmGuid).ToByteArray().CopyTo(b, 24);
        IntPtr p = Marshal.AllocHGlobal(40);
        try
        {
            Marshal.Copy(b, 0, p, 40);
            return WaveFormat.MarshalFromPtr(p);
        }
        finally { Marshal.FreeHGlobal(p); }
    }

    public static int Family(int rate) => rate % 11025 == 0 ? 44100 : 48000;
    public static readonly int[] ProbeRates = { 44100, 48000, 88200, 96000, 176400, 192000, 352800, 384000, 705600, 768000 };
    public static readonly SampleFormat[] Preference = { SampleFormat.Int32, SampleFormat.Int32Valid24, SampleFormat.Int24, SampleFormat.Int16, SampleFormat.Float32 };
}

public static class Ffmpeg
{
    static string _path, _probe;
    public static string Path => _path ??= Find("ffmpeg.exe");
    public static string ProbePath => _probe ??= Find("ffprobe.exe");
    public static bool Available => File.Exists(Path);

    static string Find(string exe)
    {
        var candidates = new List<string>
        {
            System.IO.Path.Combine(AppPaths.AppDir, exe),
            System.IO.Path.Combine(AppPaths.AppDir, "ffmpeg", exe),
            System.IO.Path.Combine(AppPaths.AppDir, "ffmpeg", "bin", exe),
        };
        foreach (var dir in (Environment.GetEnvironmentVariable("PATH") ?? "").Split(';', StringSplitOptions.RemoveEmptyEntries))
        {
            try { candidates.Add(System.IO.Path.Combine(dir.Trim().Trim('"'), exe)); } catch { }
        }
        string local = Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData);
        candidates.Add(System.IO.Path.Combine(local, "Microsoft", "WinGet", "Links", exe));
        candidates.Add(@"C:\ffmpeg\bin\" + exe);
        candidates.Add(@"C:\Program Files\ffmpeg\bin\" + exe);
        candidates.Add(System.IO.Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.UserProfile), "scoop", "shims", exe));
        candidates.Add(@"C:\ProgramData\chocolatey\bin\" + exe);
        foreach (var c in candidates) { try { if (File.Exists(c)) return c; } catch { } }
        // WinGet installs into a versioned package folder
        try
        {
            string pk = System.IO.Path.Combine(local, "Microsoft", "WinGet", "Packages");
            if (Directory.Exists(pk))
            {
                var hit = Directory.EnumerateFiles(pk, exe, SearchOption.AllDirectories).FirstOrDefault();
                if (hit != null) return hit;
            }
        }
        catch { }
        return exe;
    }

    public static Process Start(IEnumerable<string> args, string exe = null)
    {
        var psi = new ProcessStartInfo(exe ?? Path)
        {
            UseShellExecute = false,
            CreateNoWindow = true,
            RedirectStandardOutput = true,
            RedirectStandardError = true,
            RedirectStandardInput = false,
        };
        foreach (var a in args) psi.ArgumentList.Add(a);
        return Process.Start(psi);
    }
}
