using System;
using System.Collections.Generic;
using System.Globalization;
using System.IO;
using System.Linq;
using System.Net.Http;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using System.Text.Json.Serialization;
using System.Text.RegularExpressions;

namespace Miku;

public static class AppPaths
{
    // The preview launcher can use an isolated profile. Normal launches keep the installed app's profile.
    public static readonly string Root = ProfileRoot();
    static string ProfileRoot()
    {
        string path = Environment.GetEnvironmentVariable("MIKU_DATA_DIR");
        return !string.IsNullOrWhiteSpace(path) && Path.IsPathFullyQualified(path)
            ? Path.GetFullPath(path)
            : Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "MIKU");
    }
    public static readonly string Art = Path.Combine(Root, "Art");
    public static readonly string OnlineArt = Path.Combine(Root, "Art", "Online");
    public static readonly string Thumbs = Path.Combine(Root, "Art", "Thumbs");
    public static readonly string Lyrics = Path.Combine(Root, "Lyrics");
    public static readonly string WebView = Path.Combine(Root, "WebView2");
    public static readonly string Settings = Path.Combine(Root, "settings.json");
    public static readonly string Library = Path.Combine(Root, "library.json");
    public static readonly string LogFile = Path.Combine(Root, "sonora.log");
    public static string AppDir => AppContext.BaseDirectory;

    public static void Ensure()
    {
        foreach (var d in new[] { Root, Art, OnlineArt, Thumbs, Lyrics, WebView }) Directory.CreateDirectory(d);
    }
}

public static class Log
{
    static readonly object Gate = new();
    public static void Info(string message) => Write("INFO", message);
    public static void Error(string context, Exception ex) => Write("ERROR", context + ": " + ex);
    public static void Error(Exception ex) => Write("ERROR", ex?.ToString() ?? "null");
    static void Write(string level, string message)
    {
        try
        {
            lock (Gate)
            {
                var fi = new FileInfo(AppPaths.LogFile);
                if (fi.Exists && fi.Length > 2_000_000) fi.Delete();
                File.AppendAllText(AppPaths.LogFile, $"{DateTime.Now:yyyy-MM-dd HH:mm:ss.fff} [{level}] {message}{Environment.NewLine}");
            }
        }
        catch { }
    }
}

public static class Json
{
    public static readonly JsonSerializerOptions Options = new(JsonSerializerDefaults.Web)
    {
        DefaultIgnoreCondition = JsonIgnoreCondition.WhenWritingNull,
        NumberHandling = JsonNumberHandling.AllowNamedFloatingPointLiterals,
        Encoder = System.Text.Encodings.Web.JavaScriptEncoder.UnsafeRelaxedJsonEscaping,
    };
    public static string Serialize<T>(T value) => JsonSerializer.Serialize(value, Options);
    public static T Deserialize<T>(string json) => JsonSerializer.Deserialize<T>(json, Options);

    public static T Load<T>(string path) where T : new()
    {
        try
        {
            if (File.Exists(path)) return JsonSerializer.Deserialize<T>(File.ReadAllText(path), Options) ?? new T();
        }
        catch (Exception ex) { Log.Error("Load " + path, ex); }
        return new T();
    }

    public static void SaveAtomic<T>(string path, T value)
    {
        string tmp = path + ".tmp";
        File.WriteAllText(tmp, JsonSerializer.Serialize(value, Options));
        File.Move(tmp, path, true);
    }
}

public static class Text
{
    public static string Hash(string s)
    {
        var bytes = SHA1.HashData(Encoding.UTF8.GetBytes(s ?? ""));
        return Convert.ToHexString(bytes, 0, 8).ToLowerInvariant();
    }

    /// <summary>
    /// The first real name of an artist tag: ';' separates several ("ほぼ日P ;  初音ミク"), and a compilation's
    /// "Various Artists" or "未知演出者" is skipped ("Various Artists ; 初音ミク" → "初音ミク"). "" when there is none.
    /// </summary>
    public static string FirstArtist(string s) =>
        (s ?? "").Split(';', StringSplitOptions.TrimEntries | StringSplitOptions.RemoveEmptyEntries)
            .FirstOrDefault(n => n is not ("Various Artists" or "未知演出者")) ?? "";

    static readonly Regex Brackets = new(@"[\(\[（【［〔「『<].*?[\)\]）】］〕」』>]", RegexOptions.Compiled);
    static readonly Regex NonWord = new(@"[\s\p{P}\p{S}]+", RegexOptions.Compiled);

    /// <summary>Normalise for fuzzy matching: NFKC, lower case, no punctuation / whitespace.</summary>
    public static string Norm(string s, bool stripBrackets = false)
    {
        if (string.IsNullOrWhiteSpace(s)) return "";
        s = s.Normalize(NormalizationForm.FormKC).ToLowerInvariant();
        if (stripBrackets)
        {
            string stripped = Brackets.Replace(s, " ");
            if (NonWord.Replace(stripped, "").Length > 0) s = stripped;
        }
        return NonWord.Replace(s, "");
    }

