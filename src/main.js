const {
  app,
  BrowserWindow,
  desktopCapturer,
  screen,
  ipcMain,
  dialog,
  nativeImage,
  powerMonitor
} = require("electron");

const fs = require("node:fs/promises");
const { execFile } = require("node:child_process");
const path = require("node:path");
const { pathToFileURL } = require("node:url");

let mainWindow;
let captureTimer;
let batteryTimer;
let mediaActivityTimer;
let mediaActivityRefreshInProgress = false;
let previousMediaActivity = null;
let batteryRefreshInProgress = false;
let batteryRefreshPending = false;
let pendingPowerEvent = null;

function notifyPowerState(eventName) {
  if (!mainWindow || mainWindow.isDestroyed()) {
    return;
  }

  if (mainWindow.webContents.isLoading()) {
    pendingPowerEvent = eventName;
  } else {
    mainWindow.webContents.send(eventName);
  }
}

function getActiveMediaApps(output, registryRoot) {
  const activeApps = new Set();
  let keyPath = null;
  let startTime = null;
  let stopTime = 0n;

  const addActiveApp = () => {
    if (!keyPath || startTime === null || startTime <= stopTime) {
      return;
    }

    const relativePath = keyPath.slice(registryRoot.length).replace(/^\\/, "");
    const appPath = relativePath.startsWith("NonPackaged\\")
      ? relativePath.slice("NonPackaged\\".length).replace(/#/g, "\\")
      : null;
    const appName = appPath
      ? path.basename(appPath, path.extname(appPath))
      : relativePath.split("\\")[0].split("_")[0];

    if (appName) {
      activeApps.add(appName);
    }
  };

  output.split(/\r?\n/).forEach((line) => {
    const trimmedLine = line.trim();
    if (!trimmedLine) {
      addActiveApp();
      keyPath = null;
      startTime = null;
      stopTime = 0n;
      return;
    }

    if (trimmedLine.startsWith("HKEY_CURRENT_USER\\")) {
      addActiveApp();
      keyPath = trimmedLine;
      startTime = null;
      stopTime = 0n;
      return;
    }

    const match = trimmedLine.match(/^(LastUsedTimeStart|LastUsedTimeStop)\s+REG_QWORD\s+0x([0-9a-f]+)$/i);
    if (match) {
      const timestamp = BigInt(`0x${match[2]}`);
      if (match[1] === "LastUsedTimeStart") {
        startTime = timestamp;
      } else {
        stopTime = timestamp;
      }
    }
  });

  addActiveApp();
  return activeApps;
}

function refreshMediaActivity() {
  if (process.platform !== "win32" || mediaActivityRefreshInProgress) {
    return;
  }

  mediaActivityRefreshInProgress = true;
  const registryBase = "HKEY_CURRENT_USER\\Software\\Microsoft\\Windows\\CurrentVersion\\CapabilityAccessManager\\ConsentStore";
  const registryRoots = {
    camera: `${registryBase}\\webcam`,
    microphone: `${registryBase}\\microphone`
  };
  const current = { camera: new Set(), microphone: new Set() };
  let completedQueries = 0;
  let queryFailed = false;

  const completeQuery = () => {
    completedQueries += 1;
    if (completedQueries !== Object.keys(registryRoots).length) {
      return;
    }

    mediaActivityRefreshInProgress = false;
    if (queryFailed || !mainWindow || mainWindow.isDestroyed()) {
      return;
    }

    for (const type of ["camera", "microphone"]) {
      const activeApps = current[type];
      const previousApps = previousMediaActivity?.[type] || new Set();
      const addedApps = [...activeApps].filter((appName) => !previousApps.has(appName));
      const removedApps = [...previousApps].filter((appName) => !activeApps.has(appName));

      if (addedApps.length > 0) {
        mainWindow.webContents.send("media:activity", {
          type,
          active: true,
          apps: addedApps
        });
      } else if (removedApps.length > 0 && activeApps.size === 0) {
        mainWindow.webContents.send("media:activity", {
          type,
          active: false,
          apps: removedApps
        });
      }
    }

    previousMediaActivity = current;
  };

  for (const [type, registryRoot] of Object.entries(registryRoots)) {
    execFile(
      "reg.exe",
      ["query", registryRoot, "/s"],
      { windowsHide: true, timeout: 3000, maxBuffer: 1024 * 1024 },
      (error, stdout) => {
        if (error) {
          queryFailed = true;
          console.error(`Media activity check error (${type}):`, error);
        } else {
          current[type] = getActiveMediaApps(stdout, registryRoot);
        }

        completeQuery();
      }
    );
  }
}

function refreshBatteryStatus() {
  if (!mainWindow || mainWindow.isDestroyed() || batteryRefreshInProgress) {
    if (mainWindow && !mainWindow.isDestroyed() && batteryRefreshInProgress) {
      batteryRefreshPending = true;
    }
    return;
  }

  if (process.platform !== "win32") {
    mainWindow.webContents.send("battery:status", null);
    return;
  }

  batteryRefreshInProgress = true;
  const command = "Get-CimInstance -ClassName Win32_Battery | Select-Object -First 1 -Property EstimatedChargeRemaining,BatteryStatus | ConvertTo-Json -Compress";

  execFile(
    "powershell.exe",
    ["-NoProfile", "-NonInteractive", "-Command", command],
    { windowsHide: true, timeout: 5000 },
    (error, stdout) => {
      batteryRefreshInProgress = false;

      if (!mainWindow || mainWindow.isDestroyed()) {
        return;
      }

      if (batteryRefreshPending) {
        batteryRefreshPending = false;
        refreshBatteryStatus();
        return;
      }

      if (error) {
        console.error("Battery status error:", error);
        mainWindow.webContents.send("battery:status", null);
        return;
      }

      const output = stdout.trim();
      if (!output || output === "null") {
        mainWindow.webContents.send("battery:status", null);
        return;
      }

      let battery;
      try {
        battery = JSON.parse(output);
      } catch (parseError) {
        console.error("Unable to parse battery status:", parseError);
        mainWindow.webContents.send("battery:status", null);
        return;
      }

      const level = Number(battery.EstimatedChargeRemaining);
      if (!Number.isFinite(level)) {
        mainWindow.webContents.send("battery:status", null);
        return;
      }

      mainWindow.webContents.send("battery:status", {
        level: Math.max(0, Math.min(100, level)),
        charging: Number(battery.BatteryStatus) === 2
      });
    }
  );
}

const maxMetadataSize = 32 * 1024 * 1024;

async function readBytes(handle, length, position) {
  const buffer = Buffer.alloc(length);
  let bytesRead = 0;

  while (bytesRead < length) {
    const result = await handle.read(
      buffer,
      bytesRead,
      length - bytesRead,
      position + bytesRead
    );
    if (result.bytesRead === 0) break;
    bytesRead += result.bytesRead;
  }

  return buffer.subarray(0, bytesRead);
}

function decodeSynchsafeInteger(buffer, offset) {
  return (
    (buffer[offset] & 0x7f) * 0x200000 +
    (buffer[offset + 1] & 0x7f) * 0x4000 +
    (buffer[offset + 2] & 0x7f) * 0x80 +
    (buffer[offset + 3] & 0x7f)
  );
}

function removeUnsynchronization(buffer) {
  const result = Buffer.alloc(buffer.length);
  let length = 0;

  for (let index = 0; index < buffer.length; index += 1) {
    result[length] = buffer[index];
    length += 1;
    if (buffer[index] === 0xff && buffer[index + 1] === 0) {
      index += 1;
    }
  }

  return result.subarray(0, length);
}

function findId3TextTerminator(buffer, start, encoding) {
  if (encoding === 1 || encoding === 2) {
    for (let index = start; index + 1 < buffer.length; index += 2) {
      if (buffer[index] === 0 && buffer[index + 1] === 0) return index;
    }
    return buffer.length;
  }

  const end = buffer.indexOf(0, start);
  return end < 0 ? buffer.length : end;
}

function decodeId3Text(buffer) {
  if (buffer.length < 2) return "";

  const encoding = buffer[0];
  let data = buffer.subarray(1);
  let text;

  if (encoding === 1) {
    if (data.length >= 2 && data[0] === 0xfe && data[1] === 0xff) {
      data = data.subarray(2);
      const bigEndian = Buffer.alloc(data.length - data.length % 2);
      for (let index = 0; index + 1 < data.length; index += 2) {
        bigEndian[index] = data[index + 1];
        bigEndian[index + 1] = data[index];
      }
      text = bigEndian.toString("utf16le");
    } else {
      text = data.toString("utf16le");
    }
  } else if (encoding === 2) {
    const bigEndian = Buffer.alloc(data.length - data.length % 2);
    for (let index = 0; index + 1 < data.length; index += 2) {
      bigEndian[index] = data[index + 1];
      bigEndian[index + 1] = data[index];
    }
    text = bigEndian.toString("utf16le");
  } else {
    text = data.toString(encoding === 3 ? "utf8" : "latin1");
  }

  return text.replace(/^\uFEFF/, "").replace(/\0/g, "").trim();
}

function parseId3Picture(frame, version) {
  if (frame.length < 5) return null;

  const encoding = frame[0];
  let cursor = 1;
  let mime;

  if (version === 2) {
    const format = frame.subarray(cursor, cursor + 3).toString("ascii").toUpperCase();
    mime = format === "PNG" ? "image/png" : "image/jpeg";
    cursor += 3;
  } else {
    const mimeEnd = frame.indexOf(0, cursor);
    if (mimeEnd < 0) return null;
    mime = frame.subarray(cursor, mimeEnd).toString("ascii") || "image/jpeg";
    cursor = mimeEnd + 1;
  }

  cursor += 1;
  const descriptionEnd = findId3TextTerminator(frame, cursor, encoding);
  const dataStart = descriptionEnd + (encoding === 1 || encoding === 2 ? 2 : 1);
  if (dataStart >= frame.length) return null;

  return {
    mime,
    data: frame.subarray(dataStart)
  };
}

function parseId3Metadata(tag, version, flags) {
  const metadata = {};
  let data = flags & 0x80 ? removeUnsynchronization(tag) : tag;
  let offset = 0;

  if (flags & 0x40) {
    if (version === 3 && data.length >= 4) {
      offset = 4 + data.readUInt32BE(0);
    } else if (version === 4 && data.length >= 4) {
      offset = decodeSynchsafeInteger(data, 0);
    }
  }

  while (offset < data.length) {
    const headerSize = version === 2 ? 6 : 10;
    const idSize = version === 2 ? 3 : 4;
    if (offset + headerSize > data.length) break;

    const id = data.subarray(offset, offset + idSize).toString("ascii");
    if (!id.trim()) break;

    const size = version === 2
      ? data.readUIntBE(offset + 3, 3)
      : version === 4
        ? decodeSynchsafeInteger(data, offset + 4)
        : data.readUInt32BE(offset + 4);
    const frameStart = offset + headerSize;
    const frameEnd = frameStart + size;
    if (size <= 0 || frameEnd > data.length) break;

    const formatFlags = version === 2 ? 0 : data[offset + 9];
    const unsupportedFlags = version === 3
      ? formatFlags & 0xc0
      : version === 4
        ? formatFlags & 0x0c
        : 0;
    if (!unsupportedFlags) {
      let frame = data.subarray(frameStart, frameEnd);
      if (version === 4 && formatFlags & 0x40) frame = frame.subarray(1);
      if (version === 4 && formatFlags & 0x02) frame = removeUnsynchronization(frame);
      if (version === 4 && formatFlags & 0x01) frame = frame.subarray(4);

      if (id === "APIC" || id === "PIC") {
        metadata.picture = parseId3Picture(frame, version);
      } else if (id === "TIT2" || id === "TT2") {
        metadata.title = decodeId3Text(frame);
      } else if (id === "TPE1" || id === "TP1") {
        metadata.artist = decodeId3Text(frame);
      }
    }

    offset = frameEnd;
    if (metadata.picture && metadata.title && metadata.artist) break;
  }

  return metadata;
}

function parseFlacPicture(block) {
  if (block.length < 32) return null;
  let offset = 4;

  const mimeLength = block.readUInt32BE(offset);
  offset += 4;
  if (mimeLength > block.length - offset) return null;
  const mime = block.subarray(offset, offset + mimeLength).toString("utf8");
  offset += mimeLength;

  if (offset + 4 > block.length) return null;
  const descriptionLength = block.readUInt32BE(offset);
  offset += 4 + descriptionLength;
  if (offset + 20 > block.length) return null;

  offset += 16;
  const imageLength = block.readUInt32BE(offset);
  offset += 4;
  if (imageLength === 0 || imageLength > block.length - offset) return null;

  return {
    mime: mime || "image/jpeg",
    data: block.subarray(offset, offset + imageLength)
  };
}

function parseVorbisComments(block) {
  const metadata = {};
  if (block.length < 8) return metadata;

  let offset = 0;
  const vendorLength = block.readUInt32LE(offset);
  offset += 4 + vendorLength;
  if (offset + 4 > block.length) return metadata;

  const commentCount = Math.min(block.readUInt32LE(offset), 10000);
  offset += 4;

  for (let index = 0; index < commentCount && offset + 4 <= block.length; index += 1) {
    const commentLength = block.readUInt32LE(offset);
    offset += 4;
    if (commentLength > block.length - offset) break;

    const comment = block.subarray(offset, offset + commentLength).toString("utf8");
    offset += commentLength;
    const separator = comment.indexOf("=");
    if (separator < 0) continue;

    const key = comment.slice(0, separator).toUpperCase();
    if (key === "TITLE" && !metadata.title) metadata.title = comment.slice(separator + 1);
    if (key === "ARTIST" && !metadata.artist) metadata.artist = comment.slice(separator + 1);
  }

  return metadata;
}

async function readFlacMetadata(handle) {
  const metadata = {};
  let position = 4;
  let scanned = 0;

  while (scanned < maxMetadataSize) {
    const header = await readBytes(handle, 4, position);
    if (header.length < 4) break;

    const isLastBlock = (header[0] & 0x80) !== 0;
    const blockType = header[0] & 0x7f;
    const blockSize = header.readUIntBE(1, 3);
    position += 4;
    scanned += 4 + blockSize;

    if (blockSize > maxMetadataSize) break;
    if (blockType === 4 || blockType === 6) {
      const block = await readBytes(handle, blockSize, position);
      if (block.length === blockSize) {
        if (blockType === 4) Object.assign(metadata, parseVorbisComments(block));
        if (blockType === 6 && !metadata.picture) metadata.picture = parseFlacPicture(block);
      }
    }

    position += blockSize;
    if (isLastBlock || (metadata.picture && metadata.title && metadata.artist)) break;
  }

  return metadata;
}

async function readMp4CoverData(handle, start, end) {
  let position = start;

  while (position + 8 <= end) {
    const header = await readBytes(handle, 8, position);
    if (header.length < 8) break;

    const atomSize = header.readUInt32BE(0);
    const atomType = header.subarray(4, 8).toString("latin1");
    if (atomSize < 8 || position + atomSize > end) break;

    if (atomType === "data" && atomSize >= 16) {
      const dataHeader = await readBytes(handle, 8, position + 8);
      const dataType = dataHeader.readUInt32BE(0);
      const imageData = await readBytes(handle, atomSize - 16, position + 16);
      return {
        mime: dataType === 14 ? "image/png" : "image/jpeg",
        data: imageData
      };
    }

    position += atomSize;
  }

  return null;
}

async function readMp4TextData(handle, start, end) {
  let position = start;

  while (position + 8 <= end) {
    const header = await readBytes(handle, 8, position);
    if (header.length < 8) break;

    const atomSize = header.readUInt32BE(0);
    const atomType = header.subarray(4, 8).toString("latin1");
    if (atomSize < 8 || position + atomSize > end) break;

    if (atomType === "data" && atomSize >= 16) {
      const dataHeader = await readBytes(handle, 8, position + 8);
      if (dataHeader.length < 8) return "";
      const dataType = dataHeader.readUInt32BE(0);
      let textData = await readBytes(handle, atomSize - 16, position + 16);

      if (dataType === 2) {
        const bigEndian = Buffer.alloc(textData.length - textData.length % 2);
        for (let index = 0; index + 1 < textData.length; index += 2) {
          bigEndian[index] = textData[index + 1];
          bigEndian[index + 1] = textData[index];
        }
        textData = bigEndian;
        return textData.toString("utf16le").replace(/\0/g, "").trim();
      }

      return textData.toString("utf8").replace(/\0/g, "").trim();
    }

    position += atomSize;
  }

  return "";
}

async function findMp4Metadata(handle, start, end, metadata = {}, depth = 0) {
  if (depth > 8) return null;
  let position = start;

  while (position + 8 <= end) {
    const header = await readBytes(handle, 8, position);
    if (header.length < 8) break;

    let atomSize = header.readUInt32BE(0);
    const atomType = header.subarray(4, 8).toString("latin1");
    let headerSize = 8;

    if (atomSize === 1) {
      const extendedSize = await readBytes(handle, 8, position + 8);
      if (extendedSize.length < 8) break;
      const largeSize = extendedSize.readBigUInt64BE(0);
      if (largeSize > BigInt(Number.MAX_SAFE_INTEGER)) break;
      atomSize = Number(largeSize);
      headerSize = 16;
    } else if (atomSize === 0) {
      atomSize = end - position;
    }

    if (atomSize < headerSize || position + atomSize > end) break;
    const contentStart = position + headerSize;
    const atomEnd = position + atomSize;

    if (atomType === "covr" && !metadata.picture) {
      metadata.picture = await readMp4CoverData(handle, contentStart, atomEnd);
    } else if (atomType === "\u00a9nam" && !metadata.title) {
      metadata.title = await readMp4TextData(handle, contentStart, atomEnd);
    } else if (atomType === "\u00a9ART" && !metadata.artist) {
      metadata.artist = await readMp4TextData(handle, contentStart, atomEnd);
    }

    if (["moov", "udta", "meta", "ilst"].includes(atomType)) {
      const childStart = contentStart + (atomType === "meta" ? 4 : 0);
      await findMp4Metadata(handle, childStart, atomEnd, metadata, depth + 1);
    }

    position = atomEnd;
  }

  return metadata;
}

async function readAudioMetadata(filePath, handle, fileSize) {
  const extension = path.extname(filePath).toLowerCase();
  const signature = await readBytes(handle, 12, 0);

  if (signature.subarray(0, 3).toString("ascii") === "ID3" || extension === ".mp3") {
    const header = signature.subarray(0, 10);
    if (header.length < 10 || header.subarray(0, 3).toString("ascii") !== "ID3") return {};
    const version = header[3];
    const tagSize = decodeSynchsafeInteger(header, 6);
    if (version < 2 || version > 4 || tagSize > maxMetadataSize) return {};

    const tag = await readBytes(handle, tagSize, 10);
    return tag.length === tagSize ? parseId3Metadata(tag, version, header[5]) : {};
  }

  if (signature.subarray(0, 4).toString("ascii") === "fLaC" || extension === ".flac") {
    return signature.subarray(0, 4).toString("ascii") === "fLaC"
      ? readFlacMetadata(handle)
      : {};
  }

  if ([".m4a", ".mp4", ".m4b"].includes(extension)) {
    return findMp4Metadata(handle, 0, fileSize);
  }

  return {};
}

async function readMusicFile(filePath) {
  const extension = path.extname(filePath);
  const baseName = path.basename(filePath, extension);
  const nameParts = baseName.split(" - ");
  const fallbackArtist = nameParts.length > 1 ? nameParts[0] : "Local file";
  const fallbackTitle = nameParts.length > 1 ? nameParts.slice(1).join(" - ") : baseName;
  const handle = await fs.open(filePath, "r");
  let metadata;

  try {
    const stats = await handle.stat();
    metadata = await readAudioMetadata(filePath, handle, stats.size);
  } finally {
    await handle.close();
  }

  let artwork = null;
  if (metadata.picture && metadata.picture.data.length > 0) {
    try {
      const image = nativeImage.createFromBuffer(metadata.picture.data);
      if (!image.isEmpty()) {
        artwork = image.resize({ width: 320, height: 320 }).toDataURL();
      }
    } catch (error) {
      console.error(`Unable to decode embedded artwork in ${baseName}:`, error);
    }
  }

  return {
    id: filePath,
    url: pathToFileURL(filePath).href,
    title: metadata.title || fallbackTitle,
    artist: metadata.artist || fallbackArtist,
    artwork
  };
}

async function captureDesktop() {
  if (!mainWindow || mainWindow.isDestroyed() || mainWindow.isMinimized()) {
    return;
  }

  try {
    const bounds = mainWindow.getBounds();
    const display = screen.getDisplayMatching(bounds);
    const scale = display.scaleFactor || 1;

    const targetWidth = Math.min(1600, Math.round(display.size.width * scale));
    const targetHeight = Math.round(
      targetWidth * display.size.height / display.size.width
    );

    const sources = await desktopCapturer.getSources({
      types: ["screen"],
      thumbnailSize: {
        width: targetWidth,
        height: targetHeight
      }
    });

    const source = sources.find(
      item => item.display_id === String(display.id)
    ) || sources[0];

    if (!source) return;

    const thumbnail = source.thumbnail;
    const imageSize = thumbnail.getSize();

    const scaleX = imageSize.width / display.size.width;
    const scaleY = imageSize.height / display.size.height;

    const cropX = Math.round(
      (bounds.x - display.bounds.x) * scaleX
    );

    const cropY = Math.round(
      (bounds.y - display.bounds.y) * scaleY
    );

    const cropWidth = Math.min(
      Math.round(bounds.width * scaleX),
      imageSize.width - cropX
    );

    const cropHeight = Math.min(
      Math.round(bounds.height * scaleY),
      imageSize.height - cropY
    );

    if (cropWidth <= 0 || cropHeight <= 0) return;

    const cropped = thumbnail.crop({
      x: cropX,
      y: cropY,
      width: cropWidth,
      height: cropHeight
    });

    const frame = cropped.resize({
      width: 1000,
      height: Math.round(1000 * bounds.height / bounds.width)
    }).toDataURL();

    mainWindow.webContents.send("desktop:frame", frame);

  } catch (error) {
    console.error("Desktop capture error:", error);
  }
}

function createWindow() {
  const primaryDisplay = screen.getPrimaryDisplay();
  const screenWidth = primaryDisplay.workAreaSize.width;

  const winWidth = 500;
  const winHeight = 350;
  const winX = Math.round((screenWidth - winWidth) / 2);
  const winY = 0; // Force it to absolute top

  mainWindow = new BrowserWindow({
    width: winWidth,
    height: winHeight,
    x: winX,
    y: winY,

    frame: false,
    transparent: true,
    backgroundColor: "#00000000",

    resizable: false,
    maximizable: false,
    minimizable: true,

    alwaysOnTop: true,
    skipTaskbar: true,
    hasShadow: false, // Disables OS shadow border padding

    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false
    }
  });

  if (process.platform === "win32" || process.platform === "linux") {
    mainWindow.setShape([{
      x: Math.round((winWidth - 175) / 2),
      y: 0,
      width: 175,
      height: 3
    }]);
  }

  mainWindow.setAlwaysOnTop(true, "screen-saver"); // Higher priority floating level

  if (process.platform === "win32") {
    mainWindow.setContentProtection(true);
  }

  mainWindow.loadFile(path.join(__dirname, "index.html"));

  mainWindow.webContents.once("did-finish-load", () => {
    captureTimer = setInterval(captureDesktop, 100);
    batteryTimer = setInterval(refreshBatteryStatus, 10000);
    mediaActivityTimer = setInterval(refreshMediaActivity, 500);
    refreshMediaActivity();
    refreshBatteryStatus();
    if (pendingPowerEvent) {
      const eventName = pendingPowerEvent;
      pendingPowerEvent = null;
      mainWindow.webContents.send(eventName);
    }
  });

  mainWindow.on("closed", () => {
    clearInterval(captureTimer);
    clearInterval(batteryTimer);
    clearInterval(mediaActivityTimer);
    mainWindow = null;
  });
}

