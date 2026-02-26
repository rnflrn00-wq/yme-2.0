// --- 상수 및 유틸리티 함수 ---

// 메모 표시 여부를 저장하기 위한 스토리지 키
const MEMO_DISPLAY_KEY = "__memoDisplayEnabled";

// URL에서 유튜브 비디오 ID(?v=...)를 추출하는 함수
function getVideoIdFromUrl(url) {
  const match = url.match(/[?&]v=([^&]+)/);
  return match ? match[1] : null;
}

// 초 단위 시간을 "00:00" 형식의 문자열로 변환하는 함수
function formatTime(seconds) {
  const safeSeconds = Math.max(0, Number.isFinite(seconds) ? Math.floor(seconds) : 0);
  const m = Math.floor(safeSeconds / 60);
  const s = safeSeconds % 60;
  return `${m.toString().padStart(2, "0")}:${s.toString().padStart(2, "0")}`;
}

// 저장된 메모 데이터를 일관된 객체 형식으로 정리(정규화)하는 함수
function normalizeMemoData(videoId, rawData) {
  // 데이터가 객체 형태인 경우 (최신 포맷)
  if (rawData && typeof rawData === "object") {
    return {
      title: typeof rawData.title === "string" ? rawData.title : videoId,
      channel: typeof rawData.channel === "string" ? rawData.channel : "Unknown Channel",
      thumbnail: typeof rawData.thumbnail === "string"
        ? rawData.thumbnail
        : `https://img.youtube.com/vi/${videoId}/hqdefault.jpg`,
      memos: Array.isArray(rawData.memos)
        ? rawData.memos
            .filter(m => m && typeof m.text === "string")
            .map(m => ({
              time: Number.isFinite(m.time) ? Math.max(0, Math.floor(m.time)) : 0,
              text: m.text
            }))
        : []
    };
  }

  // 데이터가 단순 문자열인 경우 (과거 데이터 호환성)
  if (typeof rawData === "string" && rawData.trim()) {
    return {
      title: videoId,
      channel: "Unknown Channel",
      thumbnail: `https://img.youtube.com/vi/${videoId}/hqdefault.jpg`,
      memos: [{ time: 0, text: rawData.trim() }]
    };
  }

  return null;
}

// --- 탭 조작 및 메시지 전송 함수 ---

// 특정 탭에 메모 팝업을 표시하라는 메시지를 보내는 함수
function sendShowPopupMessage(tabId, videoId) {
  if (!tabId) return;
  setTimeout(() => {
    chrome.tabs.sendMessage(tabId, { type: "SHOW_MEMO_POPUP", videoId }, () => {
      void chrome.runtime.lastError;
    });
  }, 350);
}

// 유튜브 영상의 특정 시간대로 이동(Seek)시키는 함수
function seekVideoInTab(tabId, time, fallbackUrl) {
  if (!tabId) return;

  const safeTime = Number.isFinite(time) ? Math.max(0, Math.floor(time)) : 0;
  const sendSeek = () => {
    chrome.tabs.sendMessage(tabId, { type: "SEEK_TO", time: safeTime }, (response) => {
      // 메시지 전송 실패 시 페이지 자체를 해당 시간 URL로 리로드
      if (!chrome.runtime.lastError && response && response.ok) {
        return;
      }
      chrome.tabs.update(tabId, { url: fallbackUrl, active: true });
    });
  };

  // 콘텐츠 스크립트가 실행 중인지 확인 후 시간 이동 메시지 전송
  chrome.scripting.executeScript(
    { target: { tabId }, files: ["content.js"] },
    () => {
      if (chrome.runtime.lastError) {
        chrome.tabs.update(tabId, { url: fallbackUrl, active: true });
        return;
      }
      sendSeek();
    }
  );
}