    public static double Similarity(string a, string b, bool stripBrackets = true)
    {
        a = Norm(a, stripBrackets); b = Norm(b, stripBrackets);
        if (a.Length == 0 || b.Length == 0) return 0;
        if (a == b) return 1;
        if (a.Contains(b) || b.Contains(a)) return 0.88 * Math.Min(a.Length, b.Length) / Math.Max(a.Length, b.Length) + 0.12;
        int d = Levenshtein(a, b);
        return 1.0 - (double)d / Math.Max(a.Length, b.Length);
    }

    static int Levenshtein(string a, string b)
    {
        var prev = new int[b.Length + 1];
        var cur = new int[b.Length + 1];
        for (int j = 0; j <= b.Length; j++) prev[j] = j;
        for (int i = 1; i <= a.Length; i++)
        {
            cur[0] = i;
            for (int j = 1; j <= b.Length; j++)
            {
                int cost = a[i - 1] == b[j - 1] ? 0 : 1;
                cur[j] = Math.Min(Math.Min(cur[j - 1] + 1, prev[j] + 1), prev[j - 1] + cost);
            }
            (prev, cur) = (cur, prev);
        }
        return prev[b.Length];
    }

    static bool _codePages;
    /// <summary>Decode a text file whose encoding is unknown (UTF-8 / UTF-16 / Shift-JIS / GBK / Big5).</summary>
    public static string DecodeUnknown(byte[] bytes)
    {
        if (!_codePages) { Encoding.RegisterProvider(CodePagesEncodingProvider.Instance); _codePages = true; }
        if (bytes.Length >= 3 && bytes[0] == 0xEF && bytes[1] == 0xBB && bytes[2] == 0xBF) return Encoding.UTF8.GetString(bytes, 3, bytes.Length - 3);
        if (bytes.Length >= 2 && bytes[0] == 0xFF && bytes[1] == 0xFE) return Encoding.Unicode.GetString(bytes, 2, bytes.Length - 2);
        if (bytes.Length >= 2 && bytes[0] == 0xFE && bytes[1] == 0xFF) return Encoding.BigEndianUnicode.GetString(bytes, 2, bytes.Length - 2);
        try { return new UTF8Encoding(false, true).GetString(bytes); } catch { }
        string best = null; int bestScore = int.MinValue;
        foreach (int cp in new[] { 932, 950, 936 })
        {
            try
            {
                var enc = Encoding.GetEncoding(cp, EncoderFallback.ExceptionFallback, DecoderFallback.ExceptionFallback);
                string s = enc.GetString(bytes);
                int score = 0;
                foreach (char c in s)
                {
                    if (c >= '぀' && c <= 'ヿ') score += cp == 932 ? 3 : -2; // kana
                    else if (c >= '一' && c <= '鿿') score += 1;
                    else if (c >= '｡' && c <= 'ﾟ') score -= 2; // half width katakana: usually a mis-decode
                    else if (c < 0x20 && c != '\r' && c != '\n' && c != '\t') score -= 5;
                }
                if (score > bestScore) { bestScore = score; best = s; }
            }
            catch { }
        }
        return best ?? Encoding.UTF8.GetString(bytes);
    }

    [System.Runtime.InteropServices.DllImport("kernel32.dll", CharSet = System.Runtime.InteropServices.CharSet.Unicode)]
    static extern int LCMapStringEx(string locale, uint flags, string src, int srcLen, char[] dest, int destLen, IntPtr ver, IntPtr reserved, IntPtr sortHandle);

    /// <summary>Simplified → Traditional Chinese using the Windows NLS tables.</summary>
    public static string ToTraditional(string s)
    {
        if (string.IsNullOrEmpty(s)) return s;
        try
        {
            var buf = new char[s.Length * 2 + 16];
            int n = LCMapStringEx("zh-TW", 0x04000000, s, s.Length, buf, buf.Length, IntPtr.Zero, IntPtr.Zero, IntPtr.Zero);
            return n > 0 ? new string(buf, 0, n) : s;
        }
        catch { return s; }
    }

    /// <summary>Translation lines from lyric services: strip 【】 wrappers and show Traditional Chinese.</summary>
    public static string CleanTranslation(string s)
    {
        if (string.IsNullOrWhiteSpace(s)) return null;
        s = s.Trim();
        if (s.StartsWith("【") && s.EndsWith("】")) s = s[1..^1].Trim();
        if (s.StartsWith("「") && s.EndsWith("」") && s.IndexOf('「', 1) < 0) s = s[1..^1].Trim();
        return s.Length == 0 ? null : ToTraditional(s);
    }

    public static string Inv(double d, string fmt = "0.###") => d.ToString(fmt, CultureInfo.InvariantCulture);
}

public static class Net
{
    public static readonly HttpClient Http = Create();
    static HttpClient Create()
    {
        var handler = new HttpClientHandler { AutomaticDecompression = System.Net.DecompressionMethods.All, AllowAutoRedirect = true };
        var c = new HttpClient(handler) { Timeout = TimeSpan.FromSeconds(15) };
        c.DefaultRequestHeaders.UserAgent.ParseAdd("Miku/1.0 (desktop music player)");
        c.DefaultRequestHeaders.Accept.ParseAdd("application/json, */*");
        return c;
    }
}
