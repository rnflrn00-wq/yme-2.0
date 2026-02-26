const MEMO_DISPLAY_KEY = "__memoDisplayEnabled";

function getVideoId() {
  const match = location.search.match(/[?&]v=([^&]+)/);
  return match ? match[1] : null;
}

function removeExistingMemo() {
  const existing = document.getElementById("yt-memo-box");
  if (existing) existing.remove();
  popupBox = null;
  timeContainer = null;
}

let popupBox = null;
let timeContainer = null;
let shownBase = false;
let activeTimes = {};
let closedByUser = false;
let displayEnabled = true;
let lastMouse = { x: 20, y: 20 };

function isFullscreenMode() {
  return Boolean(document.fullscreenElement);
}

function isNearViewportEdge() {
  return (
    lastMouse.x <= 4 ||
    lastMouse.y <= 4 ||
    lastMouse.x >= window.innerWidth - 4 ||
    lastMouse.y >= window.innerHeight - 4
  );
}

function syncPopupPosition() {
  if (!popupBox) return;
  popupBox.style.left = `${lastMouse.x + 4}px`;
  popupBox.style.top = `${lastMouse.y + 4}px`;
}

function syncPopupVisibilityState() {
  if (!popupBox) return;

  const shouldHide = isFullscreenMode() || !displayEnabled || isNearViewportEdge() || closedByUser;
  popupBox.style.opacity = shouldHide ? "0" : "1";
}

function createBasePopup(baseText) {
  removeExistingMemo();

  popupBox = document.createElement("div");
  popupBox.id = "yt-memo-box";

  Object.assign(popupBox.style, {
    position: "fixed",
    zIndex: "99999",
    fontSize: "13px",
    pointerEvents: "none",
    opacity: "0",
    transition: "opacity 0.2s ease"
  });

  if (baseText) {
    const mainText = document.createElement("div");
    Object.assign(mainText.style, {
      color: "#fff",
      background: "rgba(0,0,0,0.72)",
      padding: "6px 10px",
      borderRadius: "4px",
      width: "fit-content",
      maxWidth: "260px",
      marginBottom: "4px"
    });
    mainText.innerText = baseText;
    popupBox.appendChild(mainText);
  }

  timeContainer = document.createElement("div");
  timeContainer.id = "yt-time-container";
  popupBox.appendChild(timeContainer);

  document.body.appendChild(popupBox);
  syncPopupPosition();
  syncPopupVisibilityState();
}

function showTimeInsidePopup(text) {
  if (!timeContainer) return;

  const item = document.createElement("div");
  Object.assign(item.style, {
    color: "rgba(255,255,255,0.8)",
    background: "rgba(0,0,0,0.72)",
    padding: "6px 10px",
    borderRadius: "4px",
    width: "fit-content",
    maxWidth: "260px",
    marginTop: "4px",
    opacity: "0",
    transition: "opacity 0.2s ease"
  });
  item.innerText = text;

  timeContainer.appendChild(item);
  requestAnimationFrame(() => {
    item.style.opacity = "1";
  });

  setTimeout(() => {
    item.style.opacity = "0";
    setTimeout(() => item.remove(), 200);
  }, 3000);
}

function getNormalizedMemos(data) {
  if (!data) return [];
  if (Array.isArray(data.memos)) {
    return data.memos.filter(m => m && typeof m.text === "string").map(m => ({
      time: Number.isFinite(m.time) ? Math.max(0, Math.floor(m.time)) : 0,
      text: m.text
    }));
  }
  if (typeof data === "string" && data.trim()) {
    return [{ time: 0, text: data.trim() }];
  }
  return [];
}

function ensurePopupForMemos(memos) {
  const base = memos.find(m => m.time === 0);
  if (base) {
    shownBase = true;
    createBasePopup(base.text);
    return;
  }

  const firstTimeMemo = memos.find(m => m.time > 0);
  if (firstTimeMemo) {
    shownBase = true;
    createBasePopup("기본 메모 없이 시간 메모만 등록된 영상입니다.");
  }
}

