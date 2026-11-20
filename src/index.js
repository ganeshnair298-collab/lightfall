const canvas = document.getElementById("glassCanvas");
const gl = canvas.getContext("webgl", {
  alpha: true,
  antialias: true,
  premultipliedAlpha: false,
  preserveDrawingBuffer: false
});

if (!gl) {
  throw new Error("WebGL is not supported.");
}

const vertexShaderSource = `
attribute vec2 aPosition;
varying vec2 vUv;

void main() {
  vUv = aPosition * 0.5 + 0.5;
  gl_Position = vec4(aPosition, 0.0, 1.0);
}
`;

const fragmentShaderSource = `
precision highp float;

varying vec2 vUv;

uniform sampler2D uTexture;
uniform vec2 uResolution;
uniform vec2 uBoxCenter;
uniform vec2 uBoxSize;
uniform float uTime;
const float BLUR_PERCENT = 0.05;
const float BEZEL_DEPTH = 0.30;

// Asymmetric rounded box: 0 radius on top corners, dynamic radius on bottom corners
float asymmetricRoundedBox(vec2 p, vec2 b, float bottomRadius) {
  float r = (p.y > 0.0) ? 0.0 : bottomRadius;
  vec2 q = abs(p) - b + vec2(r);
  return length(max(q, 0.0))
       + min(max(q.x, q.y), 0.0) - r;
}

void main() {
  vec2 pixel = vUv * uResolution;
  vec2 p = pixel - uBoxCenter;

  // Bottom corner radius scales smoothly between collapsed (22px) and expanded (40px)
  float bottomRadius = min(uBoxSize.x * 0.5, min(uBoxSize.y * 0.5, 40.0));

  float distance = asymmetricRoundedBox(
    p,
    uBoxSize * 0.5,
    bottomRadius
  );

  float mask = 1.0 - smoothstep(-1.5, 1.5, distance);

  if (mask <= 0.001) {
    gl_FragColor = vec4(0.0);
    return;
  }

  // Normalized coordinates inside the live lens
  vec2 local = p / uBoxSize;

  float lensShape =
    pow(abs(local.x * 1.5), 4.0) +
    pow(abs(local.y * 1.5), 4.0);

  float edge = 1.0 - smoothstep(0.02, 0.75, lensShape);
  vec2 radial = local * edge;
  vec2 bend = radial * BEZEL_DEPTH;

  vec2 redOffset = bend * 1.35;
  vec2 greenOffset = bend;
  vec2 blueOffset = bend * 0.65;

  vec2 uv = vUv;

  float red = texture2D(uTexture, clamp(uv + redOffset, 0.001, 0.999)).r;
  float green = texture2D(uTexture, clamp(uv + greenOffset, 0.001, 0.999)).g;
  float blue = texture2D(uTexture, clamp(uv + blueOffset, 0.001, 0.999)).b;

  vec2 blurRadius = (uBoxSize / uResolution) * BLUR_PERCENT * edge;
  vec2 blurX = vec2(blurRadius.x, 0.0);
  vec2 blurY = vec2(0.0, blurRadius.y);
  vec2 sampleUV = uv + greenOffset;
  vec3 blurred = texture2D(uTexture, clamp(sampleUV, 0.001, 0.999)).rgb * 4.0;
  blurred += texture2D(uTexture, clamp(sampleUV + blurX, 0.001, 0.999)).rgb;
  blurred += texture2D(uTexture, clamp(sampleUV - blurX, 0.001, 0.999)).rgb;
  blurred += texture2D(uTexture, clamp(sampleUV + blurY, 0.001, 0.999)).rgb;
  blurred += texture2D(uTexture, clamp(sampleUV - blurY, 0.001, 0.999)).rgb;
  blurred *= 0.125;

  vec3 refracted = mix(vec3(red, green, blue), blurred, edge);

  float topLight = smoothstep(0.6, -0.6, local.y);
  float edgeLight = exp(-abs(distance) * 0.22);
  vec3 lighting = vec3(0.18) * topLight + vec3(0.22) * edgeLight;
  vec3 finalColor = refracted + lighting;

  float alpha = mask * 0.99;
  gl_FragColor = vec4(clamp(finalColor, 0.0, 1.0), alpha);
}
`;

function compileShader(type, source) {
  const shader = gl.createShader(type);
  gl.shaderSource(shader, source);
  gl.compileShader(shader);

  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
    const error = gl.getShaderInfoLog(shader);
    gl.deleteShader(shader);
    throw new Error(error);
  }

  return shader;
}

const vertexShader = compileShader(gl.VERTEX_SHADER, vertexShaderSource);
const fragmentShader = compileShader(gl.FRAGMENT_SHADER, fragmentShaderSource);

const program = gl.createProgram();
gl.attachShader(program, vertexShader);
gl.attachShader(program, fragmentShader);
gl.linkProgram(program);

if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
  throw new Error(gl.getProgramInfoLog(program));
}

gl.useProgram(program);

// Full-screen rectangle buffer
const vertices = new Float32Array([
  -1, -1,
   1, -1,
  -1,  1,

  -1,  1,
   1, -1,
   1,  1
]);

const buffer = gl.createBuffer();
gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
gl.bufferData(gl.ARRAY_BUFFER, vertices, gl.STATIC_DRAW);

const position = gl.getAttribLocation(program, "aPosition");
gl.enableVertexAttribArray(position);
gl.vertexAttribPointer(position, 2, gl.FLOAT, false, 0, 0);

// Texture setup
const texture = gl.createTexture();
gl.activeTexture(gl.TEXTURE0);
gl.bindTexture(gl.TEXTURE_2D, texture);

gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true);

gl.uniform1i(gl.getUniformLocation(program, "uTexture"), 0);

// Uniform locations
const resolutionLocation = gl.getUniformLocation(program, "uResolution");
const boxCenterLocation = gl.getUniformLocation(program, "uBoxCenter");
const boxSizeLocation = gl.getUniformLocation(program, "uBoxSize");
const timeLocation = gl.getUniformLocation(program, "uTime");

let textureReady = false;
const image = new Image();

