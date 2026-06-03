const ESPTOOL_CANDIDATES = [
  "https://unpkg.com/esptool-js@0.6.0/bundle.js",
  "https://cdn.jsdelivr.net/npm/esptool-js@0.6.0/bundle.js",
];

const firmwareParts = [
  { name: "bootloader.bin", path: "./binfile/bootloader.bin", address: 0x1000, icon: "🧩" },
  { name: "partitions.bin", path: "./binfile/partitions.bin", address: 0x8000, icon: "🗂️" },
  { name: "telolet_midi_v9.bin", path: "./binfile/telolet_midi_v9.bin", address: 0x10000, icon: "🎶" },
];

let ESPLoader = null;
let Transport = null;
let libReady = false;
let loader = null;
let transport = null;
let serialPort = null;
let loadedFiles = [];
let busy = false;

const $ = (id) => document.getElementById(id);
const ui = {
  browserStatus: $("browserStatus"),
  portStatus: $("portStatus"),
  fileStatus: $("fileStatus"),
  baudrate: $("baudrate"),
  eraseAll: $("eraseAll"),
  debugLog: $("debugLog"),
  connectBtn: $("connectBtn"),
  flashBtn: $("flashBtn"),
  disconnectBtn: $("disconnectBtn"),
  terminal: $("terminal"),
  progressText: $("progressText"),
  progressPercent: $("progressPercent"),
  progressBar: $("progressBar"),
  chipName: $("chipName"),
  activeFile: $("activeFile"),
  finalStatus: $("finalStatus"),
  clearLogBtn: $("clearLogBtn"),
  copyLogBtn: $("copyLogBtn"),
};

function setPill(el, text, type = "") {
  if (!el) return;
  el.textContent = text;
  el.className = `status-pill ${type}`.trim();
}

function log(message = "") {
  const time = new Date().toLocaleTimeString("id-ID", { hour12: false });
  ui.terminal.textContent += `[${time}] ${message}\n`;
  ui.terminal.scrollTop = ui.terminal.scrollHeight;
}

function rawLog(message = "") {
  ui.terminal.textContent += String(message);
  ui.terminal.scrollTop = ui.terminal.scrollHeight;
}

function setProgress(percent, text = "") {
  const safe = Math.max(0, Math.min(100, Number.isFinite(percent) ? percent : 0));
  ui.progressBar.style.width = `${safe}%`;
  ui.progressPercent.textContent = `${Math.round(safe)}%`;
  if (text) ui.progressText.textContent = text;
}

function setBusy(value) {
  busy = value;
  ui.connectBtn.disabled = value || !!loader || !libReady;
  ui.flashBtn.disabled = value || !loader || loadedFiles.length !== firmwareParts.length;
  ui.disconnectBtn.disabled = value || !transport;
  ui.baudrate.disabled = value || !!loader;
  ui.eraseAll.disabled = value;
}