// 비디오를 스마트하게 여는 함수 (이미 열려있으면 해당 탭 활성화, 없으면 새로 생성)
function smartOpenVideo(videoId, options = {}) {
  chrome.tabs.query({}, (tabs) => {
    const existingTab = tabs.find(t => t.url && t.url.includes(`watch?v=${videoId}`));

    if (existingTab) {
      chrome.tabs.update(existingTab.id, { active: true }, () => {
        if (options.showPopup) sendShowPopupMessage(existingTab.id, videoId);
      });
    } else {
      chrome.tabs.create({ url: `https://www.youtube.com/watch?v=${videoId}` }, (createdTab) => {
        if (options.showPopup) sendShowPopupMessage(createdTab?.id, videoId);
      });
    }
  });
}

// 특정 시간대의 비디오를 스마트하게 여는 함수
function smartOpenVideoAtTime(videoId, time) {
  chrome.tabs.query({}, (tabs) => {
    const existingTab = tabs.find(t => t.url && t.url.includes(`watch?v=${videoId}`));
    const safeTime = Number.isFinite(time) ? Math.max(0, Math.floor(time)) : 0;
    const targetUrl = `https://www.youtube.com/watch?v=${videoId}&t=${safeTime}s`;

    if (existingTab) {
      chrome.tabs.update(existingTab.id, { active: true }, () => {
        seekVideoInTab(existingTab.id, safeTime, targetUrl);
      });
    } else {
      chrome.tabs.create({ url: targetUrl });
    }
  });
}

// --- 메모 설정 및 데이터 관리 ---

// 현재 활성화된 탭에 메모 표시 여부(on/off) 상태 변경을 알리는 함수
function notifyActiveTabMemoVisibility(enabled) {
  chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
    const tabId = tabs[0]?.id;
    if (!tabId) return;

    chrome.tabs.sendMessage(tabId, { type: "MEMO_VISIBILITY_CHANGED", enabled }, () => {
      void chrome.runtime.lastError;
    });
  });
}

// 팝업 내 메모 표시 토글 스위치 초기화 및 이벤트 리스너 등록
function initMemoVisibilityToggle() {
  const toggle = document.getElementById("memoVisibleToggle");
  if (!toggle) return;

  chrome.storage.local.get([MEMO_DISPLAY_KEY], (result) => {
    toggle.checked = result[MEMO_DISPLAY_KEY] !== false;
  });

  toggle.addEventListener("change", (e) => {
    const enabled = Boolean(e.target.checked);
    chrome.storage.local.set({ [MEMO_DISPLAY_KEY]: enabled }, () => {
      notifyActiveTabMemoVisibility(enabled);
    });
  });
}

// --- 현재 탭 정보 확인 ---
let currentVideoId = null;
let allData = {};

chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
  const url = tabs[0]?.url || "";
  currentVideoId = getVideoIdFromUrl(url);

  const label = document.getElementById("currentVideo");
  label.innerText = currentVideoId
    ? `영상 ID: ${currentVideoId}`
    : "유튜브 영상 페이지가 아닙니다.";
});

// 유튜브 oEmbed API를 통해 영상 제목, 작성자, 썸네일 정보를 가져오는 함수
async function fetchVideoMeta(videoId) {
  try {
    const response = await fetch(
      `https://www.youtube.com/oembed?url=https://www.youtube.com/watch?v=${videoId}&format=json`
    );
    const data = await response.json();

    return {
      title: data.title,
      author: data.author_name,
      thumbnail: `https://img.youtube.com/vi/${videoId}/hqdefault.jpg`
    };
  } catch (e) {
    return {
      title: videoId,
      author: "Unknown Channel",
      thumbnail: `https://img.youtube.com/vi/${videoId}/hqdefault.jpg`
    };
  }
}

// 메모를 스토리지에 저장하는 핵심 함수
function saveMemo(videoId, memoText, time) {
  chrome.storage.local.get([videoId], async (result) => {
    let existing = normalizeMemoData(videoId, result[videoId]);

    if (!existing) {
      const meta = await fetchVideoMeta(videoId);
      existing = {
        title: meta.title,
        channel: meta.author,
        thumbnail: meta.thumbnail,
        memos: []
      };
    }

    existing.memos.push({
      time: Number.isFinite(time) ? Math.max(0, Math.floor(time)) : 0,
      text: memoText
    });

    chrome.storage.local.set({ [videoId]: existing }, () => {
      document.getElementById("memoInput").value = "";
      initMemoVisibilityToggle();
      loadMemoList(); // 리스트 갱신
    });
  });
}