window.lightfall.onDesktopFrame((dataURL) => {
  image.onload = () => {
    gl.bindTexture(gl.TEXTURE_2D, texture);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, image);
    textureReady = true;
  };
  image.src = dataURL;
});

// Responsive canvas sizing
function resizeCanvas() {
  const dpr = Math.min(window.devicePixelRatio || 1, 2);

  canvas.width = Math.round(canvas.clientWidth * dpr);
  canvas.height = Math.round(canvas.clientHeight * dpr);

  gl.viewport(0, 0, canvas.width, canvas.height);

  gl.useProgram(program);
  gl.uniform2f(resolutionLocation, canvas.width, canvas.height);
}

window.addEventListener("resize", resizeCanvas);
resizeCanvas();

const island = document.getElementById("dynamicIsland");
function updateIslandInputRegion(expanded) {
  const managerExpanded = expanded && island.classList.contains("manager-expanded");
  const inlineWidth = Number.parseFloat(island.style.width);
  const inlineHeight = Number.parseFloat(island.style.height);
  const width = Number.isFinite(inlineWidth) ? inlineWidth : expanded ? managerExpanded ? 460 : 420 : 175;
  const height = Number.isFinite(inlineHeight)
    ? inlineHeight
    : expanded
      ? managerExpanded ? 285 : 170
      : island.classList.contains("empty") ? 3 : 22;
  const x = Math.max(0, Math.floor((window.innerWidth - width) / 2));

  window.lightfall.setIslandInputRegion({
    x,
    y: 0,
    width: Math.min(width, window.innerWidth - x),
    height: Math.min(height, window.innerHeight)
  });
}

updateIslandInputRegion(false);

const batteryIndicator = document.createElement("span");
batteryIndicator.setAttribute("role", "status");
batteryIndicator.setAttribute("aria-live", "polite");
batteryIndicator.title = "Battery status unavailable";
batteryIndicator.style.cssText = "display:inline-flex;align-items:center;gap:5px;white-space:nowrap;letter-spacing:1px;transition:color .25s ease;";

const batteryIcon = document.createElement("span");
batteryIcon.setAttribute("aria-hidden", "true");
batteryIcon.style.cssText = "position:relative;display:inline-block;width:17px;height:9px;border:1px solid currentColor;border-radius:2px;padding:1px;transition:border-color .25s ease;";

const batteryFill = document.createElement("span");
batteryFill.style.cssText = "display:block;width:0;height:100%;background:currentColor;border-radius:1px;transition:width .3s ease,background-color .25s ease;";
batteryIcon.appendChild(batteryFill);

const batteryCap = document.createElement("span");
batteryCap.style.cssText = "position:absolute;top:2px;right:-3px;width:2px;height:3px;background:currentColor;border-radius:0 1px 1px 0;";
batteryIcon.appendChild(batteryCap);

const batteryText = document.createElement("span");
batteryText.textContent = "--";

const batteryBolt = document.createElement("span");
batteryBolt.setAttribute("aria-hidden", "true");
batteryBolt.textContent = "⚡";
batteryBolt.style.cssText = "display:none;font-size:12px;line-height:1;text-shadow:0 0 8px currentColor;";

batteryIndicator.append(batteryIcon, batteryBolt, batteryText);
document.querySelector(".island-header").appendChild(batteryIndicator);
let previousChargingState = null;
let latestBatteryLevel = null;

function updateBatteryIndicator(status) {
  if (!status || !Number.isFinite(status.level)) {
    batteryText.textContent = "--";
    batteryFill.style.width = "0";
    batteryIndicator.style.color = "";
    batteryBolt.style.display = "none";
    batteryIndicator.title = "Battery status unavailable";
    return;
  }

  const level = Math.max(0, Math.min(100, status.level));
  const charging = status.charging === true;
  latestBatteryLevel = level;
  batteryText.textContent = `${Math.round(level)}%`;
  batteryFill.style.width = `${level}%`;
  batteryIndicator.style.color = charging ? "#5cff9d" : "";
  batteryBolt.style.display = charging ? "inline" : "none";
  batteryIndicator.title = `Battery ${Math.round(level)}%${charging ? ", charging" : ""}`;
  if (activeChargingPercentage) {
    activeChargingPercentage.textContent = `${Math.round(level)}%`;
  }
}

let browserBatteryFallbackStarted = false;

async function useBrowserBatteryStatus() {
  if (typeof navigator.getBattery !== "function" || browserBatteryFallbackStarted) {
    return;
  }

  browserBatteryFallbackStarted = true;
  try {
    const battery = await navigator.getBattery();
    const update = () => handleBatteryStatus({
      level: battery.level * 100,
      charging: battery.charging
    });

    update();
    battery.addEventListener("levelchange", update);
    battery.addEventListener("chargingchange", update);
  } catch (error) {
    console.error("Unable to read browser battery status:", error);
  }
}

window.lightfall.onBatteryStatus((status) => {
  handleBatteryStatus(status);
  if (!status) {
    useBrowserBatteryStatus();
  }
});

window.lightfall.onChargerConnected(() => {
  previousChargingState = true;
  showPowerPopup(latestBatteryLevel, true);
});

window.lightfall.onChargerDisconnected(() => {
  previousChargingState = false;
  showPowerPopup(latestBatteryLevel, false);
});

let activeMediaActivityPanel;
let activeMediaActivityCleanup;

window.lightfall.onMediaActivity((activity) => {
  showMediaActivityPopup(activity);
});

const prefersReducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)");

let activeChargingPanel;
let inputRegionCollapseTimer;

function collapseInputRegionAfterAnimation() {
  if (inputRegionCollapseTimer) {
    clearTimeout(inputRegionCollapseTimer);
    inputRegionCollapseTimer = null;
  }

  if (island.matches(":hover")) {
    updateIslandInputRegion(true);
  } else if (!activeChargingPanel && !activeMediaActivityPanel) {
    updateIslandInputRegion(false);
  }
}

function scheduleInputRegionCollapse() {
  if (inputRegionCollapseTimer) {
    clearTimeout(inputRegionCollapseTimer);
  }

  if (prefersReducedMotion.matches) {
    collapseInputRegionAfterAnimation();
    return;
  }

  inputRegionCollapseTimer = setTimeout(collapseInputRegionAfterAnimation, 900);
}

