using System;
using System.Collections.Concurrent;
using System.Collections.Generic;
using System.Linq;
using NAudio.CoreAudioApi;
using NAudio.Wave;

namespace Miku.Audio;

public sealed class DeviceInfo
{
    public string Id { get; set; }
    public string Name { get; set; }
    public bool IsDefault { get; set; }
}

public sealed class DeviceCaps
{
    public string Id { get; set; }
    public string Name { get; set; }
    public int MixRate { get; set; }
    public int MixChannels { get; set; }
    /// <summary>rate → supported exclusive sample formats (stereo)</summary>
    public Dictionary<int, List<SampleFormat>> Exclusive { get; set; } = new();
    public bool HardwareVolume { get; set; }
    public double VolMinDb { get; set; }
    public double VolMaxDb { get; set; }
    /// <summary>Probed while another program was playing on the device: the driver then only reports the format
    /// that program is using (e.g. 44.1 kHz only), so this result is incomplete and must be probed again later.</summary>
    public bool Partial { get; set; }

    public IEnumerable<int> Rates => Exclusive.Where(kv => kv.Value.Count > 0).Select(kv => kv.Key).OrderBy(r => r);

    public SampleFormat? BestFormat(int rate, bool needInteger24 = false)
    {
        if (!Exclusive.TryGetValue(rate, out var list) || list.Count == 0) return null;
        foreach (var f in Formats.Preference)
        {
            if (!list.Contains(f)) continue;
            if (needInteger24 && (f == SampleFormat.Int16 || f == SampleFormat.Float32)) continue;
            return f;
        }
        return null;
    }

    public string Summary()
    {
        var rates = Rates.ToList();
        if (rates.Count == 0) return "不支援獨佔模式";
        int maxBits = Exclusive.Values.SelectMany(v => v).Select(Formats.ValidBits).DefaultIfEmpty(16).Max();
        return $"{rates.First() / 1000.0:0.#}–{rates.Last() / 1000.0:0.#} kHz · 最高 {maxBits}-bit";
    }
}

public static class Devices
{
    static readonly ConcurrentDictionary<string, DeviceCaps> Cache = new();

    public static List<DeviceInfo> List()
    {
        var result = new List<DeviceInfo>();
        using var en = new MMDeviceEnumerator();
        string def = null;
        try { using var d = en.GetDefaultAudioEndpoint(DataFlow.Render, Role.Multimedia); def = d.ID; } catch { }
        foreach (var d in en.EnumerateAudioEndPoints(DataFlow.Render, DeviceState.Active))
        {
            using (d) result.Add(new DeviceInfo { Id = d.ID, Name = d.FriendlyName, IsDefault = d.ID == def });
        }
        return result.OrderByDescending(d => d.IsDefault).ThenBy(d => d.Name).ToList();
    }

    public static MMDevice Open(string id)
    {
        using var en = new MMDeviceEnumerator();
        if (!string.IsNullOrEmpty(id))
        {
            try
            {
                var d = en.GetDevice(id);
                if (d.State == DeviceState.Active) return d;
                d.Dispose();
            }
            catch { }
        }
        return en.GetDefaultAudioEndpoint(DataFlow.Render, Role.Multimedia);
    }

    public static void Invalidate(string id) { if (id != null) Cache.TryRemove(id, out _); }

    public static DeviceCaps Probe(MMDevice device)
    {
        if (Cache.TryGetValue(device.ID, out var cached)) return cached;
        var caps = new DeviceCaps { Id = device.ID, Name = device.FriendlyName };
        string busyBy = OthersActive(device);
        try
        {
            var client = device.AudioClient;
            var mix = client.MixFormat;
            caps.MixRate = mix.SampleRate;
            caps.MixChannels = mix.Channels;
            foreach (int rate in Formats.ProbeRates)
            {
                var list = new List<SampleFormat>();
                foreach (SampleFormat f in Enum.GetValues(typeof(SampleFormat)))
                {
                    try
                    {
                        if (client.IsFormatSupported(AudioClientShareMode.Exclusive, Formats.Create(rate, 2, f))) list.Add(f);
                    }
                    catch { }
                }
                caps.Exclusive[rate] = list;
            }
            client.Dispose();
        }
        catch (Exception ex) { Log.Error("Probe " + device.FriendlyName, ex); }
        try
        {
            var vol = device.AudioEndpointVolume;
            caps.HardwareVolume = ((int)vol.HardwareSupport & 1) != 0;
            caps.VolMinDb = vol.VolumeRange.MinDecibels;
            caps.VolMaxDb = vol.VolumeRange.MaxDecibels;
        }
        catch { }
        caps.Partial = busyBy != null;
        Log.Info($"Probe {caps.Name}: exclusive rates [{string.Join(", ", caps.Rates.Select(r => r / 1000.0))}] kHz"
                 + (caps.Partial ? $" — {busyBy} is playing on it, result not cached" : ""));
        if (!caps.Partial) Cache[device.ID] = caps;
        return caps;
    }

    /// <summary>Name of another process with an active (playing) audio session on the device, or null.</summary>
    static string OthersActive(MMDevice device)
    {
        try
        {
            var mgr = device.AudioSessionManager;
            mgr.RefreshSessions();
            var s = mgr.Sessions;
            int self = Environment.ProcessId;
            for (int i = 0; i < s.Count; i++)
            {
                var c = s[i];
                if (c.State != NAudio.CoreAudioApi.Interfaces.AudioSessionState.AudioSessionStateActive) continue;
                uint pid = c.GetProcessID;
                if (pid == 0 || pid == self) continue;
                try { return System.Diagnostics.Process.GetProcessById((int)pid).ProcessName; } catch { return "pid " + pid; }
            }
        }
        catch { }
        return null;
    }

    public static List<string> AsioDrivers()
    {
        try { return NAudio.Wave.AsioOut.GetDriverNames().ToList(); }
        catch { return new List<string>(); }
    }
}