// 현재 재생 중인 유튜브 영상의 시간을 가져와서 콜백 함수를 실행하는 유틸리티
function withActiveYoutubeTab(callback) {
  chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
    const tabId = tabs[0]?.id;
    if (!tabId) {
      callback(0);
      return;
    }

    chrome.tabs.sendMessage(tabId, { type: "GET_TIME" }, (response) => {
      if (!chrome.runtime.lastError && response && response.time !== undefined) {
        callback(Math.max(0, Math.floor(response.time)));
        return;
      }

      // 메시지 실패 시 content.js 주입 후 재시도
      chrome.scripting.executeScript(
        { target: { tabId }, files: ["content.js"] },
        () => {
          if (chrome.runtime.lastError) {
            callback(0);
            return;
          }
          chrome.tabs.sendMessage(tabId, { type: "GET_TIME" }, (retryResponse) => {
            if (chrome.runtime.lastError || !retryResponse || retryResponse.time === undefined) {
              callback(0);
              return;
            }
            callback(Math.max(0, Math.floor(retryResponse.time)));
          });
        }
      );
    });
  });
}

// --- 이벤트 리스너 등록 ---

// '일반 메모 저장' 버튼: 시간 0으로 저장
document.getElementById("saveBaseMemoBtn").addEventListener("click", () => {
  const memoText = document.getElementById("memoInput").value.trim();
  if (!currentVideoId || !memoText) return;
  saveMemo(currentVideoId, memoText, 0);
});

// '현재 시간과 저장' 버튼: 영상의 현재 시간을 가져와서 저장
document.getElementById("saveTimeBtn").addEventListener("click", () => {
  const memoText = document.getElementById("memoInput").value.trim();
  if (!currentVideoId || !memoText) return;

  withActiveYoutubeTab((time) => {
    saveMemo(currentVideoId, memoText, time);
  });
});

// 검색창 입력 시 리스트 필터링
document.getElementById("searchInput").addEventListener("input", (e) => {
  renderList(e.target.value.toLowerCase());
});

// 백업 버튼: 전체 데이터를 JSON 파일로 다운로드
document.getElementById("backupBtn").addEventListener("click", () => {
  chrome.storage.local.get(null, (data) => {
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `youtube-memo-backup-${new Date().toISOString().slice(0, 10)}.json`;
    a.click();
    URL.revokeObjectURL(url);
  });
});

// 복원 버튼: JSON 파일을 읽어 스토리지에 덮어쓰기
document.getElementById("restoreInput").addEventListener("change", (event) => {
  const file = event.target.files?.[0];
  if (!file) return;

  const reader = new FileReader();
  reader.onload = () => {
    try {
      const parsed = JSON.parse(String(reader.result));
      const sanitized = {};

      Object.keys(parsed).forEach((videoId) => {
        const normalized = normalizeMemoData(videoId, parsed[videoId]);
        if (normalized) sanitized[videoId] = normalized;
      });

      chrome.storage.local.set(sanitized, loadMemoList);
    } catch (err) {
      alert("백업 파일 형식이 올바르지 않습니다.");
    } finally {
      event.target.value = "";
    }
  };
  reader.readAsText(file);
});

// 특정 영상의 특정 인덱스 메모 내용을 수정하는 함수
function updateMemo(videoId, memoIndex, nextText) {
  chrome.storage.local.get([videoId], (result) => {
    const existing = normalizeMemoData(videoId, result[videoId]);
    if (!existing || !existing.memos[memoIndex]) return;

    existing.memos[memoIndex].text = nextText;
    chrome.storage.local.set({ [videoId]: existing }, loadMemoList);
  });
}

// 데이터를 채널명 기준으로 그룹화하는 함수
function groupedByChannel() {
  const grouped = {};
  Object.keys(allData).forEach((videoId) => {
    const normalized = normalizeMemoData(videoId, allData[videoId]);
    if (!normalized) return;

    const key = normalized.channel || "Unknown Channel";
    if (!grouped[key]) grouped[key] = [];
    grouped[key].push({ videoId, ...normalized });
  });

  return grouped;
}

