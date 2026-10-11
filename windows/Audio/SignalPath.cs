using System.Collections.Generic;
using System.Linq;

namespace Miku.Audio;

/// <summary>
/// The signal path card in the shared layout (core.js SigPath): sections of stages in processing order, each a one-line
/// summary whose details fold under it, and notes (warnings) under the card. A core fills SignalInfo.Path; a core
/// without one keeps the standard layout.
/// </summary>
public sealed class SignalPath
{
    public List<SignalSection> Sections { get; } = new();
    public List<string> Notes { get; } = new();

    public SignalSection Section(string title)
    {
        var s = new SignalSection { Title = title };
        Sections.Add(s);
        return s;
    }
}

public sealed class SignalSection
{
    public string Title { get; set; }
    /// <summary>The module's mark after the title (a module's own path only).</summary>
    public bool Mark { get; set; }
    public List<SignalStage> Rows { get; } = new();

    /// <summary>A stage: label, its one-line summary, whether it changes the samples, its details (folded).</summary>
    public SignalStage Add(string k, string v, bool mod, params string[] more)
    {
        var r = new SignalStage { K = k, V = v, Mod = mod, More = more.Where(x => !string.IsNullOrEmpty(x)).ToList() };
        Rows.Add(r);
        return r;
    }
}

public sealed class SignalStage
{
    public string K { get; set; }
    public string V { get; set; }
    public bool Mod { get; set; }
    public List<string> More { get; set; } = new();
    /// <summary>Lines under the summary shown all the time (the decoder).</summary>
    public List<SignalPin> Pin { get; set; } = new();
}

public sealed class SignalPin
{
    public string K { get; set; }
    public string V { get; set; }
    public bool Mark { get; set; }
}