function humanBytes(bytes) {
  if (!Number.isFinite(bytes)) return "0 B";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(2)} MB`;
}

function assertEnvironment() {
  if (!window.isSecureContext) {
    throw new Error("Web Serial butuh HTTPS atau localhost. Buka lewat http://127.0.0.1:3000 / localhost, bukan file://");
  }
  if (!("serial" in navigator)) {
    throw new Error("Browser tidak mendukung Web Serial. Pakai Chrome / Edge desktop versi baru, bukan Firefox/Safari.");
  }
}

function extractLib(mod) {
  if (mod?.ESPLoader && mod?.Transport) return { ESPLoader: mod.ESPLoader, Transport: mod.Transport };
  if (mod?.default?.ESPLoader && mod?.default?.Transport) return { ESPLoader: mod.default.ESPLoader, Transport: mod.default.Transport };
  return null;
}

async function loadEsptool() {
  if (libReady) return;
  setPill(ui.browserStatus, "🌐 Browser: load esptool...", "warn");
  log("Memuat library esptool-js bundle...");

  let lastError = null;
  for (const url of ESPTOOL_CANDIDATES) {
    try {
      log(`Coba load: ${url}`);
      const mod = await import(url);
      const found = extractLib(mod);
      if (!found) throw new Error("Export ESPLoader/Transport tidak ditemukan");
      ESPLoader = found.ESPLoader;
      Transport = found.Transport;
      libReady = true;
      setPill(ui.browserStatus, "🌐 Browser: Web Serial Tersedia", "ok");
      log("✅ esptool-js berhasil dimuat.");
      setBusy(false);
      return;
    } catch (err) {
      lastError = err;
      log(`⚠️ Gagal load dari CDN ini: ${err.message || err}`);
    }
  }

  setPill(ui.browserStatus, "🌐 Browser: library gagal", "bad");
  ui.finalStatus.textContent = "Library error";
  setBusy(false);
  throw new Error(`Gagal memuat esptool-js. Detail: ${lastError?.message || lastError}`);
}

async function fetchBinary(part) {
  const res = await fetch(part.path, { cache: "no-store" });
  if (!res.ok) throw new Error(`${part.name} tidak ditemukan di ${part.path} (HTTP ${res.status})`);
  const buffer = await res.arrayBuffer();
  if (buffer.byteLength === 0) throw new Error(`${part.name} kosong / 0 byte`);
  return new Uint8Array(buffer);
}

async function preloadFirmware() {
  setPill(ui.fileStatus, "📦 File: mengecek...", "warn");
  loadedFiles = [];
  log("Mengecek file firmware di ./binfile/ ...");

  for (const part of firmwareParts) {
    const data = await fetchBinary(part);
    loadedFiles.push({ ...part, data });
    log(`${part.icon} ${part.name} OK - ${humanBytes(data.byteLength)} @ 0x${part.address.toString(16)}`);
  }
  setPill(ui.fileStatus, "📦 Firmware: Semua Siap", "ok");
}

async function pickPort() {
  const remembered = await navigator.serial.getPorts();
  if (remembered?.length) {
    log(`Ditemukan ${remembered.length} port yang sudah pernah diberi izin. Memakai port pertama.`);
    return remembered[0];
  }
  log("Meminta akses serial port...");
  return navigator.serial.requestPort();
}

async function connectDevice() {
  if (busy) return;
  try {
    setBusy(true);
    assertEnvironment();
    await loadEsptool();
    await preloadFirmware();

    serialPort = await pickPort();
    const baudrate = Number(ui.baudrate.value || 115200);
    transport = new Transport(serialPort, true);

    const terminal = {
      clean() {},
      writeLine(data) { log(String(data)); },
      write(data) { rawLog(String(data)); },
    };

    const baseLoader = new ESPLoader({
      transport,
      baudrate,
      romBaudrate: baudrate,
      terminal,
      debugLogging: ui.debugLog.checked,
    });

    setPill(ui.portStatus, "🔌 Port: connecting...", "warn");
    ui.finalStatus.textContent = "Connecting";
    log(`Connecting ke ESP32 @ ${baudrate} baud...`);

    const chip = await baseLoader.main();

    // Penting:
    // ESPLoader.main() di esptool-js bundle ini SUDAH upload & menjalankan stub.
    // Jangan panggil runStub() lagi, karena akan bentrok alamat RAM:
    // "Can't load binary at overlapping address range".
    loader = baseLoader;
    ui.chipName.textContent = chip || "ESP32";
    ui.finalStatus.textContent = "Connected";
    setPill(ui.portStatus, "🔌 Port Serial: Terhubung", "ok");
    log(`✅ Connected: ${chip || "ESP32"}`);
  } catch (err) {
    log(`❌ CONNECT ERROR: ${err.message || err}`);
    log("Tips: tutup Serial Monitor/Arduino IDE, cek kabel data, tahan BOOT saat connect, dan pakai 115200 dulu.");
    ui.finalStatus.textContent = "Error";
    setPill(ui.portStatus, "🔌 Port: gagal", "bad");
    await safeDisconnect(false);
  } finally {
    setBusy(false);
  }
}

async function flashDevice() {
  if (busy || !loader) return;
  try {
    setBusy(true);
    setProgress(0, "Menyiapkan flash...");
    ui.finalStatus.textContent = "Flashing";
    log("Mulai flashing Telolet MIDI V9...");

    if (loadedFiles.length !== firmwareParts.length) await preloadFirmware();

    const totalBytes = loadedFiles.reduce((sum, file) => sum + file.data.byteLength, 0);
    const fileWritten = new Array(loadedFiles.length).fill(0);

    const flashOptions = {
      fileArray: loadedFiles.map((file) => ({ data: file.data, address: file.address })),
      flashSize: "keep",
      eraseAll: ui.eraseAll.checked,
      compress: true,
      // Jangan ubah ke false kecuali muncul error kompresi. Untuk ESP32 normal, true lebih stabil di WebSerial.
      reportProgress: (fileIndex, written, total) => {
        const safeIndex = Math.max(0, Math.min(fileIndex, loadedFiles.length - 1));
        fileWritten[safeIndex] = Math.min(written, loadedFiles[safeIndex].data.byteLength);
        const doneBytes = fileWritten.reduce((sum, value) => sum + value, 0);
        const percent = totalBytes ? (doneBytes / totalBytes) * 100 : 0;
        const active = loadedFiles[safeIndex];
        ui.activeFile.textContent = active?.name || "Belum Ada";
        setProgress(percent, `${active?.icon || "📁"} ${active?.name || "Flashing"} (${humanBytes(written)} / ${humanBytes(total)})`);
      },
    };

    if (ui.eraseAll.checked) log("🧹 Erase all aktif. Proses bisa lebih lama...");
    await loader.writeFlash(flashOptions);

    setProgress(100, "Selesai flashing");
    ui.activeFile.textContent = "-";
    ui.finalStatus.textContent = "Done";
    log("✅ Flash selesai. ESP32 akan reset / boot ke firmware baru.");
    log("✅ Proses flashing berhasil diselesaikan. Perangkat siap digunakan.");

    if (typeof loader.hardReset === "function") {
      try {
        await loader.hardReset();
        log("ESP32 di-reset otomatis.");
      } catch (resetErr) {
        log(`⚠️ Reset otomatis gagal: ${resetErr?.message || resetErr}`);
      }
    }
  } catch (err) {
    ui.finalStatus.textContent = "Flash error";
    log(`❌ FLASH ERROR: ${err.message || err}`);
    log("Tips: matikan Debug log, jangan tekan reset saat erase/flash, cabut-colok ESP32, tahan BOOT saat connect, lalu flash tanpa panggil connect ulang.");
  } finally {
    setBusy(false);
  }
}

async function safeDisconnect(withLog = true) {
  try {
    if (transport?.disconnect) await transport.disconnect();
  } catch (_) {}
  serialPort = null;
  transport = null;
  loader = null;
  ui.chipName.textContent = "-";
  ui.activeFile.textContent = "-";
  setPill(ui.portStatus, "🔌 Port: belum tersambung", "");
  if (withLog) log("Disconnected.");
}

async function disconnectDevice() {
  if (busy) return;
  setBusy(true);
  await safeDisconnect(true);
  ui.finalStatus.textContent = "Idle";
  setProgress(0, "Menunggu...");
  setBusy(false);
}

function init() {
  ui.terminal.textContent = "";
  log("Telolet MIDI V9 Web Flasher siap.");
  log("Pastikan folder ./binfile/ berisi bootloader.bin, partitions.bin, telolet_midi_v9.bin");

  try {
    assertEnvironment();
    setPill(ui.browserStatus, "🌐 Browser: mengecek library...", "warn");
    loadEsptool().catch((err) => log(`❌ ${err.message || err}`));
  } catch (err) {
    setPill(ui.browserStatus, "🌐 Browser: tidak siap", "bad");
    log(`⚠️ ${err.message}`);
  }

  ui.connectBtn.addEventListener("click", connectDevice);
  ui.flashBtn.addEventListener("click", flashDevice);
  ui.disconnectBtn.addEventListener("click", disconnectDevice);
  ui.clearLogBtn.addEventListener("click", () => { ui.terminal.textContent = ""; log("Log dibersihkan."); });
  ui.copyLogBtn.addEventListener("click", async () => {
    try {
      await navigator.clipboard.writeText(ui.terminal.textContent);
      log("📋 Log disalin ke clipboard.");
    } catch {
      log("⚠️ Gagal copy log. Browser menolak akses clipboard.");
    }
  });

  navigator.serial?.addEventListener?.("disconnect", () => {
    log("⚠️ Device serial terputus.");
    safeDisconnect(false).then(() => setBusy(false));
  });

  window.addEventListener("error", (event) => log(`❌ JS ERROR: ${event.message}`));
  window.addEventListener("unhandledrejection", (event) => log(`❌ PROMISE ERROR: ${event.reason?.message || event.reason}`));
}

init();
