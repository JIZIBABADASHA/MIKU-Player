const shortDevice = n => { const m = /^[^(（]+[(（](.+)[)）]\s*$/.exec(n || ''); return (m ? m[1] : n || '').trim(); };
const Outputs = {
  data: null,
  async refresh() {
    try { this.data = await Host.call('devices'); } catch { }
    this.label();
  },
  label() {
    const s = App.settings, d = this.data;
    let name = T('輸出');
    if (d) {
      const dev = d.devices.find(x => x.id === s.deviceId) || d.devices.find(x => x.isDefault);
      if (dev) name = shortDevice(dev.name);
    }
    $('#b-outname').textContent = name;
    $('#b-out').title = T('輸出：') + name + (s.outputMode === 'coreaudio-exclusive' ? T('（Core Audio 獨佔）') : T('（Core Audio 共享）'));
  },
  /** A device was connected / removed or the system output changed: refresh the picker and the settings page. */
  changed() {
    clearTimeout(this.changedTimer);
    this.changedTimer = setTimeout(() => {
      this.refresh();
      if (typeof Settings !== 'undefined' && Settings.redrawDevices) Settings.redrawDevices();
    }, 400);
  },
  async toggle(anchor) {
    if (Popover.el && Popover.el.classList.contains('outpop')) return Popover.close();
    const box = h('div');
    const draw = () => {
      box.textContent = '';
      const s = App.settings, d = this.data || { devices: [], asio: [] };
      box.append(h('h3', { html: icon('speaker') + T('輸出裝置') }));
      if (false) {
        if (!d.asio.length) box.append(h('div', { class: 'muted', style: { padding: '8px' } }, T('沒有找到 ASIO 驅動程式')));
        d.asio.forEach(n => {
          const on = (s.asioDriver || d.asio[0]) === n;
          box.append(h('button', { class: 'outrow' + (on ? ' on' : ''), onclick: async () => { await Settings.set({ asioDriver: n }); this.label(); Popover.close(); toast(T('已切換到 ') + n); } },
            h('span', { html: icon('speaker') }), h('span', { class: 'nm' }, h('b', null, n), h('small', null, 'ASIO'))));
        });
      } else {
        const cur = s.deviceId || (d.devices.find(x => x.isDefault) || {}).id;
        d.devices.forEach(x => {
          const on = x.id === cur;
          const sub = on && d.caps ? d.caps.summary : (x.isDefault ? T('跟隨系統設定') : '');
          box.append(h('button', { class: 'outrow' + (on ? ' on' : ''), onclick: async () => {
            Popover.close();
            await Settings.set({ deviceId: x.id });
            toast(T('已切換到 ') + shortDevice(x.name));
            this.refresh();
          } }, h('span', { html: icon('speaker') }), h('span', { class: 'nm' }, h('b', null, shortDevice(x.name)), h('small', null, sub))));
        });
      }
    };
    draw();
    Popover.show(box, anchor, { cls: 'outpop', above: true, align: 'right' });
    await this.refresh();
    if (Popover.el && Popover.el.contains(box)) draw();
  },
};
Host.on('devicesChanged', () => Outputs.changed());
