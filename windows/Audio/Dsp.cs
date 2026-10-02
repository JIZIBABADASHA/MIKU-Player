using System;
using System.Collections.Generic;
using System.Linq;
using System.Threading;

namespace Miku.Audio;

public sealed class Biquad
{
    public readonly double B0, B1, B2, A1, A2;
    double _z1L, _z2L, _z1R, _z2R;

    Biquad(double b0, double b1, double b2, double a0, double a1, double a2)
    {
        B0 = b0 / a0; B1 = b1 / a0; B2 = b2 / a0; A1 = a1 / a0; A2 = a2 / a0;
    }

    public static Biquad Create(EqBand band, int rate)
    {
        double f = Math.Clamp(band.Fc, 5, rate * 0.49);
        double q = Math.Clamp(band.Q <= 0 ? 0.707 : band.Q, 0.05, 40);
        double A = Math.Pow(10, band.Gain / 40.0);
        double w = 2 * Math.PI * f / rate, c = Math.Cos(w), s = Math.Sin(w);
        double alpha = s / (2 * q);
        double sq = 2 * Math.Sqrt(A) * alpha;
        switch ((band.Type ?? "PK").ToUpperInvariant())
        {
            case "LSC":
            case "LS":
                return new Biquad(A * ((A + 1) - (A - 1) * c + sq), 2 * A * ((A - 1) - (A + 1) * c), A * ((A + 1) - (A - 1) * c - sq),
                    (A + 1) + (A - 1) * c + sq, -2 * ((A - 1) + (A + 1) * c), (A + 1) + (A - 1) * c - sq);
            case "HSC":
            case "HS":
                return new Biquad(A * ((A + 1) + (A - 1) * c + sq), -2 * A * ((A - 1) + (A + 1) * c), A * ((A + 1) + (A - 1) * c - sq),
                    (A + 1) - (A - 1) * c + sq, 2 * ((A - 1) - (A + 1) * c), (A + 1) - (A - 1) * c - sq);
            case "LP":
            case "LPQ":
                return new Biquad((1 - c) / 2, 1 - c, (1 - c) / 2, 1 + alpha, -2 * c, 1 - alpha);
            case "HP":
            case "HPQ":
                return new Biquad((1 + c) / 2, -(1 + c), (1 + c) / 2, 1 + alpha, -2 * c, 1 - alpha);
            default:
                return new Biquad(1 + alpha * A, -2 * c, 1 - alpha * A, 1 + alpha / A, -2 * c, 1 - alpha / A);
        }
    }

    public static bool IsIdentity(EqBand b) => (b.Type ?? "PK").ToUpperInvariant() switch
    {
        "LP" or "LPQ" or "HP" or "HPQ" => false,
        _ => Math.Abs(b.Gain) < 1e-6,
    };

    public double Magnitude(double f, int rate)
    {
        double w = 2 * Math.PI * f / rate;
        double c1 = Math.Cos(w), s1 = Math.Sin(w), c2 = Math.Cos(2 * w), s2 = Math.Sin(2 * w);
        double nr = B0 + B1 * c1 + B2 * c2, ni = -(B1 * s1 + B2 * s2);
        double dr = 1 + A1 * c1 + A2 * c2, di = -(A1 * s1 + A2 * s2);
        return Math.Sqrt((nr * nr + ni * ni) / (dr * dr + di * di));
    }

    /// <summary>Maximum boost (dB) of a filter bank, used for automatic clipping protection.</summary>
    public static double MaxBoostDb(IList<Biquad> filters, int rate)
    {
        if (filters.Count == 0) return 0;
        double max = double.MinValue;
        for (int i = 0; i <= 240; i++)
        {
            double f = 20 * Math.Pow(1000, i / 240.0); // 20 Hz – 20 kHz
            if (f >= rate * 0.49) break;
            double m = 1;
            foreach (var b in filters) m *= b.Magnitude(f, rate);
            max = Math.Max(max, 20 * Math.Log10(m));
        }
        return max;
    }

