// Mac-native audio additions survive Windows UI synchronization.
Object.assign(I18N_DICT.en, {
  '輸出模式': 'Output mode', 'Core Audio（共享）': 'Core Audio (shared)', 'Core Audio 獨佔': 'Core Audio exclusive',
  '自動匹配取樣率': 'Match sample rate automatically', 'DAC 格式': 'DAC format',
  '每首歌使用原始取樣率；DAC 不支援時停止輸出。': 'Use each track’s original sample rate. Stop if the DAC does not support it.',
  'DAC 不支援或無法取得獨佔時會停止播放，並顯示原因。': 'Stop and explain the reason if the DAC does not support exclusive access or cannot be acquired.',
  '套用 Bit-perfect 設定': 'Apply bit-perfect settings',
  '已套用 Bit-perfect 設定；請用 DAC 調整音量': 'Bit-perfect settings applied. Adjust volume on your DAC.',
  '套用後會先停止播放，關閉 DSP、ReplayGain，設定固定 0 dB。再次播放前請先調低 DAC 音量。': 'Stops playback, disables DSP and ReplayGain, and sets fixed 0 dB. Turn down your DAC before playing again.',
  '獨佔模式使用原生 Core Audio，依歌曲切換 DAC 取樣率。Bit-perfect 需要關閉 DSP、ReplayGain 並使用固定 0 dB；請用 DAC 旋鈕調整音量。': 'Exclusive mode uses native Core Audio and switches the DAC sample rate for each track. Bit-perfect requires DSP and ReplayGain off and fixed 0 dB. Adjust volume on the DAC.',
  '缺少原生音訊元件，請安裝新版 MIKU 才能使用獨佔與自動匹配。': 'Install a newer MIKU build with the native audio engine to use exclusive access and automatic sample-rate switching.',
  '無損音訊以 Core Audio 輸出；此路徑未確認原始樣本數值。': 'Lossless audio through Core Audio. Unchanged original sample values are not verified on this path.',
  '已取得 DAC 獨佔，裝置取樣率與音樂相同；無 DSP、ReplayGain 或數位音量處理。此標示依輸出路徑判定，未逐樣本驗證 DAC 端資料。': 'Exclusive DAC access acquired at the track’s sample rate, without DSP, ReplayGain or digital volume processing. This label describes the output path; the data at the DAC has not been verified sample by sample.'
});
Object.assign(I18N_DICT['zh-Hans'], {
  '輸出模式': '输出模式', 'Core Audio（共享）': 'Core Audio（共享）', 'Core Audio 獨佔': 'Core Audio 独占',
  '自動匹配取樣率': '自动匹配采样率', 'DAC 格式': 'DAC 格式', '套用 Bit-perfect 設定': '应用 Bit-perfect 设置',
  '每首歌使用原始取樣率；DAC 不支援時停止輸出。': '每首歌使用原始采样率；DAC 不支持时停止输出。',
  'DAC 不支援或無法取得獨佔時會停止播放，並顯示原因。': 'DAC 不支持或无法取得独占时会停止播放，并显示原因。',
  '已套用 Bit-perfect 設定；請用 DAC 調整音量': '已应用 Bit-perfect 设置；请用 DAC 调整音量',
  '套用後會先停止播放，關閉 DSP、ReplayGain，設定固定 0 dB。再次播放前請先調低 DAC 音量。': '应用后会先停止播放，关闭 DSP、ReplayGain，设置固定 0 dB。再次播放前请先调低 DAC 音量。',
  '獨佔模式使用原生 Core Audio，依歌曲切換 DAC 取樣率。Bit-perfect 需要關閉 DSP、ReplayGain 並使用固定 0 dB；請用 DAC 旋鈕調整音量。': '独占模式使用原生 Core Audio，依歌曲切换 DAC 采样率。Bit-perfect 需要关闭 DSP、ReplayGain 并使用固定 0 dB；请用 DAC 旋钮调整音量。',
  '缺少原生音訊元件，請安裝新版 MIKU 才能使用獨佔與自動匹配。': '缺少原生音频组件，请安装新版 MIKU 才能使用独占与自动匹配。'
});
Object.assign(I18N_DICT.ja, {
  '輸出模式': '出力モード', 'Core Audio（共享）': 'Core Audio（共有）', 'Core Audio 獨佔': 'Core Audio 排他',
  '自動匹配取樣率': 'サンプルレートを自動で合わせる', 'DAC 格式': 'DAC 形式', '套用 Bit-perfect 設定': 'ビットパーフェクト設定を適用',
  '每首歌使用原始取樣率；DAC 不支援時停止輸出。': '曲の元のサンプルレートで出力します。DAC が非対応の場合は停止します。',
  '已套用 Bit-perfect 設定；請用 DAC 調整音量': 'ビットパーフェクト設定を適用しました。DAC で音量を調整してください。',
  '套用後會先停止播放，關閉 DSP、ReplayGain，設定固定 0 dB。再次播放前請先調低 DAC 音量。': '再生を停止し、DSP と ReplayGain をオフにして、固定 0 dB に設定します。再生する前に DAC の音量を下げてください。',
  '獨佔模式使用原生 Core Audio，依歌曲切換 DAC 取樣率。Bit-perfect 需要關閉 DSP、ReplayGain 並使用固定 0 dB；請用 DAC 旋鈕調整音量。': '排他モードではネイティブ Core Audio を使い、曲に合わせて DAC のサンプルレートを切り替えます。ビットパーフェクトには DSP と ReplayGain をオフにし、固定 0 dB にする必要があります。音量は DAC で調整してください。',
  'DAC 不支援或無法取得獨佔時會停止播放，並顯示原因。': 'DAC が排他モードに対応しない場合や取得できない場合は再生を停止し、理由を表示します。',
  '缺少原生音訊元件，請安裝新版 MIKU 才能使用獨佔與自動匹配。': '排他出力とサンプルレート自動切替を使用するには、ネイティブ音声エンジンを含む新しい MIKU をインストールしてください。'
});

