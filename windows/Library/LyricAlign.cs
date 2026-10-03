using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Threading.Tasks;
using Miku.Audio;

namespace Miku.Library;

/// <summary>
/// Estimates a constant time offset between a song and its synced lyrics.
/// The audio is decoded to 8 kHz mono, band-passed to the vocal range (200–3500 Hz), and turned into an
/// onset-strength curve (how fast vocal-band energy rises). Every lyric line start is a moment where singing
/// should begin, so we slide the line starts over that curve and keep the shift where they line up best.
/// Only timestamps are used — the lyric text never matters.
/// </summary>
public static class LyricAlign
{
    const int Rate = 8000;
    const double Hop = 0.02;          // 20 ms analysis frames
    const double MaxShift = 12;       // search ±12 s

    public sealed class Result
    {
        public double Offset { get; set; }      // value for Settings.LyricOffsets (line shown at t - offset)
        public double Confidence { get; set; }  // peak score / typical score; < ~1.25 means "don't trust it"
        public bool Ok => Confidence >= 1.25;
    }

    public static async Task<Result> Estimate(Track track, IReadOnlyList<double> lineStarts)
    {
        var starts = lineStarts.Where(t => t > 0).Distinct().OrderBy(t => t).ToList();
        if (starts.Count < 4 || !Ffmpeg.Available) return null;

        float[] pcm = await Decode(track.Path);
        if (pcm == null || pcm.Length < Rate * 10) return null;
        double[] onset = Onsets(pcm);
        int frames = onset.Length;

        // Score each candidate shift: sum of onset strength in a small window around every shifted line start.
        int maxS = (int)(MaxShift / Hop), win = 4; // ±80 ms
        var scores = new double[2 * maxS + 1];
        for (int si = -maxS; si <= maxS; si++)
        {
            double sum = 0;
            foreach (var t in starts)
            {
                int c = (int)Math.Round(t / Hop) + si;
                if (c < 0 || c >= frames) continue;
                double best = 0;
                for (int k = Math.Max(0, c - win); k <= Math.Min(frames - 1, c + win); k++) best = Math.Max(best, onset[k]);
                sum += best;
            }
            scores[si + maxS] = sum;
        }
        int bi = 0;
        for (int i = 1; i < scores.Length; i++) if (scores[i] > scores[bi]) bi = i;
        var sorted = scores.OrderBy(x => x).ToArray();
        double median = sorted[sorted.Length / 2];
        double shift = (bi - maxS) * Hop;       // singing actually starts at lineTime + shift
        return new Result { Offset = Math.Round(-shift, 2), Confidence = median > 0 ? scores[bi] / median : 0 };
    }

    static async Task<float[]> Decode(string path)
    {
        using var p = Ffmpeg.Start(new[] { "-v", "error", "-nostdin", "-i", path, "-vn", "-ac", "1", "-ar", Rate.ToString(),
            "-af", "highpass=f=200,lowpass=f=3500", "-f", "f32le", "-" });
        _ = p.StandardError.ReadToEndAsync(); // drain so ffmpeg never blocks
        using var ms = new MemoryStream();
        await p.StandardOutput.BaseStream.CopyToAsync(ms);
        await p.WaitForExitAsync();
        var bytes = ms.GetBuffer();
        int n = (int)(ms.Length / 4);
        var f = new float[n];
        Buffer.BlockCopy(bytes, 0, f, 0, n * 4);
        return f;
    }

    /// <summary>Log-energy per 20 ms frame → half-wave-rectified rise, normalised.</summary>
    static double[] Onsets(float[] pcm)
    {
        int hop = (int)(Rate * Hop), frameLen = hop * 2;
        int frames = (pcm.Length - frameLen) / hop;
        var e = new double[frames];
        for (int i = 0; i < frames; i++)
        {
            double s = 0; int o = i * hop;
            for (int k = 0; k < frameLen; k++) { double v = pcm[o + k]; s += v * v; }
            e[i] = Math.Log10(1e-9 + s / frameLen);
        }
        // rise over ~100 ms, compared with a local moving average so steady loud parts don't dominate
        var on = new double[frames];
        for (int i = 5; i < frames; i++) on[i] = Math.Max(0, e[i] - e[i - 5]);
        int avg = 50; double run = 0;
        var outp = new double[frames];
        for (int i = 0; i < frames; i++)
        {
            run += on[i]; if (i >= avg) run -= on[i - avg];
            double mean = run / Math.Min(i + 1, avg);
            outp[i] = Math.Max(0, on[i] - mean);
        }
        double max = outp.Max();
        if (max > 0) for (int i = 0; i < frames; i++) outp[i] /= max;
        return outp;
    }
}