app.whenReady().then(() => {
  ipcMain.on("battery:refresh", refreshBatteryStatus);
  ipcMain.handle("music:choose-files", async (event) => {
    if (!mainWindow || mainWindow.isDestroyed() || event.sender !== mainWindow.webContents) {
      throw new Error("Music files can only be opened by the main application window.");
    }

    const selection = await dialog.showOpenDialog(mainWindow, {
      title: "Open music files",
      properties: ["openFile", "multiSelections"],
      filters: [{
        name: "Audio files",
        extensions: ["mp3", "m4a", "m4b", "mp4", "flac", "wav", "ogg", "opus", "aac", "webm"]
      }]
    });

    if (selection.canceled) {
      return [];
    }

    return Promise.all(selection.filePaths.map(readMusicFile));
  });
  ipcMain.on("island:set-input-region", (_event, region) => {
    if (
      !mainWindow ||
      mainWindow.isDestroyed() ||
      (process.platform !== "win32" && process.platform !== "linux") ||
      !region ||
      !Number.isFinite(region.x) ||
      !Number.isFinite(region.y) ||
      !Number.isFinite(region.width) ||
      !Number.isFinite(region.height)
    ) {
      return;
    }

    const bounds = mainWindow.getBounds();
    const x = Math.max(0, Math.floor(region.x));
    const y = Math.max(0, Math.floor(region.y));
    const right = Math.min(bounds.width, Math.ceil(region.x + region.width));
    const bottom = Math.min(bounds.height, Math.ceil(region.y + region.height));
    const width = right - x;
    const height = bottom - y;

    if (width > 0 && height > 0) {
      mainWindow.setShape([{ x, y, width, height }]);
    }
  });
  powerMonitor.on("on-battery", () => {
    notifyPowerState("battery:charger-disconnected");
    refreshBatteryStatus();
  });
  powerMonitor.on("on-ac", () => {
    notifyPowerState("battery:charger-connected");
    refreshBatteryStatus();
  });
  createWindow();
});

app.on("before-quit", () => {
  clearInterval(captureTimer);
  clearInterval(batteryTimer);
  clearInterval(mediaActivityTimer);
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});