island.addEventListener("transitionend", (event) => {
  if (event.target === island && event.propertyName === "height") {
    collapseInputRegionAfterAnimation();
  }
});

function animatePopup() {
  if (prefersReducedMotion.matches) {
    return;
  }

  const popup = island.querySelector(".island-popup");
  popup.animate(
    [
      { opacity: 0, transform: "translateY(38px) scale(.72) rotateX(-14deg)", filter: "blur(14px)" },
      { opacity: 1, transform: "translateY(-8px) scale(1.04) rotateX(2deg)", filter: "blur(0)", offset: 0.72 },
      { opacity: 1, transform: "translateY(0) scale(1) rotateX(0deg)", filter: "blur(0)" }
    ],
    { duration: 950, easing: "cubic-bezier(.16, 1, .3, 1)" }
  );

  popup.querySelectorAll(".island-header, .track-container, .wave-section, .controls, .island-footer")
    .forEach((item, index) => {
      item.animate(
        [
          { opacity: 0, transform: "translateY(26px) scale(.88)" },
          { opacity: 1, transform: "translateY(-3px) scale(1.02)", offset: 0.78 },
          { opacity: 1, transform: "translateY(0) scale(1)" }
        ],
        {
          duration: 680,
          delay: 100 + index * 75,
          easing: "cubic-bezier(.16, 1, .3, 1)"
        }
      );
    });
}

let activeChargingPercentage;
let activePowerCaption;
let activePowerTitle;

function showMediaActivityPopup(activity) {
  const active = activity.active === true;
  const type = activity.type === "camera" ? "CAMERA" : "MICROPHONE";
  const apps = Array.isArray(activity.apps) && activity.apps.length
    ? activity.apps.join(", ")
    : "An app";

  if (activeMediaActivityCleanup) {
    activeMediaActivityCleanup();
  }

  const mini = island.querySelector(".island-mini");
  const popup = island.querySelector(".island-popup");
  const previousStyles = {
    width: island.style.width,
    height: island.style.height,
    borderRadius: island.style.borderRadius,
    opacity: island.style.opacity
  };
  const previousMiniVisibility = mini.style.visibility;
  const previousPopupVisibility = popup.style.visibility;

  const panel = document.createElement("div");
  panel.setAttribute("role", "status");
  panel.setAttribute("aria-live", "assertive");
  panel.style.cssText = "position:absolute;inset:0;z-index:3;display:flex;align-items:center;justify-content:center;gap:20px;padding:20px 28px;color:rgba(255,255,255,.96);pointer-events:none;opacity:0;transform:translateY(25px) scale(.82);";

  const icon = document.createElement("div");
  icon.setAttribute("aria-hidden", "true");
  icon.textContent = activity.type === "camera" ? "◉" : "●";
  icon.style.cssText = "width:64px;height:64px;flex-shrink:0;display:grid;place-items:center;border:1px solid rgba(255,255,255,.35);border-radius:50%;background:radial-gradient(circle,rgba(255,255,255,.22),rgba(255,255,255,.04));font-size:34px;text-shadow:0 0 18px rgba(255,255,255,.75);";

  const message = document.createElement("div");
  message.style.cssText = "min-width:0;display:flex;flex-direction:column;gap:5px;";

  const caption = document.createElement("span");
  caption.textContent = `${type} ${active ? "IN USE" : "USE ENDED"}`;
  caption.style.cssText = "font-size:9px;font-weight:bold;letter-spacing:2px;color:rgba(255,255,255,.62);";

  const title = document.createElement("strong");
  title.textContent = active && activity.type === "camera"
    ? "Camera is started using by this app"
    : `${type} ACCESS ${active ? "DETECTED" : "STOPPED"}`;
  title.style.cssText = "font-size:18px;letter-spacing:1px;line-height:1.2;text-shadow:0 2px 14px rgba(255,255,255,.22);";

  const appDetails = document.createElement("span");
  appDetails.textContent = `Application: ${apps}`;
  appDetails.style.cssText = "font-size:11px;font-weight:bold;letter-spacing:.3px;color:rgba(255,255,255,.7);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;";

  message.append(caption, title, appDetails);
  panel.append(icon, message);
  island.appendChild(panel);
  activeMediaActivityPanel = panel;

  mini.style.visibility = "hidden";
  popup.style.visibility = "hidden";
  island.style.width = "420px";
  island.style.height = "150px";
  island.style.borderRadius = "0 0 32px 32px";
  island.style.opacity = "1";
  updateIslandInputRegion(false);

  const cleanup = () => {
    if (activeMediaActivityPanel !== panel) {
      return;
    }

    panel.remove();
    activeMediaActivityPanel = null;
    activeMediaActivityCleanup = null;
    mini.style.visibility = previousMiniVisibility;
    popup.style.visibility = previousPopupVisibility;
    island.style.width = previousStyles.width;
    island.style.height = previousStyles.height;
    island.style.borderRadius = previousStyles.borderRadius;
    island.style.opacity = previousStyles.opacity;
    if (island.matches(":hover")) {
      updateIslandInputRegion(true);
    } else {
      scheduleInputRegionCollapse();
    }
  };
  activeMediaActivityCleanup = cleanup;

  if (prefersReducedMotion.matches) {
    panel.style.opacity = "1";
    panel.style.transform = "translateY(0) scale(1)";
    setTimeout(cleanup, 3000);
    return;
  }

  island.animate(
    [
      { transform: "translateX(-50%) scale(.78)", opacity: 0.65 },
      { transform: "translateX(-50%) scale(1.08)", opacity: 1, offset: 0.68 },
      { transform: "translateX(-50%) scale(1)", opacity: 1 }
    ],
    { duration: 900, easing: "cubic-bezier(.16, 1, .3, 1)" }
  );
  panel.animate(
    [
      { opacity: 0, transform: "translateY(25px) scale(.82)" },
      { opacity: 1, transform: "translateY(-4px) scale(1.04)", offset: 0.72 },
      { opacity: 1, transform: "translateY(0) scale(1)" }
    ],
    { duration: 700, delay: 120, easing: "cubic-bezier(.16, 1, .3, 1)", fill: "forwards" }
  );

  setTimeout(() => {
    if (activeMediaActivityPanel !== panel) {
      return;
    }

    const dismissal = panel.animate(
      [
        { opacity: 1, transform: "translateY(0) scale(1)" },
        { opacity: 0, transform: "translateY(-12px) scale(.92)" }
      ],
      { duration: 280, easing: "ease-in" }
    );
    dismissal.onfinish = cleanup;
  }, 3000);
}

