/* Mock host for screenshots: a small library, a playing track, canned answers. Injected before the page's scripts. */
(() => {
  const P = new URLSearchParams(location.search);
  const ALB = [
    ['a13', 'Pure3 Feel Classics ~Naoya Shimokawa~ (DSD 2.8MHz/1bit)', 'AQUAPLUS', 0, 'Game'],
    ['a14', 'Today Is A Beautiful Day', 'supercell', 2011, 'J-Pop'],
    ['a15', 'Wonka (Original Motion Picture Soundtrack)', 'Joby Talbot / Neil Hannon / The Cast of Wonka', 2023, 'Soundtrack'],
    ['a16', 'ZIGAEXPERIENCE (Spotify Singles Edition) — Symphony gypsy jpg', 'supercell', 2013, 'J-Pop'],
    ['a17', '劇場版「鬼滅の刃」無限列車編 オリジナルサウンドトラック', '梶浦由記・椎名豪', 2020, 'Anime'],
    ['a1', 'マジカルミライ 2023', '初音ミク', 2023, 'Vocaloid'], ['a2', 'Blue Planet', 'DECO*27', 2022, 'J-Pop'],
    ['a3', 'Kind of Blue', 'Miles Davis', 1959, 'Jazz'], ['a4', '風街ろまん', 'はっぴいえんど', 1971, 'Rock'],
    ['a5', 'Random Access Memories', 'Daft Punk', 2013, 'Electronic'], ['a6', '葉惠美', '周杰倫', 2003, 'Mandopop'],
    ['a7', 'Abbey Road', 'The Beatles', 1969, 'Rock'], ['a8', 'For Lovers', 'Chet Baker', 1988, 'Jazz'],
    ['a9', 'THE BOOK', 'YOASOBI', 2021, 'J-Pop'], ['a10', 'In Rainbows', 'Radiohead', 2007, 'Alternative'],
    ['a11', '紅蓮華', 'LiSA', 2019, 'Anime'], ['a12', 'Getz/Gilberto', 'Stan Getz', 1964, 'Bossa Nova'],
  ];
  const albums = ALB.map((a, i) => [a[0], a[1], a[2], a[3], a[4], 1790000000 - i * 86400, 1, 0, '', 'D:\\Music\\' + a[1]]);
  const tracks = [];
  const names = ['Everybody Wants to Rule the World (Extended Mix) — gjpqy', 'Symphony No. 9 "Choral": IV. Presto — Allegro assai, gypsy', 'Opening', 'ブレス・ユア・ブレス', 'Night Drive', '砂の惑星', 'So What', 'Blue in Green', '夏なんです', 'Instant Crush', '晴天', 'Come Together', '群青', 'Nude'];
  ALB.forEach((a, i) => {
    for (let n = 1; n <= 8; n++) {
      const hi = i % 3 === 0, dsd = i === 7;
      tracks.push([`${a[0]}-t${n}`, names[(i + n) % names.length] + (n > 4 ? ' (Live)' : ''), a[2], a[0], 1, n, 180 + ((i * 37 + n * 53) % 140),
        dsd ? 'dsd' : 'flac', dsd ? 2822400 : hi ? 96000 : 44100, dsd ? 1 : hi ? 24 : 16, a[3], '', 1790000000 - i * 86400, 0]);
    }
  });
  if (P.get('title')) { const t = tracks.find(x => x[0] === 'a15-t1'); t[1] = P.get('title'); if (P.get('artist')) t[2] = P.get('artist'); }
  if (P.get('album')) { const a = albums.find(x => x[0] === 'a15'); a[1] = P.get('album'); }
  const playing = P.get('play') !== '0';
  const state = {
    trackId: playing ? 'a15-t1' : null, playing: playing && P.get('paused') !== '1', pos: +(P.get('pos') || 74), dur: 231, volume: 0.8, muted: false, shuffle: false, repeat: 'off',
    signal: playing ? { quality: P.get('qual') || undefined, dsd: P.get('dsd') === '1' || undefined, dsdLabel: P.get('dsd') === '1' ? 'DSD64' : undefined, codec: 'FLAC', sourceBits: +(P.get('sb') || 16), sourceRate: +(P.get('sr') || 44100), rate: 96000, bits: 24, outRate: 96000, outBits: 24, bitPerfect: true, device: 'USB DAC', mode: 'WASAPI Exclusive' } : null,
    device: 'USB DAC', mode: 'exclusive',
  };
  const ui = {};
  try { Object.assign(ui, JSON.parse(P.get('ui') || '{}')); } catch (e) { }
  const settings = {
    ui, favorites: ['a1-t2', 'a3-t1'], recent: ['a1-t2', 'a2-t1', 'a3-t4'], folders: ['D:\\Music'], lang: 'zh-Hant',
    output: { device: 'USB DAC', mode: 'exclusive' },
    playlists: [{ id: 'p1', name: 'Late-night Highway Playlist for Rainy Days — gypsy jpq', tracks: ['a1-t2', 'a2-t1', 'a3-t4', 'a5-t3', 'a9-t1'], updated: 1790000000 }, { id: 'p2', name: 'Jazz', tracks: ['a3-t1', 'a8-t2'], updated: 1789000000 }, { id: 'p3', name: '空的清單', tracks: [], updated: 1788000000 }], dsp: { enabled: true, eqOn: true, preampDb: -3, autoPreamp: false, balance: 0, invert: false, presetName: '', crossfeed: { on: false, fc: 700, feed: 4.5 }, bands: [{ on: true, type: 'PK', fc: 60, gain: 3, q: 1 }, { on: true, type: 'PK', fc: 400, gain: -2, q: 1.2 }, { on: true, type: 'PK', fc: 2500, gain: 2.5, q: 1 }, { on: false, type: 'HS', fc: 9000, gain: 2, q: .7 }] }, replayGain: 'off', search: [],
  };
  const ans = {
    ready: () => ({ settings, queue: { ids: tracks.slice(0, 8).map(t => t[0]), index: 1 }, state, scan: null, ffmpeg: true, version: '9.9.9', platform: P.get('platform') || 'windows', cores: [{ id: 'miku', name: 'FFmpeg', dsdPcmRate: true }], extensions: [], sysLang: 'zh-Hant', installLang: 'zh-Hant' }),
    devices: () => ({ devices: [{ id: 'd1', name: (new URLSearchParams(location.search).get('dev') || 'USB DAC'), isDefault: true, modes: ['shared', 'exclusive'] }], current: 'd1' }),
    presets: () => [],
    'update.info': () => ({ current: '9.9.9', latest: null }),
    'remote.info': () => ({ on: false, devices: [] }),
    'remoteLib.info': () => ({ active: false, servers: [] }),
    'art.info': () => ({}),
    'overlay.can': () => false,
    lyrics: (a) => P.get('ly') === '0' ? null : ({ id: a && a.id, synced: true, source: 'LRCLIB', lines: ['夜の街を走り抜けて', '光の粒が流れてく', 'Night drive, take me higher', '君の声が聞こえる', 'まだ終わらない夢の中', 'ずっとこのまま', '遠くまで行こう', 'Ah — ah —', '風を切って'].map(x => x).map((x, i, a) => P.get('lygap') === '1' && i === 3 ? '' : x).map((x, i) => i === 4 && P.get('lylong') === '1' ? '「あなたはどんな子なの？」って聞かないで' : i === 4 && P.get('lylong') === '2' ? '誰も入れたくないエリア キミは持ってないの？Why not？個性的だって言うけど いまボーダーライン上手に引いたよね' : x).map((text, i) => ({ t: 58 + i * 5, text, trans: i % 2 ? null : 'translation line ' + (i + 1) })) }),
  };
  window.Mock = {
    library: () => ({ albums, tracks, folders: ['D:\\Music'] }),
    call(m, a) {
      if (m === 'ui' && a) ui[a.key] = a.value;
      let r = null;
      try { r = ans[m] ? ans[m](a) : null; } catch (e) { }
      return Promise.resolve(r);
    },
  };
})();