function forceShowMemoPopup(videoId) {
  chrome.storage.local.get([videoId], (result) => {
    const data = result[videoId];
    const memos = getNormalizedMemos(data);
    if (!memos.length) return;

    closedByUser = false;
    ensurePopupForMemos(memos);
  });
}

chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  if (request.type === "GET_TIME") {
    const video = document.querySelector("video");
    sendResponse({ time: video ? video.currentTime : 0 });
    return;
  }

  if (request.type === "SHOW_MEMO_POPUP") {
    const currentId = getVideoId();
    const targetId = request.videoId || currentId;
    if (currentId && targetId && currentId === targetId) {
      forceShowMemoPopup(targetId);
    }
    return;
  }

  if (request.type === "SEEK_TO") {
    const video = document.querySelector("video");
    if (!video) {
      sendResponse({ ok: false });
      return;
    }

    const nextTime = Number.isFinite(request.time) ? Math.max(0, request.time) : 0;
    video.currentTime = nextTime;
    video.play().catch(() => {});
    sendResponse({ ok: true });
    return;
  }

  if (request.type === "MEMO_VISIBILITY_CHANGED") {
    displayEnabled = Boolean(request.enabled);
    syncPopupVisibilityState();
  }
});

function checkMemos() {
  const video = document.querySelector("video");
  if (!video) {
    removeExistingMemo();
    return;
  }

  const videoId = getVideoId();
  if (!videoId) {
    removeExistingMemo();
    return;
  }

  chrome.storage.local.get([videoId, MEMO_DISPLAY_KEY], (result) => {
    displayEnabled = result[MEMO_DISPLAY_KEY] !== false;

    const data = result[videoId];
    const memos = getNormalizedMemos(data);

    if (!memos.length) {
      shownBase = false;
      activeTimes = {};
      removeExistingMemo();
      return;
    }

    const baseMemo = memos.find(m => m.time === 0);
    if (baseMemo && !shownBase && !closedByUser) {
      shownBase = true;
      createBasePopup(baseMemo.text);
    }

    const currentTime = Math.floor(video.currentTime);
    const matchedTimeMemos = memos
      .map((m, index) => ({ ...m, index }))
      .filter(m => m.time > 0 && Math.abs(m.time - currentTime) <= 1);

    if (!popupBox && !closedByUser && matchedTimeMemos.length > 0) {
      if (baseMemo) {
        shownBase = true;
        createBasePopup(baseMemo.text);
      } else {
        shownBase = true;
        createBasePopup("기본 메모 없이 시간 메모만 등록된 영상입니다.");
      }
    }

    memos.forEach((m, index) => {
      if (m.time > 0) {
        const memoKey = `${m.time}-${index}`;
        const isMatched = Math.abs(m.time - currentTime) <= 1;

        if (isMatched) {
          if (!activeTimes[memoKey]) {
            activeTimes[memoKey] = true;
            showTimeInsidePopup(`⏱ ${m.text}`);
          }
        } else {
          activeTimes[memoKey] = false;
        }
      }
    });

    syncPopupVisibilityState();
  });
}

setInterval(checkMemos, 1000);

let lastUrl = location.href;

new MutationObserver(() => {
  if (location.href !== lastUrl) {
    lastUrl = location.href;
    shownBase = false;
    activeTimes = {};
    closedByUser = false;
    removeExistingMemo();
    setTimeout(checkMemos, 500);
  }
}).observe(document, { subtree: true, childList: true });

document.addEventListener("mousemove", (event) => {
  lastMouse = { x: event.clientX, y: event.clientY };
  syncPopupPosition();
  syncPopupVisibilityState();
});

document.addEventListener("fullscreenchange", () => {
  syncPopupVisibilityState();
});

checkMemos();