function showPowerPopup(level, connected) {
  if (activeChargingPanel) {
    activePowerCaption.textContent = connected ? "POWER CONNECTED" : "POWER DISCONNECTED";
    activePowerTitle.textContent = connected ? "BATTERY IS CHARGING" : "CHARGER DISCONNECTED";
    if (Number.isFinite(level)) {
      activeChargingPercentage.textContent = `${Math.round(level)}%`;
    }
    return;
  }

  const mini = island.querySelector(".island-mini");
  const popup = island.querySelector(".island-popup");
  const previousStyles = {
    width: island.style.width,
    height: island.style.height,
    borderRadius: island.style.borderRadius,
    opacity: island.style.opacity
  };
  const previousMiniVisibility = mini.style.visibility;
  const previousPopupVisibility = popup.style.visibility;

  const panel = document.createElement("div");
  panel.setAttribute("role", "status");
  panel.setAttribute("aria-live", "assertive");
  panel.style.cssText = "position:absolute;inset:0;z-index:3;display:flex;align-items:center;justify-content:center;gap:20px;padding:20px 28px;color:rgba(255,255,255,.96);pointer-events:none;opacity:0;transform:translateY(25px) scale(.82);";

  const icon = document.createElement("div");
  icon.setAttribute("aria-hidden", "true");
  icon.textContent = "⚡";
  icon.style.cssText = "width:64px;height:64px;flex-shrink:0;display:grid;place-items:center;border:1px solid rgba(255,255,255,.35);border-radius:50%;background:radial-gradient(circle,rgba(255,255,255,.22),rgba(255,255,255,.04));font-size:38px;text-shadow:0 0 18px rgba(255,255,255,.75);";

  const message = document.createElement("div");
  message.style.cssText = "display:flex;flex-direction:column;gap:5px;";

  const caption = document.createElement("span");
  caption.textContent = connected ? "POWER CONNECTED" : "POWER DISCONNECTED";
  caption.style.cssText = "font-size:9px;font-weight:bold;letter-spacing:2px;color:rgba(255,255,255,.62);";

  const title = document.createElement("strong");
  title.textContent = connected ? "BATTERY IS CHARGING" : "CHARGER DISCONNECTED";
  title.style.cssText = "font-size:18px;letter-spacing:1px;line-height:1.2;text-shadow:0 2px 14px rgba(255,255,255,.22);";

  const percentage = document.createElement("span");
  percentage.textContent = Number.isFinite(level) ? `${Math.round(level)}%` : "--";
  percentage.style.cssText = "font-size:11px;font-weight:bold;letter-spacing:1px;color:rgba(255,255,255,.7);";

  message.append(caption, title, percentage);
  panel.append(icon, message);
  island.appendChild(panel);
  activeChargingPanel = panel;
  activeChargingPercentage = percentage;
  activePowerCaption = caption;
  activePowerTitle = title;

  mini.style.visibility = "hidden";
  popup.style.visibility = "hidden";
  island.style.width = "420px";
  island.style.height = "150px";
  island.style.borderRadius = "0 0 32px 32px";
  island.style.opacity = "1";
  updateIslandInputRegion(false);

  if (!prefersReducedMotion.matches) {
    island.animate(
      [
        { transform: "translateX(-50%) scale(.78)", opacity: 0.65 },
        { transform: "translateX(-50%) scale(1.08)", opacity: 1, offset: 0.68 },
        { transform: "translateX(-50%) scale(.98)", opacity: 1, offset: 0.86 },
        { transform: "translateX(-50%) scale(1)", opacity: 1 }
      ],
      { duration: 900, easing: "cubic-bezier(.16, 1, .3, 1)" }
    );
    panel.animate(
      [
        { opacity: 0, transform: "translateY(25px) scale(.82)" },
        { opacity: 1, transform: "translateY(-4px) scale(1.04)", offset: 0.72 },
        { opacity: 1, transform: "translateY(0) scale(1)" }
      ],
      { duration: 700, delay: 120, easing: "cubic-bezier(.16, 1, .3, 1)", fill: "forwards" }
    );
    icon.animate(
      [
        { transform: "scale(.6) rotate(-35deg)" },
        { transform: "scale(1.18) rotate(12deg)", offset: 0.65 },
        { transform: "scale(1) rotate(0deg)" }
      ],
      { duration: 800, delay: 120, easing: "cubic-bezier(.16, 1, .3, 1)" }
    );
  } else {
    panel.style.opacity = "1";
    panel.style.transform = "translateY(0) scale(1)";
  }

  setTimeout(() => {
    const cleanup = () => {
      panel.remove();
      mini.style.visibility = previousMiniVisibility;
      popup.style.visibility = previousPopupVisibility;
      island.style.width = previousStyles.width;
      island.style.height = previousStyles.height;
      island.style.borderRadius = previousStyles.borderRadius;
      island.style.opacity = previousStyles.opacity;
      activeChargingPanel = null;
      activeChargingPercentage = null;
      activePowerCaption = null;
      activePowerTitle = null;
      if (island.matches(":hover")) {
        updateIslandInputRegion(true);
      } else {
        scheduleInputRegionCollapse();
      }
    };

    if (prefersReducedMotion.matches) {
      cleanup();
      return;
    }

    const dismissal = panel.animate(
      [
        { opacity: 1, transform: "translateY(0) scale(1)" },
        { opacity: 0, transform: "translateY(-12px) scale(.92)" }
      ],
      { duration: 280, easing: "ease-in" }
    );
    dismissal.onfinish = cleanup;
  }, 3000);
}

