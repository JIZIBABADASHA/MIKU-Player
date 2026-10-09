using System;
using System.Collections.Concurrent;
using System.Collections.Generic;
using System.Linq;
using System.Reflection;
using System.Runtime.InteropServices;
using NAudio.CoreAudioApi;
using NAudio.CoreAudioApi.Interfaces;
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
        string def = DefaultId(en);
        foreach (var d in en.EnumerateAudioEndPoints(DataFlow.Render, DeviceState.Active))
        {
            // a device being unplugged while it is listed can fail any property read: skip it, keep the rest
            try { result.Add(new DeviceInfo { Id = d.ID, Name = d.FriendlyName, IsDefault = d.ID == def }); }
            catch (Exception ex) { Log.Info("List devices: skipped one (" + ex.Message + ")"); }
            finally { Release(d); }
        }
        return result.OrderByDescending(d => d.IsDefault).ThenBy(d => d.Name).ToList();
    }

    /// <summary>The selected device, or the system output when none is selected or the selected one isn't connected.</summary>
    public static MMDevice Open(string id)
    {
        using var en = new MMDeviceEnumerator();
        if (!string.IsNullOrEmpty(id))
        {
            MMDevice d = null;
            try
            {
                d = en.GetDevice(id);
                if (d.State == DeviceState.Active) return d;
            }
            catch { }
            Release(d);
        }
        try { return en.GetDefaultAudioEndpoint(DataFlow.Render, Role.Multimedia); }
        catch (Exception ex) { throw new NoOutputDeviceException(ex); }
    }

    /// <summary>ID of the system's output device, or null when there is none.</summary>
    public static string DefaultId()
    {
        try { using var en = new MMDeviceEnumerator(); return DefaultId(en); }
        catch { return null; }
    }

    static string DefaultId(MMDeviceEnumerator en)
    {
        MMDevice d = null;
        try { d = en.GetDefaultAudioEndpoint(DataFlow.Render, Role.Multimedia); return d.ID; }
        catch { return null; }
        finally { Release(d); }
    }

    /// <summary>The device exists and is active (plugged in and enabled).</summary>
    public static bool IsActive(string id)
    {
        if (string.IsNullOrEmpty(id)) return false;
        MMDevice d = null;
        try { using var en = new MMDeviceEnumerator(); d = en.GetDevice(id); return d.State == DeviceState.Active; }
        catch { return false; }
        finally { Release(d); }
    }

    static readonly FieldInfo[] ReleasedFields = new[] { "audioEndpointVolume", "audioSessionManager", "audioMeterInformation" }
        .Select(n => typeof(MMDevice).GetField(n, BindingFlags.NonPublic | BindingFlags.Instance)).Where(f => f != null).ToArray();

    /// <summary>
    /// Disposes a device without ever leaving a throwing finalizer behind.
    /// NAudio's AudioEndpointVolume and AudioSessionManager unregister their COM notifications with
    /// Marshal.ThrowExceptionForHR, in Dispose and in their finalizers. Once the device is unplugged (or the endpoint
    /// was rebuilt after a format change) that call fails, and an exception on the finalizer thread terminates the
    /// process — this is how switching or unplugging the output could close MIKU, typically right at the next
    /// garbage collection. Every part is disposed here inside try/catch and its finalizer is switched off.
    /// </summary>
    public static void Release(MMDevice device)
    {
        if (device == null) return;
        foreach (var f in ReleasedFields)
        {
            object part = null;
            try { part = f.GetValue(device); } catch { }
            if (part == null) continue;
            try { part.GetType().GetMethod("Dispose", Type.EmptyTypes)?.Invoke(part, null); }
            catch (Exception ex) { Log.Info($"Release {f.Name}: {(ex as TargetInvocationException)?.InnerException?.Message ?? ex.Message}"); }
            GC.SuppressFinalize(part);
            try { f.SetValue(device, null); } catch { }
        }
        GC.SuppressFinalize(device);
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

/// <summary>No output device at all (everything unplugged or disabled).</summary>
public sealed class NoOutputDeviceException : InvalidOperationException
{
    public NoOutputDeviceException(Exception inner) : base("找不到可用的輸出裝置；請連接 DAC 或在 Windows 音效設定啟用輸出裝置。", inner) { }
}

/// <summary>
/// Windows' endpoint notifications (plug / unplug, enable / disable, a new default output). They arrive on a COM
/// thread that must not block or call back into the device API, so each one only hands a short note to the engine,
/// which acts on it later on a worker thread.
/// </summary>
public sealed class DeviceWatcher : IMMNotificationClient, IDisposable
{
    readonly MMDeviceEnumerator _en = new();
    readonly Action<string> _changed;
    bool _registered;

    public DeviceWatcher(Action<string> changed)
    {
        _changed = changed;
        Marshal.ThrowExceptionForHR(_en.RegisterEndpointNotificationCallback(this));
        _registered = true;
    }

    void Raise(string what) { try { _changed(what); } catch (Exception ex) { Log.Error("Device notification", ex); } }
    public void OnDeviceStateChanged(string deviceId, DeviceState newState) => Raise("state " + newState);
    public void OnDeviceAdded(string pwstrDeviceId) => Raise("added");
    public void OnDeviceRemoved(string deviceId) => Raise("removed");
    public void OnDefaultDeviceChanged(DataFlow flow, Role role, string defaultDeviceId)
    {
        if (flow == DataFlow.Render && role == Role.Multimedia) Raise("default");
    }
    public void OnPropertyValueChanged(string pwstrDeviceId, PropertyKey key) { }

    public void Dispose()
    {
        if (_registered) { try { _en.UnregisterEndpointNotificationCallback(this); } catch { } _registered = false; }
        try { _en.Dispose(); } catch { }
    }
}
