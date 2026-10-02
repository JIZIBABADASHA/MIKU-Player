using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Text.RegularExpressions;
using System.Threading.Tasks;

namespace Miku.Host;

public sealed class AutoEqEntry
{
    public string Name { get; set; }
    public string Path { get; set; }
    public string Source { get; set; }
}

/// <summary>Searches the AutoEq headphone database (github.com/jaakkopasanen/AutoEq) and fetches parametric presets.</summary>
public static class AutoEq
{
    const string Base = "https://raw.githubusercontent.com/jaakkopasanen/AutoEq/master/results/";
    static readonly Regex Line = new(@"^\s*-\s*\[(?<name>.+?)\]\((?<path>\./[^)]+)\)(?<rest>.*)$", RegexOptions.Compiled);
    static List<AutoEqEntry> _index;

    static async Task<List<AutoEqEntry>> Index()
    {
        if (_index != null) return _index;
        string cache = System.IO.Path.Combine(AppPaths.Root, "autoeq-index.md");
        string text = null;
        if (File.Exists(cache) && DateTime.UtcNow - File.GetLastWriteTimeUtc(cache) < TimeSpan.FromDays(14))
            text = await File.ReadAllTextAsync(cache);
        if (text == null)
        {
            text = await Net.Http.GetStringAsync(Base + "INDEX.md");
            await File.WriteAllTextAsync(cache, text);
        }
        var list = new List<AutoEqEntry>();
        foreach (var raw in text.Split('\n'))
        {
            var m = Line.Match(raw);
            if (!m.Success) continue;
            string rest = m.Groups["rest"].Value.Trim();
            list.Add(new AutoEqEntry
            {
                Name = m.Groups["name"].Value,
                Path = Uri.UnescapeDataString(m.Groups["path"].Value[2..]),
                Source = rest.StartsWith("by ", StringComparison.OrdinalIgnoreCase) ? rest[3..] : rest,
            });
        }
        _index = list;
        return list;
    }

    public static async Task<List<AutoEqEntry>> Search(string q)
    {
        var idx = await Index();
        if (string.IsNullOrWhiteSpace(q)) return new List<AutoEqEntry>();
        var terms = q.ToLowerInvariant().Split(' ', StringSplitOptions.RemoveEmptyEntries);
        return idx.Where(e => terms.All(t => e.Name.ToLowerInvariant().Contains(t)))
                  .OrderBy(e => e.Name.Length).Take(40).ToList();
    }

    public static async Task<string> Fetch(string path, string name)
    {
        string encoded = string.Join("/", path.Split('/').Select(Uri.EscapeDataString));
        string url = Base + encoded + "/" + Uri.EscapeDataString(name + " ParametricEQ.txt");
        return await Net.Http.GetStringAsync(url);
    }
}