function handleBatteryStatus(status) {
  updateBatteryIndicator(status);
  if (!status || !Number.isFinite(status.level)) {
    return;
  }

  const charging = status.charging === true;
  if (previousChargingState === false && charging) {
    showPowerPopup(status.level, true);
  } else if (previousChargingState === true && !charging) {
    showPowerPopup(status.level, false);
  }
  previousChargingState = charging;
}

island.addEventListener("pointerenter", () => {
  if (inputRegionCollapseTimer) {
    clearTimeout(inputRegionCollapseTimer);
    inputRegionCollapseTimer = null;
  }
  updateIslandInputRegion(true);
  updateSystemMonitorVisibility();
  animatePopup();
  window.lightfall.requestBatteryStatus();
});

island.addEventListener("pointerleave", () => {
  scheduleInputRegionCollapse();
  updateSystemMonitorVisibility();
});

// Live-Synced Render Loop
function render(time) {
  gl.clearColor(0, 0, 0, 0);
  gl.clear(gl.COLOR_BUFFER_BIT);

  gl.useProgram(program);

  const rect = island.getBoundingClientRect();
  const dpr = Math.min(window.devicePixelRatio || 1, 2);

  const boxWidth = rect.width * dpr;
  const boxHeight = rect.height * dpr;
  const boxX = rect.left * dpr + boxWidth * 0.5;
  const boxY = canvas.height - (rect.top * dpr + boxHeight * 0.5);

  gl.uniform2f(boxCenterLocation, boxX, boxY);
  gl.uniform2f(boxSizeLocation, boxWidth, boxHeight);
  gl.uniform1f(timeLocation, time * 0.001);

  if (textureReady) {
    gl.drawArrays(gl.TRIANGLES, 0, 6);
  }

  requestAnimationFrame(render);
}

gl.enable(gl.BLEND);
gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
requestAnimationFrame(render);

// Audio and waveform player logic
const audio = document.getElementById("audio");
const playButton = document.getElementById("playBtn");
const waveform = document.getElementById("waveform");
const albumArt = document.getElementById("albumArt");
const trackArtist = document.getElementById("trackArtist");
const favoriteButton = document.getElementById("favoriteBtn");
const closeSongButton = document.getElementById("closeSongBtn");
const shuffleButton = document.getElementById("shuffleBtn");
const previousButton = document.getElementById("previousBtn");
const nextButton = document.getElementById("nextBtn");
const repeatButton = document.getElementById("repeatBtn");
const miniPlayer = island.querySelector(".island-mini");
const playlist = [];
const favorites = new Set();
let currentTrackIndex = -1;
let shuffleEnabled = false;
let repeatMode = "off";
let managerSelected = false;

const musicTab = document.getElementById("musicTab");
const managerTab = document.getElementById("managerTab");
const musicView = document.getElementById("musicView");
const managerView = document.getElementById("managerView");
const sectionLabel = document.getElementById("sectionLabel");
const systemCpuValue = document.getElementById("systemCpuValue");
const appCpuValue = document.getElementById("appCpuValue");
const cpuMeter = document.getElementById("cpuMeter");
const systemMemoryValue = document.getElementById("systemMemoryValue");
const cpuDetails = document.getElementById("cpuDetails");
const memoryDetails = document.getElementById("memoryDetails");
const memoryMeter = document.getElementById("memoryMeter");
const gpuName = document.getElementById("gpuName");
const gpuDriver = document.getElementById("gpuDriver");
const cpuTempValue = document.getElementById("cpuTempValue");
const cpuTempSource = document.getElementById("cpuTempSource");
const gpuTempValue = document.getElementById("gpuTempValue");
const gpuTempSource = document.getElementById("gpuTempSource");
const appMemoryValue = document.getElementById("appMemoryValue");
const appProcessValue = document.getElementById("appProcessValue");

function updateSystemMonitorVisibility() {
  window.lightfall.setSystemMonitorActive(managerSelected && island.matches(":hover"));
}

function selectIslandView(view) {
  managerSelected = view === "manager";
  island.classList.toggle("manager-expanded", managerSelected);
  musicTab.classList.toggle("active", !managerSelected);
  managerTab.classList.toggle("active", managerSelected);
  musicTab.setAttribute("aria-selected", String(!managerSelected));
  managerTab.setAttribute("aria-selected", String(managerSelected));
  musicView.hidden = managerSelected;
  managerView.hidden = !managerSelected;
  sectionLabel.textContent = managerSelected ? "SYSTEM MANAGER" : "NOW PLAYING";
  closeSongButton.hidden = managerSelected || playlist.length === 0;
  updateIslandInputRegion(island.matches(":hover"));
  updateSystemMonitorVisibility();
}