    public void Process(ref double l, ref double r)
    {
        double yl = B0 * l + _z1L;
        _z1L = B1 * l - A1 * yl + _z2L;
        _z2L = B2 * l - A2 * yl;
        double yr = B0 * r + _z1R;
        _z1R = B1 * r - A1 * yr + _z2R;
        _z2R = B2 * r - A2 * yr;
        l = yl; r = yr;
    }
}

/// <summary>Bauer stereophonic-to-binaural crossfeed (bs2b algorithm).</summary>
public sealed class Crossfeed
{
    readonly double _a0Lo, _b1Lo, _a0Hi, _a1Hi, _b1Hi, _gain;
    double _loL, _loR, _hiL, _hiR, _inL, _inR;

    public Crossfeed(double fcut, double feedDb, int rate)
    {
        double gbLo = feedDb * -5 / 6 - 3;
        double gbHi = feedDb / 6 - 3;
        double gLo = Math.Pow(10, gbLo / 20);
        double gHi = 1 - Math.Pow(10, gbHi / 20);
        double fcHi = fcut * Math.Pow(2, (gbLo - 20 * Math.Log10(gHi)) / 12);
        double x = Math.Exp(-2 * Math.PI * fcut / rate);
        _b1Lo = x; _a0Lo = gLo * (1 - x);
        x = Math.Exp(-2 * Math.PI * fcHi / rate);
        _b1Hi = x; _a0Hi = 1 - gHi * (1 - x); _a1Hi = -x;
        _gain = 1 / (1 - gHi + gLo);
    }

    public void Process(ref double l, ref double r)
    {
        _loL = _a0Lo * l + _b1Lo * _loL;
        _loR = _a0Lo * r + _b1Lo * _loR;
        _hiL = _a0Hi * l + _a1Hi * _inL + _b1Hi * _hiL;
        _hiR = _a0Hi * r + _a1Hi * _inR + _b1Hi * _hiR;
        _inL = l; _inR = r;
        l = (_hiL + _loR) * _gain;
        r = (_hiR + _loL) * _gain;
    }
}

/// <summary>Immutable processing graph built from a DspConfig for one sample rate.</summary>
sealed class DspGraph
{
    public Biquad[] Filters;
    public Crossfeed Crossfeed;
    public double PreGain = 1;
    public double GainLimit = 1;
    public double GainL = 1, GainR = 1;
    public bool Invert;
    public bool Active;

    public static DspGraph Build(DspConfig cfg, int rate)
    {
        var g = new DspGraph { Filters = Array.Empty<Biquad>() };
        if (cfg == null || !cfg.Enabled) return g;
        var bands = cfg.EqOn ? cfg.Bands.Where(b => b.On && !Biquad.IsIdentity(b)).ToList() : new List<EqBand>();
        g.Filters = bands.Select(b => Biquad.Create(b, rate)).ToArray();
        double pre = cfg.EqOn ? cfg.PreampDb : 0;
        if (cfg.EqOn && cfg.AutoPreamp)
        {
            // Automatic clipping protection works together with the volume: EQ boosts stay audible while the
            // digital volume leaves enough headroom, and the overall gain is only capped when it would clip.
            pre = 0;
            double boost = Math.Max(0, Biquad.MaxBoostDb(g.Filters, rate));
            g.GainLimit = boost > 0 ? Math.Pow(10, -(boost + 0.1) / 20) : 1;
        }
        g.PreGain = Math.Pow(10, pre / 20);
        if (cfg.Crossfeed != null && cfg.Crossfeed.On) g.Crossfeed = new Crossfeed(cfg.Crossfeed.Fc, cfg.Crossfeed.Feed, rate);
        double bal = Math.Clamp(cfg.Balance, -1, 1);
        g.GainL = bal > 0 ? 1 - bal : 1;
        g.GainR = bal < 0 ? 1 + bal : 1;
        g.Invert = cfg.Invert;
        g.Active = g.Filters.Length > 0 || g.Crossfeed != null || Math.Abs(pre) > 1e-9 || bal != 0 || g.Invert;
        return g;
    }