// 스토리지에서 전체 데이터를 불러와 리스트를 렌더링하는 함수
function loadMemoList() {
  chrome.storage.local.get(null, (data) => {
    allData = data;
    renderList("");
  });
}

// 화면에 메모 리스트를 그리고 필터링하는 메인 UI 렌더링 함수
function renderList(filterText) {
  const list = document.getElementById("memoList");
  list.innerHTML = "";

  const grouped = groupedByChannel();

  Object.keys(grouped)
    .sort((a, b) => a.localeCompare(b))
    .forEach((channelName) => {
      // 검색어 필터링 (채널 내 영상 제목이나 메모 내용에 포함 여부)
      const videos = grouped[channelName].filter(({ title, memos }) => {
        return (
          title.toLowerCase().includes(filterText) ||
          memos.some((m) => m.text.toLowerCase().includes(filterText))
        );
      });

      if (!videos.length) return;

      // 채널 카테고리 헤더 생성
      const category = document.createElement("div");
      category.className = "channel-category";
      category.innerText = `${channelName}`;
      list.appendChild(category);

      videos.forEach(({ videoId, title, thumbnail, memos }) => {
        const container = document.createElement("div");
        container.className = "item";

        // 영상 기본 정보 영역 (썸네일, 제목, 기본 메모)
        const container1 = document.createElement("div");
        container1.className = "container1";
        container1.innerHTML = `
          <img class="thumb" src="${thumbnail}" />
          <div class="title">${title}</div>
        `;
        container1.onclick = () => smartOpenVideo(videoId, { showPopup: true });

        // 시간 0인 메모(기본 메모) 표시
        memos
          .map((m, index) => ({ ...m, index }))
          .filter((m) => m.time === 0)
          .forEach((m) => {
            const base = document.createElement("div");
            base.className = "base-memo";
            base.innerText = m.text;

            const edit = document.createElement("button");
            edit.className = "edit-btn";
            edit.innerText = "수정";
            edit.onclick = (e) => {
              e.stopPropagation();
              const nextText = prompt("메모 수정", m.text);
              if (!nextText || !nextText.trim()) return;
              updateMemo(videoId, m.index, nextText.trim());
            };

            base.appendChild(edit);
            container1.appendChild(base);
          });

        // 타임라인 메모 영역 (시간이 설정된 메모들)
        const container2 = document.createElement("div");
        container2.className = "container2";

        const timeMemos = memos
          .map((m, index) => ({ ...m, index }))
          .filter((m) => m.time > 0)
          .sort((a, b) => a.time - b.time);

        timeMemos.forEach((m) => {
          const memoRow = document.createElement("div");
          memoRow.className = "timeline-row";

          const memo = document.createElement("div");
          memo.className = "timeline-memo";
          memo.innerText = `${formatTime(m.time)} "${m.text}"`;
          memo.onclick = (e) => {
            e.stopPropagation();
            smartOpenVideoAtTime(videoId, m.time);
          };

          const edit = document.createElement("button");
          edit.className = "edit-btn";
          edit.innerText = "수정";
          edit.onclick = (e) => {
            e.stopPropagation();
            const nextText = prompt("메모 수정", m.text);
            if (!nextText || !nextText.trim()) return;
            updateMemo(videoId, m.index, nextText.trim());
          };

          memoRow.appendChild(memo);
          memoRow.appendChild(edit);
          container2.appendChild(memoRow);
        });

        // 삭제 버튼 영역
        const container3 = document.createElement("div");
        container3.className = "container3";

        const deleteBtn = document.createElement("button");
        deleteBtn.innerText = "삭제";
        deleteBtn.onclick = (e) => {
          e.stopPropagation();
          chrome.storage.local.remove(videoId, loadMemoList);
        };

        container3.appendChild(deleteBtn);

        container.appendChild(container1);
        container.appendChild(container2);
        container.appendChild(container3);

        list.appendChild(container);
      });
    });
}

// --- 초기 실행 ---
initMemoVisibilityToggle(); // 토글 상태 로드
loadMemoList();             // 전체 목록 로드