function updateSystemMetrics(metrics) {
  if (metrics.error) {
    systemCpuValue.textContent = "N/A";
    appCpuValue.textContent = "APP N/A";
    cpuMeter.style.width = "0";
    systemMemoryValue.textContent = "N/A";
    memoryMeter.style.width = "0";
    cpuDetails.textContent = metrics.error;
    memoryDetails.textContent = metrics.error;
    gpuName.textContent = "GPU unavailable";
    gpuDriver.textContent = metrics.error;
    appMemoryValue.textContent = "N/A";
    appProcessValue.textContent = "System usage unavailable";
    return;
  }

  const systemCpu = Number.isFinite(metrics.systemCpuPercent) ? metrics.systemCpuPercent : null;
  const appCpu = Number.isFinite(metrics.appCpuPercent) ? metrics.appCpuPercent : null;
  const totalMemory = Number(metrics.totalMemoryBytes);
  const freeMemory = Number(metrics.freeMemoryBytes);
  const usedMemory = totalMemory - freeMemory;
  const memoryValid = Number.isFinite(totalMemory) && totalMemory > 0 && Number.isFinite(usedMemory);

  systemCpuValue.textContent = systemCpu === null ? "--%" : `${systemCpu.toFixed(0)}%`;
  appCpuValue.textContent = appCpu === null ? "APP --%" : `APP ${appCpu.toFixed(1)}%`;
  cpuMeter.style.width = systemCpu === null ? "0" : `${systemCpu}%`;
  cpuDetails.textContent = metrics.cpuModel
    ? `${metrics.logicalCoreCount} threads · ${metrics.cpuSpeedMhz || "--"} MHz · ${metrics.cpuModel}`
    : `${metrics.logicalCoreCount || "--"} logical processors`;
  cpuDetails.title = cpuDetails.textContent;

  systemMemoryValue.textContent = memoryValid
    ? `${(usedMemory / 1024 ** 3).toFixed(1)} / ${(totalMemory / 1024 ** 3).toFixed(1)} GB`
    : "N/A";
  memoryDetails.textContent = memoryValid
    ? `${(freeMemory / 1024 ** 3).toFixed(1)} GB available`
    : "Memory details unavailable";
  memoryMeter.style.width = memoryValid
    ? `${Math.max(0, Math.min(100, usedMemory / totalMemory * 100))}%`
    : "0";

  const gpu = metrics.gpu || {};
  const gpuModel = typeof gpu.name === "string" ? gpu.name : "";
  const gpuVendor = typeof gpu.vendor === "string" ? gpu.vendor : "";
  gpuName.textContent = gpuVendor && !gpuModel.toLowerCase().includes(gpuVendor.toLowerCase())
    ? `${gpuVendor} ${gpuModel}`
    : gpuModel || "GPU unavailable";
  gpuName.title = gpuName.textContent;
  gpuDriver.textContent = gpu.driver || "Driver details unavailable";
  appMemoryValue.textContent = Number.isFinite(metrics.appMemoryBytes)
    ? `${(metrics.appMemoryBytes / 1024 ** 2).toFixed(0)} MB`
    : "N/A";
  appProcessValue.textContent = `App memory · ${appCpu === null ? "--" : appCpu.toFixed(1)}% CPU · ${metrics.processCount || 0} processes`;
}

function updateSystemTemperatures(temperatures) {
  cpuTempValue.textContent = Number.isFinite(temperatures.cpuC)
    ? `${temperatures.cpuC.toFixed(0)}°C`
    : "N/A";
  cpuTempSource.textContent = temperatures.cpuSource || "ACPI sensor unavailable";
  gpuTempValue.textContent = Number.isFinite(temperatures.gpuC)
    ? `${temperatures.gpuC.toFixed(0)}°C`
    : "N/A";
  gpuTempSource.textContent = temperatures.gpuSource || "Not exposed by this GPU driver";
}

musicTab.addEventListener("click", () => selectIslandView("music"));
managerTab.addEventListener("click", () => selectIslandView("manager"));
window.lightfall.onSystemMetrics(updateSystemMetrics);
window.lightfall.onSystemTemperatures(updateSystemTemperatures);

const miniPlayButton = document.createElement("button");
miniPlayButton.type = "button";
miniPlayButton.setAttribute("aria-label", "Play");
miniPlayButton.title = "Play";
miniPlayButton.textContent = "▶";
miniPlayButton.style.cssText = "flex:0 0 16px;width:16px;height:16px;padding:0;border:0;background:transparent;color:inherit;font-size:10px;line-height:1;cursor:pointer;";

const miniProgressTrack = document.createElement("div");
miniProgressTrack.setAttribute("role", "slider");
miniProgressTrack.setAttribute("aria-label", "Playback progress");
miniProgressTrack.setAttribute("aria-valuemin", "0");
miniProgressTrack.setAttribute("aria-valuemax", "100");
miniProgressTrack.setAttribute("aria-valuenow", "0");
miniProgressTrack.tabIndex = 0;
miniProgressTrack.style.cssText = "position:relative;flex:1;height:3px;overflow:hidden;border-radius:4px;background:rgba(255,255,255,.25);cursor:pointer;";

const miniProgressFill = document.createElement("span");
miniProgressFill.style.cssText = "position:absolute;inset:0 auto 0 0;width:0;border-radius:inherit;background:rgba(255,255,255,.9);transition:width .12s linear;";
miniProgressTrack.appendChild(miniProgressFill);

const miniCloseButton = document.createElement("button");
miniCloseButton.type = "button";
miniCloseButton.setAttribute("aria-label", "Close song");
miniCloseButton.title = "Close song";
miniCloseButton.textContent = "×";
miniCloseButton.style.cssText = "flex:0 0 16px;width:16px;height:16px;padding:0;border:0;background:transparent;color:inherit;font-size:15px;line-height:1;cursor:pointer;";
miniCloseButton.hidden = true;
miniPlayer.append(miniPlayButton, miniProgressTrack, miniCloseButton);

albumArt.setAttribute("role", "button");
albumArt.setAttribute("tabindex", "0");
albumArt.setAttribute("aria-label", "Open music files");
albumArt.title = "Open music files (Ctrl+O)";
albumArt.style.cursor = "pointer";

waveform.setAttribute("role", "slider");
waveform.setAttribute("aria-label", "Playback progress");
waveform.setAttribute("aria-valuemin", "0");
waveform.setAttribute("aria-valuemax", "100");
waveform.setAttribute("aria-valuenow", "0");
waveform.tabIndex = 0;

const waveformSvg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
waveformSvg.setAttribute("viewBox", "0 0 300 40");
waveformSvg.setAttribute("preserveAspectRatio", "none");
waveformSvg.setAttribute("aria-hidden", "true");

const waveformPath = document.createElementNS("http://www.w3.org/2000/svg", "path");
const waveformPoints = [{ x: 0, y: 20 }];
for (let index = 1; index < 20; index += 1) {
  waveformPoints.push({ x: index * 15, y: index % 2 ? 14 : 26 });
}
waveformPoints.push({ x: 300, y: 20 });

let waveformPathData = `M ${waveformPoints[0].x} ${waveformPoints[0].y}`;
for (let index = 1; index < waveformPoints.length; index += 1) {
  const previous = waveformPoints[index - 1];
  const point = waveformPoints[index];
  const middleX = (previous.x + point.x) / 2;
  waveformPathData += ` C ${middleX} ${previous.y} ${middleX} ${point.y} ${point.x} ${point.y}`;
}

