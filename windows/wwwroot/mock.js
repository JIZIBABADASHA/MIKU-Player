'use strict';
/* Browser-only preview backend. Inactive inside the app (WebView2 provides the real host). */
window.Mock = (window.chrome && window.chrome.webview) ? null : (() => {
  const artists = ['Aoi Hoshino', 'Lumen Field', '月白', 'Kotone', 'The Quiet Rooms', 'Nami Orchestra', 'Haruka Mizuse', 'Glass Harbor', '藍色迴廊', 'Sora Ensemble', 'Mint Static', 'Yuzuha'];
  const words = ['Starlight', 'Afterglow', '夜明け', 'Blue Hour', 'Harbor', '夏の終わり', 'Glass', 'Echoes', '雨音', 'Paper Moon', 'Silver Line', 'Orbit', '花火', 'Lantern', 'Drift', 'Signal', '透明', 'Cityscape'];
  const fmts = [['FLAC', 44100, 16], ['FLAC', 96000, 24], ['FLAC', 192000, 24], ['DSF', 2822400, 1], ['FLAC', 48000, 24], ['MP3', 44100, 16]];
  let seed = 7; const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
  const albums = [], tracks = [];
  for (let i = 0; i < 180; i++) {
    const ar = artists[Math.floor(rnd() * artists.length)];
    const title = words[Math.floor(rnd() * words.length)] + (rnd() > .6 ? ' ' + words[Math.floor(rnd() * words.length)] : '');
    const id = 'al' + i, f = fmts[Math.floor(rnd() * fmts.length)];
    albums.push([id, title, ar, 2005 + Math.floor(rnd() * 20), 'J-Pop', 1700000000 + i * 1000, 1, 0]);
    const n = 6 + Math.floor(rnd() * 8);
    for (let k = 1; k <= n; k++) tracks.push(['t' + i + '_' + k, words[Math.floor(rnd() * words.length)] + (k % 3 ? '' : ' (Instrumental)'), ar, id, 1, k, 180 + rnd() * 120, f[0], f[1], f[2], 2020, '']);
  }
  const state = { trackId: 't3_2', playing: true, loaded: true, pos: 42, dur: 251, index: 1, volumeDb: -18.5, muted: false, volumeMode: 'digital', repeat: 'off', shuffle: false,
    signal: { codec: 'FLAC', sourceRate: 96000, sourceBits: 24, dsd: false, dop: false, resampled: false, outputRate: 96000, outputFormat: '32-bit', outputBits: 32, mode: 'WASAPI 獨佔', device: '喇叭 (TOPPING USB DAC)', dspActive: true, dspSummary: 'EQ · Sennheiser HD 650 · Crossfeed', volumeMode: 'digital', quality: 'enhanced' }, meter: {} };
  const lyrics = ['', '窓の外 ゆっくり滲む街の灯り', '聞こえない声を 指でなぞって', '明日へ続く 細い線の上', '', '一度だけでいい 振り返らずに', '遠くで鳴ってる 小さな鼓動', 'まだ名前のない この気持ちを', '夜風にのせて 届けにいくよ', '光の粒が 胸に降るまで', '', '窓の外 静かに明けていく空'];
  const trans = [null, '窗外的街燈慢慢暈開', '用指尖描摹聽不見的聲音', '走在通往明天的細線上', null, '只要一次就好 不要回頭', '遠方響起小小的心跳', '這份還沒有名字的心情', '讓夜風帶著它去傳達', '直到光點落進心裡', null, '窗外的天空靜靜亮起'];
  return {
    library: () => ({ revision: 1, albums, tracks }),
    call(m, a, deliver) {
      switch (m) {
        case 'ready': return Promise.resolve({ settings: { folders: ['D:\\MUSIC'], outputMode: 'exclusive', bufferMs: 100, upsampling: 'off', fixedRate: 192000, dop: false, dsdPcmRate: 176400, gapless: true, replayGain: 'off', volumeMode: 'digital', volumeDb: -18.5, onlineArt: true, onlineLyrics: true, artistImages: true, lyricsTranslation: true, favorites: ['t3_2', 't5_1', 't9_3'], presets: [], ui: {},
          dsp: { enabled: true, eqOn: true, preampDb: -6.2, autoPreamp: false, presetName: 'Sennheiser HD 650', bands: [{ on: true, type: 'LSC', fc: 105, gain: 5.5, q: .7 }, { on: true, type: 'PK', fc: 180, gain: -2.1, q: .9 }, { on: true, type: 'PK', fc: 1450, gain: -1.4, q: 1.6 }, { on: true, type: 'PK', fc: 3300, gain: 2.7, q: 2.1 }, { on: true, type: 'PK', fc: 5600, gain: -2.9, q: 4 }, { on: true, type: 'HSC', fc: 10000, gain: 2.2, q: .7 }], crossfeed: { on: true, fc: 700, feed: 4.5 }, balance: 0, invert: false } },
          ffmpeg: true, version: '1.0.0', scan: { scanning: false }, state, queue: { ids: tracks.slice(18, 40).map(t => t[0]), index: 1 } });
        case 'lyrics': return Promise.resolve({ id: a.id, source: '網易雲音樂', synced: true, offset: 0, lines: lyrics.map((t, i) => ({ t: i * 6 + 2, text: t, trans: trans[i] })) });
        case 'devices': return Promise.resolve({ devices: [{ id: 'd1', name: '喇叭 (TOPPING USB DAC)', isDefault: true }, { id: 'd2', name: 'XG32UQ (NVIDIA High Definition Audio)' }], caps: { name: 'TOPPING', mixRate: 48000, mixChannels: 2, summary: '44.1–768 kHz · 最高 32-bit', rates: [44100, 48000, 88200, 96000, 176400, 192000, 352800, 384000, 705600, 768000], formats: {} }, asio: ['TOPPING USB Audio'] });
        case 'art.info': return Promise.resolve({ source: 'online', confirmed: false });
        case 'art.candidates': return Promise.resolve(Array.from({ length: 14 }, (_, i) => ({ url: 'https://media.miku/art/a/c' + i, thumb: 'https://media.miku/art/a/c' + i, title: ['Afterglow', 'Afterglow (Deluxe)', 'Blue Hour', 'Afterglow - Single'][i % 4], artist: 'Sora Ensemble', source: ['Apple Music', 'Deezer', 'Apple Music JP', 'MusicBrainz'][i % 4], size: ['1600px', '1000px', '1600px', '1200px'][i % 4] })));
        case 'suggestFolders': return Promise.resolve(['D:\\MUSIC']);
        // tag editor
        case 'tags.load': {
          const al = albums.find(x => x[0] === a.id);
          const ts = tracks.filter(t => t[3] === a.id);
          return Promise.resolve({ id: a.id, folder: 'D:\\MUSIC\\' + al[1], loose: false, artSource: 'online',
            tracks: ts.map(t => ({ id: t[0], file: String(t[5]).padStart(2, '0') + ' - ' + t[1] + '.flac', path: 'D:\\MUSIC\\' + al[1] + '\\' + String(t[5]).padStart(2, '0') + ' - ' + t[1] + '.flac',
              title: t[1], artist: t[2], albumArtist: al[2], album: al[1], genre: t[5] % 4 ? 'J-Pop' : 'Anime', composer: '', year: al[3], track: t[5], disc: t[4], dur: t[6], codec: t[7], hasPic: false, writable: t[7] !== 'DFF' })) });
        }
        case 'tags.search': return new Promise(res => setTimeout(() => res([
          { source: 'musicbrainz', id: 'mb1', country: 'JP', title: a.album, artist: a.artist, date: '2019-03-06', tracks: tracks.filter(t => t[3] === a.id).length, discs: 1, format: 'CD', label: 'Lantis', thumb: 'https://media.miku/art/a/c1', score: .98 },
          { source: 'apple', id: '1450000001', country: 'jp', title: a.album + ' (Deluxe Edition)', artist: a.artist, date: '2019-03-06', tracks: 14, discs: 0, format: 'Digital', label: '℗ 2019 Lantis', thumb: 'https://media.miku/art/a/c2', score: .8 },
          { source: 'musicbrainz', id: 'mb2', country: 'XW', title: a.album, artist: a.artist, date: '2020', tracks: 20, discs: 2, format: '2×CD', label: '', thumb: '', score: .7 },
        ]), 400));
        case 'tags.release': return new Promise(res => setTimeout(() => {
          const n = a.id === 'mb2' ? 20 : a.id === 'mb1' ? 9 : 14;
          res({ source: a.source, id: a.id, title: 'Afterglow 〜夜明けのうた〜', artist: '星野あおい', date: '2019-03-06', year: 2019, genre: 'Anime', label: 'Lantis',
            cover: 'https://media.miku/art/a/c3', coverThumb: 'https://media.miku/art/a/c3',
            tracks: Array.from({ length: n }, (_, i) => ({ disc: a.id === 'mb2' ? 1 + (i >= 10) : 1, no: a.id === 'mb2' ? i % 10 + 1 : i + 1, title: ['夜明けのうた', 'ブルーアワー', '透明な街', 'Paper Moon', '花火', '雨音', 'Lantern', 'Orbit', 'Signal', 'Drift'][i % 10] + (i >= 10 ? ' (Instrumental)' : ''), artist: i === 3 ? '星野あおい feat. 月白' : '星野あおい', dur: 200 + i * 7 })) });
        }, 300));
        case 'acoustid.info': return Promise.resolve({ hasKey: !!Mock.acoustKey, hasTool: true });
        case 'acoustid.key': Mock.acoustKey = a.key; return Promise.resolve({ hasKey: true });
        case 'tags.identify': return new Promise(res => {
          const ts = tracks.filter(t => t[3] === a.id && (!a.ids.length || a.ids.includes(t[0])));
          let i = 0;
          const out = ts.map((t, k) => k % 5 === 4 ? { id: t[0], status: 'none', on: {} } : { id: t[0], status: 'ok', score: .9 - k * .01, title: '聲紋曲' + (k + 1), artist: '星野あおい', recording: 'r' + k, on: { mb1: '1/' + (ts.length - k), mb9: '1/' + (k + 1) } });
          const step = () => {
            if (i < ts.length) { deliver({ ev: 'fpProgress', d: { id: ts[i][0], state: 'print' } }); deliver({ ev: 'fpProgress', d: { id: ts[i][0], state: out[i].status, title: out[i].title, artist: out[i].artist, score: out[i].score } }); i++; setTimeout(step, 80); return; }
            res({ tracks: out, releases: [{ id: 'mb1', title: 'Afterglow 〜夜明けのうた〜', artist: '星野あおい', date: '2019-03-06', country: 'JP', format: 'CD', tracks: 9, discs: 1, matched: out.filter(o => o.status === 'ok').length }, { id: 'mb9', title: 'Best of', artist: '星野あおい', date: '2022', country: 'JP', format: 'Digital Media', tracks: 30, discs: 2, matched: 4 }] });
          };
          deliver({ ev: 'fpProgress', d: { stage: 'tool' } });
          setTimeout(step, 200);
        });
        case 'tags.save': return new Promise(res => {
          const ids = (a.tracks || []).map(t => t.id);
          const all = a.cover ? tracks.filter(t => t[3] === a.id).map(t => t[0]) : ids;
          let i = 0;
          const step = () => {
            if (i < all.length) { i++; deliver({ ev: 'tagsProgress', d: { done: i, total: all.length, file: all[i - 1] + '.flac' } }); setTimeout(step, 60); return; }
            Mock.lastSave = a;
            res({ albumId: a.id, tracks: tracks.filter(t => t[3] === a.id).length, written: all.length, renamed: (a.rename || []).length, failed: [] });
          };
          step();
        });
        case 'autoeq.search': return Promise.resolve([{ name: 'Sennheiser HD 650', path: 'oratory1990/over-ear/Sennheiser HD 650', source: 'oratory1990' }]);
        default: return Promise.resolve(null);
      }
    },
  };
})();