// Shared / exclusive output, device changes (native engine v2).
Object.assign(I18N_DICT["en"], {
  "Core Audio 共享": "Core Audio shared",
  "（Core Audio 獨佔）": " (Core Audio exclusive)",
  "（Core Audio 共享）": " (Core Audio shared)",
  "和 Windows 的 WASAPI 一樣分成共享與獨佔。共享模式與其他程式一起經過 macOS 混音器；獨佔模式由 MIKU 單獨使用 DAC，可達到 bit-perfect（需關閉 DSP、ReplayGain 並使用固定 0 dB，請用 DAC 旋鈕調整音量）。": "Shared and exclusive modes, like WASAPI on Windows. Shared mode goes through the macOS mixer together with other apps; exclusive mode gives MIKU sole use of the DAC and can be bit-perfect (with DSP and ReplayGain off and fixed 0 dB; adjust volume on the DAC).",
  "獨佔：MIKU 單獨使用 DAC（Hog Mode），依歌曲切換取樣率，並把 DAC 設為能完整保留音樂位元深度的格式。切換輸出裝置時會從同一個位置接續播放。裝置不提供獨佔時改用共享模式，並在訊號路徑標示原因。": "Exclusive: MIKU takes sole use of the DAC (hog mode), switches its sample rate for each track and sets a DAC format that keeps every bit of the music. Switching the output continues from the same place. A device without exclusive access plays in shared mode, and the signal path says why.",
  "共享：其他程式的聲音可以同時播放，無法保證 bit-perfect。": "Shared: other apps can play at the same time; bit-perfect output is not guaranteed.",
  "每首歌把 DAC 切換到原始取樣率；DAC 不支援時改用最接近的取樣率並重新取樣。": "Switch the DAC to each track’s original sample rate. If the DAC lacks it, the nearest rate is used with resampling.",
  "每首歌把裝置切換到原始取樣率（同一裝置上的其他程式也會跟著改變）；關閉時依裝置目前的取樣率重新取樣。": "Switch the device to each track’s original sample rate (other apps on the device follow it). When off, tracks are resampled to the device’s current rate.",
  "共享模式經過 macOS 混音器，與其他程式的聲音一起輸出，無法保證 bit-perfect；改用獨佔模式可達到 bit-perfect。": "Shared mode goes through the macOS mixer together with other apps, so bit-perfect output is not guaranteed. Use exclusive mode for bit-perfect playback.",
  "找不到選定的輸出裝置，暫時改用系統預設輸出；裝置接回後會自動切回。": "The selected output device is not connected; playing on the system output until it is back.",
  "這個裝置不提供 Core Audio 獨佔，已改用共享模式": "This device has no Core Audio exclusive access; playing in shared mode",
  "多串流裝置無法獨佔輸出，已改用共享模式": "Multi-stream devices can’t be used exclusively; playing in shared mode",
  "已關閉自動匹配取樣率，{0} kHz 會重新取樣到裝置目前的 {1} kHz。": "Automatic sample-rate matching is off: {0} kHz is resampled to the device’s current {1} kHz.",
  "裝置不支援 {0} kHz，改為重新取樣到 {1} kHz。": "The device doesn’t support {0} kHz; resampling to {1} kHz.",
  "{0} 聲道已混成雙聲道。": "{0} channels are mixed down to stereo.",
  "「{0}」已中斷連線，已暫停播放。重新連接後按播放即可從原位置繼續。": "“{0}” was disconnected and playback is paused. Reconnect it and press Play to continue from the same place.",
  "「{0}」已中斷連線。重新連接後按播放即可從原位置繼續。": "“{0}” was disconnected. Reconnect it and press Play to continue from the same place.",
  "原生音訊核心已重新啟動；按播放即可從原位置繼續": "The native audio engine was restarted. Press Play to continue from the same place.",
  "原生音訊核心多次異常結束；請重新開啟 MIKU": "The native audio engine stopped several times. Please restart MIKU.",
  "找不到可用的輸出裝置；請連接 DAC 或在系統設定選擇輸出裝置": "No output device is available. Connect a DAC or choose an output in System Settings.",
  "輸出裝置正被 {0} 獨佔；請先停止該程式的播放": "The output device is in exclusive use by {0}. Stop playback there first."
});
Object.assign(I18N_DICT["zh-Hans"], {
  "Core Audio 共享": "Core Audio 共享",
  "（Core Audio 獨佔）": "（Core Audio 独占）",
  "（Core Audio 共享）": "（Core Audio 共享）",
  "和 Windows 的 WASAPI 一樣分成共享與獨佔。共享模式與其他程式一起經過 macOS 混音器；獨佔模式由 MIKU 單獨使用 DAC，可達到 bit-perfect（需關閉 DSP、ReplayGain 並使用固定 0 dB，請用 DAC 旋鈕調整音量）。": "和 Windows 的 WASAPI 一样分成共享与独占。共享模式与其他程序一起经过 macOS 混音器；独占模式由 MIKU 单独使用 DAC，可达到 bit-perfect（需关闭 DSP、ReplayGain 并使用固定 0 dB，请用 DAC 旋钮调整音量）。",
  "獨佔：MIKU 單獨使用 DAC（Hog Mode），依歌曲切換取樣率，並把 DAC 設為能完整保留音樂位元深度的格式。切換輸出裝置時會從同一個位置接續播放。裝置不提供獨佔時改用共享模式，並在訊號路徑標示原因。": "独占：MIKU 单独使用 DAC（Hog Mode），依歌曲切换采样率，并把 DAC 设为能完整保留音乐位深的格式。切换输出设备时会从同一个位置接续播放。设备不提供独占时改用共享模式，并在信号路径标示原因。",
  "共享：其他程式的聲音可以同時播放，無法保證 bit-perfect。": "共享：其他程序的声音可以同时播放，无法保证 bit-perfect。",
  "每首歌把 DAC 切換到原始取樣率；DAC 不支援時改用最接近的取樣率並重新取樣。": "每首歌把 DAC 切换到原始采样率；DAC 不支持时改用最接近的采样率并重新采样。",
  "每首歌把裝置切換到原始取樣率（同一裝置上的其他程式也會跟著改變）；關閉時依裝置目前的取樣率重新取樣。": "每首歌把设备切换到原始采样率（同一设备上的其他程序也会跟着改变）；关闭时依设备当前的采样率重新采样。",
  "共享模式經過 macOS 混音器，與其他程式的聲音一起輸出，無法保證 bit-perfect；改用獨佔模式可達到 bit-perfect。": "共享模式经过 macOS 混音器，与其他程序的声音一起输出，无法保证 bit-perfect；改用独占模式可达到 bit-perfect。",
  "找不到選定的輸出裝置，暫時改用系統預設輸出；裝置接回後會自動切回。": "找不到选定的输出设备，暂时改用系统默认输出；设备接回后会自动切回。",
  "這個裝置不提供 Core Audio 獨佔，已改用共享模式": "这个设备不提供 Core Audio 独占，已改用共享模式",
  "多串流裝置無法獨佔輸出，已改用共享模式": "多串流设备无法独占输出，已改用共享模式",
  "已關閉自動匹配取樣率，{0} kHz 會重新取樣到裝置目前的 {1} kHz。": "已关闭自动匹配采样率，{0} kHz 会重新采样到设备当前的 {1} kHz。",
  "裝置不支援 {0} kHz，改為重新取樣到 {1} kHz。": "设备不支持 {0} kHz，改为重新采样到 {1} kHz。",
  "{0} 聲道已混成雙聲道。": "{0} 声道已混成双声道。",
  "「{0}」已中斷連線，已暫停播放。重新連接後按播放即可從原位置繼續。": "「{0}」已断开连接，已暂停播放。重新连接后按播放即可从原位置继续。",
  "「{0}」已中斷連線。重新連接後按播放即可從原位置繼續。": "「{0}」已断开连接。重新连接后按播放即可从原位置继续。",
  "原生音訊核心已重新啟動；按播放即可從原位置繼續": "原生音频核心已重新启动；按播放即可从原位置继续",
  "原生音訊核心多次異常結束；請重新開啟 MIKU": "原生音频核心多次异常结束；请重新打开 MIKU",
  "找不到可用的輸出裝置；請連接 DAC 或在系統設定選擇輸出裝置": "找不到可用的输出设备；请连接 DAC 或在系统设置选择输出设备",
  "輸出裝置正被 {0} 獨佔；請先停止該程式的播放": "输出设备正被 {0} 独占；请先停止该程序的播放"
});
Object.assign(I18N_DICT["ja"], {
  "Core Audio 共享": "Core Audio 共有",
  "（Core Audio 獨佔）": "（Core Audio 排他）",
  "（Core Audio 共享）": "（Core Audio 共有）",
  "和 Windows 的 WASAPI 一樣分成共享與獨佔。共享模式與其他程式一起經過 macOS 混音器；獨佔模式由 MIKU 單獨使用 DAC，可達到 bit-perfect（需關閉 DSP、ReplayGain 並使用固定 0 dB，請用 DAC 旋鈕調整音量）。": "Windows の WASAPI と同じく共有と排他があります。共有モードは他のアプリと一緒に macOS のミキサーを通ります。排他モードでは MIKU が DAC を単独で使い、ビットパーフェクトにできます（DSP と ReplayGain をオフ、固定 0 dB にし、音量は DAC で調整してください）。",
  "獨佔：MIKU 單獨使用 DAC（Hog Mode），依歌曲切換取樣率，並把 DAC 設為能完整保留音樂位元深度的格式。切換輸出裝置時會從同一個位置接續播放。裝置不提供獨佔時改用共享模式，並在訊號路徑標示原因。": "排他：MIKU が DAC を占有し（Hog Mode）、曲ごとにサンプルレートを切り替えて、音楽のビット深度をそのまま保てる DAC フォーマットに設定します。出力を切り替えても同じ位置から再生を続けます。排他に対応しないデバイスでは共有モードで再生し、信号経路に理由を表示します。",
  "共享：其他程式的聲音可以同時播放，無法保證 bit-perfect。": "共有：他のアプリも同時に再生できます。ビットパーフェクトは保証されません。",
  "每首歌把 DAC 切換到原始取樣率；DAC 不支援時改用最接近的取樣率並重新取樣。": "曲ごとに DAC を元のサンプルレートに切り替えます。非対応の場合は最も近いレートにリサンプリングします。",
  "每首歌把裝置切換到原始取樣率（同一裝置上的其他程式也會跟著改變）；關閉時依裝置目前的取樣率重新取樣。": "曲ごとにデバイスを元のサンプルレートに切り替えます（同じデバイスの他のアプリも変わります）。オフの場合はデバイスの現在のレートにリサンプリングします。",
  "共享模式經過 macOS 混音器，與其他程式的聲音一起輸出，無法保證 bit-perfect；改用獨佔模式可達到 bit-perfect。": "共有モードは他のアプリの音と一緒に macOS のミキサーを通るため、ビットパーフェクトは保証されません。排他モードでビットパーフェクトになります。",
  "找不到選定的輸出裝置，暫時改用系統預設輸出；裝置接回後會自動切回。": "選択した出力デバイスが見つからないため、戻るまでシステムの出力で再生します。",
  "這個裝置不提供 Core Audio 獨佔，已改用共享模式": "このデバイスは Core Audio 排他に対応していないため、共有モードで再生しています",
  "多串流裝置無法獨佔輸出，已改用共享模式": "マルチストリームのデバイスは排他にできないため、共有モードで再生しています",
  "已關閉自動匹配取樣率，{0} kHz 會重新取樣到裝置目前的 {1} kHz。": "サンプルレート自動切替がオフのため、{0} kHz をデバイスの現在の {1} kHz にリサンプリングしています。",
  "裝置不支援 {0} kHz，改為重新取樣到 {1} kHz。": "デバイスが {0} kHz に対応していないため、{1} kHz にリサンプリングしています。",
  "{0} 聲道已混成雙聲道。": "{0} チャンネルをステレオにダウンミックスしています。",
  "「{0}」已中斷連線，已暫停播放。重新連接後按播放即可從原位置繼續。": "「{0}」が切断されたため一時停止しました。再接続して再生を押すと同じ位置から続けます。",
  "「{0}」已中斷連線。重新連接後按播放即可從原位置繼續。": "「{0}」が切断されました。再接続して再生を押すと同じ位置から続けます。",
  "原生音訊核心已重新啟動；按播放即可從原位置繼續": "ネイティブ音声エンジンを再起動しました。再生を押すと同じ位置から続けます。",
  "原生音訊核心多次異常結束；請重新開啟 MIKU": "ネイティブ音声エンジンが何度も停止しました。MIKU を再起動してください。",
  "找不到可用的輸出裝置；請連接 DAC 或在系統設定選擇輸出裝置": "使用できる出力デバイスがありません。DAC を接続するか、システム設定で出力を選んでください。",
  "輸出裝置正被 {0} 獨佔；請先停止該程式的播放": "出力デバイスは {0} が排他使用中です。先にそちらの再生を停止してください。"
});