waveformPath.setAttribute("d", waveformPathData);
waveformPath.setAttribute("pathLength", "100");
waveformPath.classList.add("waveform-progress");
waveformPath.style.strokeDasharray = "100";
waveformPath.style.strokeDashoffset = "100";

const waveformTrack = waveformPath.cloneNode();
waveformTrack.classList.remove("waveform-progress");
waveformTrack.classList.add("waveform-track");
waveformTrack.style.strokeDasharray = "";
waveformTrack.style.strokeDashoffset = "";
waveformSvg.append(waveformTrack, waveformPath);
waveform.appendChild(waveformSvg);

function formatTime(time) {
  if (!Number.isFinite(time)) return "0:00";
  const minutes = Math.floor(time / 60);
  const seconds = Math.floor(time % 60);
  return `${minutes}:${String(seconds).padStart(2, "0")}`;
}

function updatePlaybackProgress() {
  document.getElementById("currentTime").textContent = formatTime(audio.currentTime);
  document.getElementById("duration").textContent = formatTime(audio.duration);

  const progress = Number.isFinite(audio.duration) && audio.duration > 0
    ? Math.max(0, Math.min(1, audio.currentTime / audio.duration))
    : 0;
  miniProgressFill.style.width = `${progress * 100}%`;
  miniProgressTrack.setAttribute("aria-valuenow", String(Math.round(progress * 100)));
  waveform.setAttribute("aria-valuenow", String(Math.round(progress * 100)));
  waveformPath.style.strokeDashoffset = String(100 * (1 - progress));
}

function reportPlaybackError(error) {
  console.error("Unable to play audio:", error);
  if (currentTrackIndex >= 0) {
    trackArtist.textContent = "Unable to play this audio file";
  }
}

function startPlayback() {
  const playRequest = audio.play();
  if (playRequest && typeof playRequest.catch === "function") {
    playRequest.catch(reportPlaybackError);
  }
}

function togglePlayback() {
  if (playlist.length === 0) {
    openMusicFiles();
    return;
  }

  if (audio.paused) {
    if (audio.ended) {
      audio.currentTime = 0;
    }
    startPlayback();
  } else {
    audio.pause();
  }
}

function updateFavoriteButton(track) {
  const isFavorite = Boolean(track && favorites.has(track.id));
  favoriteButton.textContent = isFavorite ? "♥" : "♡";
  favoriteButton.setAttribute("aria-pressed", String(isFavorite));
  favoriteButton.title = isFavorite ? "Remove from favorites" : "Add to favorites";
}

function showTrack(track) {
  window.updateIslandTrack(track.title, track.artist, track.artwork);
  updateFavoriteButton(track);
}

function playTrack(index, autoplay) {
  if (index < 0 || index >= playlist.length) {
    return;
  }

  const track = playlist[index];
  currentTrackIndex = index;
  closeSongButton.hidden = managerSelected;
  miniCloseButton.hidden = false;
  audio.pause();
  audio.src = track.url;
  audio.load();
  updatePlaybackProgress();
  showTrack(track);

  if (autoplay) {
    startPlayback();
  }
}

function addMusicFiles(tracks) {
  const validTracks = Array.from(tracks).filter(track =>
    track &&
    typeof track.id === "string" &&
    typeof track.url === "string" &&
    typeof track.title === "string" &&
    typeof track.artist === "string"
  );

  if (validTracks.length === 0) {
    trackArtist.textContent = "No playable audio files selected";
    return;
  }

  const firstTrackIndex = playlist.length;
  playlist.push(...validTracks);
  island.classList.remove("empty");
  closeSongButton.hidden = managerSelected;
  if (!island.matches(":hover")) {
    updateIslandInputRegion(false);
  }
  playTrack(firstTrackIndex, true);
}

async function openMusicFiles() {
  try {
    const tracks = await window.lightfall.chooseMusicFiles();
    if (tracks.length > 0) {
      addMusicFiles(tracks);
    }
  } catch (error) {
    console.error("Unable to open music files:", error);
    trackArtist.textContent = "Unable to open music files";
  }
}

function closeCurrentPlaylist() {
  audio.pause();
  audio.removeAttribute("src");
  audio.load();
  playlist.length = 0;
  favorites.clear();
  currentTrackIndex = -1;
  closeSongButton.hidden = true;
  miniCloseButton.hidden = true;
  island.classList.add("empty");
  window.updateIslandTrack("Choose a song", "Click album art or press Ctrl+O");
  updateFavoriteButton(null);
  updatePlaybackProgress();
  updateIslandInputRegion(island.matches(":hover"));
}

function chooseRandomTrack() {
  if (playlist.length < 2) {
    return currentTrackIndex;
  }

  const nextIndex = Math.floor(Math.random() * (playlist.length - 1));
  return nextIndex >= currentTrackIndex ? nextIndex + 1 : nextIndex;
}

function skipToNextTrack(automatic) {
  if (playlist.length === 0) {
    if (!automatic) openMusicFiles();
    return;
  }

  if (shuffleEnabled && playlist.length > 1) {
    playTrack(chooseRandomTrack(), true);
  } else if (currentTrackIndex < playlist.length - 1) {
    playTrack(currentTrackIndex + 1, true);
  } else if (repeatMode === "all") {
    playTrack(0, true);
  }
}

function skipToPreviousTrack() {
  if (playlist.length === 0) {
    openMusicFiles();
    return;
  }

  if (audio.currentTime > 3) {
    audio.currentTime = 0;
    updatePlaybackProgress();
    return;
  }

  if (currentTrackIndex > 0) {
    playTrack(currentTrackIndex - 1, true);
  } else if (repeatMode === "all") {
    playTrack(playlist.length - 1, true);
  } else {
    audio.currentTime = 0;
    updatePlaybackProgress();
  }
}

function seekFromPointer(element, event) {
  if (!Number.isFinite(audio.duration) || audio.duration <= 0) {
    return;
  }

  const rect = element.getBoundingClientRect();
  if (rect.width <= 0) {
    return;
  }

  const progress = Math.max(0, Math.min(1, (event.clientX - rect.left) / rect.width));
  audio.currentTime = progress * audio.duration;
  updatePlaybackProgress();
}