    public void Process(ref double l, ref double r)
    {
        l *= PreGain; r *= PreGain;
        var f = Filters;
        for (int i = 0; i < f.Length; i++) f[i].Process(ref l, ref r);
        Crossfeed?.Process(ref l, ref r);
        l *= GainL; r *= GainR;
        if (Invert) { l = -l; r = -r; }
    }
}

/// <summary>Real-time DSP: EQ, crossfeed, balance, smooth volume ramp, metering.</summary>
public sealed class DspProcessor
{
    readonly int _rate;
    DspGraph _graph, _old;
    DspGraph _pending;
    int _fade;
    const int FadeLength = 2048;
    double _gain = 1, _target = 1;
    readonly double _ramp;
    public volatile bool ForceBypass; // DoP

    public double PeakL, PeakR;
    public long Clips;

    public DspProcessor(int rate, DspConfig cfg, double gain)
    {
        _rate = rate;
        _graph = DspGraph.Build(cfg, rate);
        _gain = _target = gain;
        _ramp = 1 - Math.Exp(-1.0 / (0.025 * rate)); // ~25 ms time constant
    }

    public void SetConfig(DspConfig cfg) => Interlocked.Exchange(ref _pending, DspGraph.Build(cfg, _rate));
    public void SetGain(double linear) => Volatile.Write(ref _target, Math.Max(0, linear));
    public bool IsActive => _graph.Active;

    /// <summary>True when the stage is mathematically transparent for this buffer.</summary>
    public bool Bypassed => ForceBypass || (!_graph.Active && _old == null && _pending == null && _gain == 1.0 && Volatile.Read(ref _target) == 1.0);

    public void Process(double[] buf, int frames)
    {
        var pending = Interlocked.Exchange(ref _pending, null);
        if (pending != null) { _old = _graph; _graph = pending; _fade = FadeLength; }
        double target = Volatile.Read(ref _target);
        double pl = 0, pr = 0;
        if (Bypassed)
        {
            for (int i = 0; i < frames * 2; i += 2)
            {
                double a = Math.Abs(buf[i]), b = Math.Abs(buf[i + 1]);
                if (a > pl) pl = a;
                if (b > pr) pr = b;
            }
            PeakL = pl; PeakR = pr;
            return;
        }
        var g = _graph;
        if (g.GainLimit < target) target = g.GainLimit;
        bool active = g.Active || _old != null;
        for (int i = 0; i < frames * 2; i += 2)
        {
            double l = buf[i], r = buf[i + 1];
            if (active)
            {
                double l2 = l, r2 = r;
                g.Process(ref l, ref r);
                if (_old != null)
                {
                    _old.Process(ref l2, ref r2);
                    double m = (double)_fade / FadeLength;
                    l = l * (1 - m) + l2 * m;
                    r = r * (1 - m) + r2 * m;
                    if (--_fade <= 0) _old = null;
                }
            }
            if (_gain != target)
            {
                _gain += (target - _gain) * _ramp;
                if (Math.Abs(_gain - target) < 1e-7) _gain = target;
            }
            l *= _gain; r *= _gain;
            double al = Math.Abs(l), ar = Math.Abs(r);
            if (al > pl) pl = al;
            if (ar > pr) pr = ar;
            if (al >= 1.0) { Clips++; l = l > 0 ? 0.99999994 : -1.0; }
            if (ar >= 1.0) { Clips++; r = r > 0 ? 0.99999994 : -1.0; }
            buf[i] = l; buf[i + 1] = r;
        }
        PeakL = pl; PeakR = pr;
    }
}