function animateButton(button) {
  if (prefersReducedMotion.matches) {
    return;
  }

  button.animate(
    [
      { transform: "scaleX(1) scaleY(1)" },
      { transform: "scaleX(1.38) scaleY(.88)", offset: 0.42 },
      { transform: "scaleX(.9) scaleY(1.12)", offset: 0.7 },
      { transform: "scaleX(1.08) scaleY(.96)", offset: 0.88 },
      { transform: "scale(1)" }
    ],
    { duration: 620, easing: "cubic-bezier(.16, 1, .3, 1)" }
  );
}

playButton.addEventListener("click", togglePlayback);
miniPlayButton.addEventListener("click", togglePlayback);
previousButton.addEventListener("click", skipToPreviousTrack);
nextButton.addEventListener("click", () => skipToNextTrack(false));
closeSongButton.addEventListener("click", closeCurrentPlaylist);
miniCloseButton.addEventListener("click", closeCurrentPlaylist);

shuffleButton.setAttribute("aria-pressed", "false");
shuffleButton.title = "Shuffle off";
shuffleButton.addEventListener("click", () => {
  shuffleEnabled = !shuffleEnabled;
  shuffleButton.setAttribute("aria-pressed", String(shuffleEnabled));
  shuffleButton.title = `Shuffle ${shuffleEnabled ? "on" : "off"}`;
  shuffleButton.style.color = shuffleEnabled ? "white" : "";
});

repeatButton.setAttribute("aria-pressed", "false");
repeatButton.title = "Repeat off";
repeatButton.addEventListener("click", () => {
  repeatMode = repeatMode === "off" ? "all" : repeatMode === "all" ? "one" : "off";
  repeatButton.setAttribute("aria-pressed", String(repeatMode !== "off"));
  repeatButton.title = `Repeat ${repeatMode}`;
  repeatButton.style.color = repeatMode === "off" ? "" : "white";
});

favoriteButton.addEventListener("click", () => {
  const track = playlist[currentTrackIndex];
  if (!track) {
    return;
  }

  if (favorites.has(track.id)) {
    favorites.delete(track.id);
  } else {
    favorites.add(track.id);
  }
  updateFavoriteButton(track);
});

albumArt.addEventListener("click", openMusicFiles);
albumArt.addEventListener("keydown", (event) => {
  if (event.key === "Enter" || event.key === " ") {
    event.preventDefault();
    openMusicFiles();
  }
});

window.addEventListener("keydown", (event) => {
  if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "o") {
    event.preventDefault();
    openMusicFiles();
    return;
  }

  if (event.target instanceof Element && event.target.closest("button, input, textarea, select")) {
    return;
  }

  if (event.code === "Space") {
    event.preventDefault();
    togglePlayback();
  } else if (event.code === "ArrowLeft" && Number.isFinite(audio.duration)) {
    audio.currentTime = Math.max(0, audio.currentTime - 5);
  } else if (event.code === "ArrowRight" && Number.isFinite(audio.duration)) {
    audio.currentTime = Math.min(audio.duration, audio.currentTime + 5);
  }
});

island.addEventListener("click", (event) => {
  const button = event.target.closest("button");
  if (button && island.contains(button)) {
    animateButton(button);
  }
});

document.getElementById("waveform").addEventListener("click", (event) => {
  seekFromPointer(waveform, event);
});
waveform.addEventListener("keydown", (event) => {
  if (event.key === "ArrowLeft" || event.key === "ArrowRight") {
    event.preventDefault();
    const direction = event.key === "ArrowRight" ? 5 : -5;
    if (Number.isFinite(audio.duration)) {
      audio.currentTime = Math.max(0, Math.min(audio.duration, audio.currentTime + direction));
    }
  }
});
miniProgressTrack.addEventListener("click", (event) => {
  seekFromPointer(miniProgressTrack, event);
});
miniProgressTrack.addEventListener("keydown", (event) => {
  if (event.key === "ArrowLeft" || event.key === "ArrowRight") {
    event.preventDefault();
    const direction = event.key === "ArrowRight" ? 5 : -5;
    if (Number.isFinite(audio.duration)) {
      audio.currentTime = Math.max(0, Math.min(audio.duration, audio.currentTime + direction));
    }
  }
});

audio.addEventListener("timeupdate", updatePlaybackProgress);
audio.addEventListener("loadedmetadata", updatePlaybackProgress);

audio.addEventListener("play", () => {
  playButton.textContent = "Ⅱ";
  playButton.setAttribute("aria-label", "Pause");
  miniPlayButton.textContent = "Ⅱ";
  miniPlayButton.setAttribute("aria-label", "Pause");
  miniPlayButton.title = "Pause";
});

audio.addEventListener("pause", () => {
  playButton.textContent = "▶";
  playButton.setAttribute("aria-label", "Play");
  miniPlayButton.textContent = "▶";
  miniPlayButton.setAttribute("aria-label", "Play");
  miniPlayButton.title = "Play";
});

audio.addEventListener("ended", () => {
  if (repeatMode === "one") {
    audio.currentTime = 0;
    startPlayback();
  } else {
    skipToNextTrack(true);
    if (audio.ended) {
      playButton.textContent = "▶";
      playButton.setAttribute("aria-label", "Play");
      miniPlayButton.textContent = "▶";
      miniPlayButton.setAttribute("aria-label", "Play");
      miniPlayButton.title = "Play";
    }
  }
});

audio.addEventListener("error", () => {
  if (audio.error) {
    reportPlaybackError(audio.error);
  }
});

window.updateIslandTrack = (title, artist, artwork) => {
  document.getElementById("trackTitle").textContent = title;
  document.getElementById("trackArtist").textContent = artist;

  if (artwork) {
    const cover = document.getElementById("albumArt");
    cover.style.backgroundImage = `url("${artwork}")`;
    cover.style.backgroundSize = "cover";
    cover.style.backgroundPosition = "center";
    cover.textContent = "";
  } else {
    const cover = document.getElementById("albumArt");
    cover.style.backgroundImage = "";
    cover.textContent = "♫";
  }
};

window.updateIslandTrack("Choose a song", "Click album art or press Ctrl+O");