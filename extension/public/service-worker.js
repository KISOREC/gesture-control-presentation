const keyCodes = {
  ArrowLeft: 37,
  ArrowRight: 39,
  Escape: 27,
  Home: 36,
};

function withTimeout(promise, milliseconds, operation) {
  let timeoutId;
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      timeoutId = setTimeout(
        () => reject(new Error(`${operation} timed out after ${milliseconds / 1000} seconds.`)),
        milliseconds,
      );
    }),
  ]).finally(() => clearTimeout(timeoutId));
}

function sendDebuggerCommand(target, method, params) {
  return withTimeout(
    chrome.debugger.sendCommand(target, method, params),
    5000,
    `Google Slides ${method}`,
  );
}

async function withDebugger(tabId, operation) {
  const tab = await withTimeout(
    chrome.tabs.get(tabId),
    5000,
    "Looking up the Google Slides tab",
  );
  if (!tab.url?.startsWith("https://docs.google.com/presentation/")) {
    throw new Error("The target tab is not a Google Slides presentation.");
  }

  const target = { tabId };
  await withTimeout(
    chrome.debugger.attach(target, "1.3"),
    5000,
    "Attaching to the Google Slides tab",
  );
  try {
    return await operation(target);
  } finally {
    await withTimeout(
      chrome.debugger.detach(target),
      5000,
      "Detaching from the Google Slides tab",
    );
  }
}

async function sendKey(target, key) {
  const digit = /^\d$/.test(key);
  const windowsVirtualKeyCode = digit
    ? 48 + Number(key)
    : keyCodes[key];
  if (windowsVirtualKeyCode === undefined) {
    throw new Error("The requested slideshow key is not supported.");
  }

  const keyEvent = {
    key,
    code: digit ? `Digit${key}` : key,
    windowsVirtualKeyCode,
    nativeVirtualKeyCode: windowsVirtualKeyCode,
  };
  if (digit) {
    keyEvent.text = key;
    keyEvent.unmodifiedText = key;
  }
  await sendDebuggerCommand(target, "Input.dispatchKeyEvent", {
    ...keyEvent,
    type: "rawKeyDown",
  });
  await sendDebuggerCommand(target, "Input.dispatchKeyEvent", {
    ...keyEvent,
    type: "keyUp",
  });
}

async function sendMouseClick(target, x, y) {
  await sendDebuggerCommand(target, "Input.dispatchMouseEvent", {
    type: "mouseMoved",
    x,
    y,
    buttons: 0,
  });
  await sendDebuggerCommand(target, "Input.dispatchMouseEvent", {
    type: "mousePressed",
    x,
    y,
    button: "left",
    buttons: 1,
    clickCount: 1,
  });
  await sendDebuggerCommand(target, "Input.dispatchMouseEvent", {
    type: "mouseReleased",
    x,
    y,
    button: "left",
    buttons: 0,
    clickCount: 1,
  });
}

async function waitForSlideshow(tabId) {
  const originalTab = await chrome.tabs.get(tabId);
  const presentationId =
    originalTab.url?.match(/\/presentation\/d\/([^/]+)/)?.[1];
  const deadline = Date.now() + 2500;

  while (Date.now() < deadline) {
    const tabs = await chrome.tabs.query({});
    const slideshowTab = tabs.find((tab) => {
      if (!tab.url?.startsWith("https://docs.google.com/presentation/")) {
        return false;
      }
      if (!/\/present(?:\/|$)/.test(new URL(tab.url).pathname)) {
        return false;
      }
      return (
        presentationId === undefined ||
        tab.url.includes(`/presentation/d/${presentationId}/`)
      );
    });

    if (slideshowTab) {
      return slideshowTab;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  return undefined;
}

async function performTrustedAction(tabId, action) {
  if (action?.type === "start") {
    if (
      !Number.isFinite(action.x) ||
      !Number.isFinite(action.y) ||
      action.x < 0 ||
      action.y < 0
    ) {
      throw new Error("Could not locate the Google Slides Present button.");
    }

    await withDebugger(tabId, async (target) => {
      await sendMouseClick(target, action.x, action.y);
    });
    const slideshowTab = await waitForSlideshow(tabId);
    if (!slideshowTab) {
      throw new Error(
        "Clicked Present, but Google Slides did not open the slideshow. Make sure the presentation is open in edit mode and try again.",
      );
    }
    return {
      message: "Google Slides slideshow opened.",
      targetTabId: slideshowTab.id,
      returnTabId: tabId,
    };
  }

  if (
    action?.type === "click" &&
    ["select-slide", "open-view-menu", "show-filmstrip", "close-view-menu"].includes(
      action.purpose,
    )
  ) {
    if (
      !Number.isFinite(action.x) ||
      !Number.isFinite(action.y) ||
      action.x < 0 ||
      action.y < 0
    ) {
      throw new Error("Could not locate the target slide thumbnail.");
    }

    return withDebugger(tabId, async (target) => {
      await sendMouseClick(target, action.x, action.y);
      return action.purpose === "select-slide"
        ? `Clicked slide ${action.slideNumber} using trusted browser input.`
        : "Updated Google Slides filmstrip visibility using trusted browser input.";
    });
  }

  if (action?.type === "exit") {
    return withDebugger(tabId, async (target) => {
      await sendKey(target, "Escape");
      return "Sent Escape using trusted browser input.";
    });
  }

  if (
    action?.type === "step" &&
    (action.direction === "left" || action.direction === "right")
  ) {
    const tab = await withTimeout(
      chrome.tabs.get(tabId),
      5000,
      "Looking up the Google Slides tab",
    );
    await withTimeout(
      chrome.tabs.update(tabId, { active: true }),
      5000,
      "Activating the Google Slides tab",
    );
    if (tab.windowId !== undefined) {
      await withTimeout(
        chrome.windows.update(tab.windowId, { focused: true }),
        5000,
        "Focusing the Google Slides window",
      );
    }
    return withDebugger(tabId, async (target) => {
      await sendDebuggerCommand(target, "Page.bringToFront", {});
      await sendKey(target, action.direction === "left" ? "ArrowLeft" : "ArrowRight");
      return action.direction === "left"
        ? `Sent one trusted Left Arrow key to Google Slides (tab ${tabId}).`
        : `Sent one trusted Right Arrow key to Google Slides (tab ${tabId}).`;
    });
  }

  if (
    action?.type === "navigate" &&
    Number.isInteger(action.slideNumber) &&
    action.slideNumber >= 1 &&
    action.slideNumber <= 10
  ) {
    const tab = await withTimeout(
      chrome.tabs.get(tabId),
      5000,
      "Looking up the slideshow tab",
    );
    await withTimeout(
      chrome.tabs.update(tabId, { active: true }),
      5000,
      "Activating the slideshow tab",
    );
    if (tab.windowId !== undefined) {
      await withTimeout(
        chrome.windows.update(tab.windowId, { focused: true }),
        5000,
        "Focusing the slideshow window",
      );
    }
    return withDebugger(tabId, async (target) => {
      await withTimeout(
        sendDebuggerCommand(target, "Page.bringToFront", {}),
        5000,
        "Bringing the slideshow to the front",
      );
      await sendKey(target, "Home");
      await new Promise((resolve) => setTimeout(resolve, 100));
      for (let index = 1; index < action.slideNumber; index += 1) {
        await sendKey(target, "ArrowRight");
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
      return `Sent Home and ${action.slideNumber - 1} trusted Right Arrow key(s) to Google Slides (tab ${tabId}).`;
    });
  }

  throw new Error("The slideshow gesture action is not recognized.");
}

let cameraRunning = false;
let editorTabId;
let slideshowTabId;
let lastActionMessage = "No gesture action has been sent.";
let lastActionError = false;
let lastActionPattern;
let lastHandDiagnostic = "No hands detected";

async function restoreControlState() {
  const stored = await chrome.storage.session.get([
    "gestureControlState",
    "gestureLastAction",
    "gestureHandDiagnostic",
  ]);
  const state = stored.gestureControlState;
  if (state) {
    editorTabId = state.editorTabId;
    slideshowTabId = state.slideshowTabId;
  }
  if (stored.gestureLastAction) {
    lastActionMessage = stored.gestureLastAction.message;
    lastActionError = stored.gestureLastAction.error;
    lastActionPattern = stored.gestureLastAction.pattern;
  }
  lastHandDiagnostic = stored.gestureHandDiagnostic ?? lastHandDiagnostic;
}

async function saveControlState() {
  const state = {};
  if (editorTabId !== undefined) {
    state.editorTabId = editorTabId;
  }
  if (slideshowTabId !== undefined) {
    state.slideshowTabId = slideshowTabId;
  }
  await chrome.storage.session.set({
    gestureControlState: state,
  });
}

function presentationIdFromUrl(url) {
  return url?.match(/\/presentation\/d\/([^/]+)/)?.[1];
}

function isSlideshowTab(tab) {
  return (
    tab?.url?.startsWith("https://docs.google.com/presentation/") &&
    new URL(tab.url).pathname.split("/").includes("present")
  );
}

async function findSlideshowTab() {
  const tabs = await chrome.tabs.query({});
  const storedSlideshow = slideshowTabId === undefined
    ? undefined
    : tabs.find(
        (tab) =>
          tab.id === slideshowTabId &&
          tab.url?.startsWith("https://docs.google.com/presentation/") &&
          (tab.id !== editorTabId || isSlideshowTab(tab)),
      );
  if (storedSlideshow) {
    return storedSlideshow;
  }

  let editorTab;
  if (editorTabId !== undefined) {
    editorTab = tabs.find((tab) => tab.id === editorTabId);
    if (isSlideshowTab(editorTab)) {
      return editorTab;
    }
  }

  const presentationId = presentationIdFromUrl(editorTab?.url);
  const slideshow = tabs.find((tab) => {
    if (!isSlideshowTab(tab)) {
      return false;
    }
    return (
      presentationId === undefined ||
      presentationIdFromUrl(tab.url) === presentationId
    );
  });
  if (slideshow) {
    return slideshow;
  }

  const [activeTab] = await chrome.tabs.query({
    active: true,
    lastFocusedWindow: true,
  });
  return isSlideshowTab(activeTab) ? activeTab : undefined;
}

async function rememberSlideshowTab(tab) {
  if (Number.isInteger(tab?.id)) {
    slideshowTabId = tab.id;
    await saveControlState();
  }
}

async function findPresentationControlTab() {
  const slideshow = await findSlideshowTab();
  if (slideshow) {
    await rememberSlideshowTab(slideshow);
    return slideshow;
  }

  const [activeTab] = await chrome.tabs.query({
    active: true,
    lastFocusedWindow: true,
  });
  if (activeTab?.url?.startsWith("https://docs.google.com/presentation/")) {
    return activeTab;
  }

  if (editorTabId !== undefined) {
    try {
      const editorTab = await chrome.tabs.get(editorTabId);
      if (editorTab.url?.startsWith("https://docs.google.com/presentation/")) {
        return editorTab;
      }
    } catch (error) {
      console.warn("Could not look up the selected Slides tab:", error);
    }
  }
  return undefined;
}

async function hasOffscreenDocument() {
  const contexts = await chrome.runtime.getContexts({
    contextTypes: ["OFFSCREEN_DOCUMENT"],
    documentUrls: [chrome.runtime.getURL("offscreen.html")],
  });
  return contexts.length > 0;
}

async function ensureOffscreenDocument() {
  if (await hasOffscreenDocument()) {
    return;
  }
  await chrome.offscreen.createDocument({
    url: "offscreen.html",
    reasons: ["USER_MEDIA"],
    justification:
      "Run local camera gesture recognition after the action popup closes.",
  });
}

async function sendOffscreenMessage(message) {
  if (!(await hasOffscreenDocument())) {
    throw new Error("The background camera document is not available.");
  }
  return chrome.runtime.sendMessage(message);
}

async function startBackgroundCamera(tabId) {
  const tab = await withTimeout(
    chrome.tabs.get(tabId),
    5000,
    "Looking up the Google Slides tab",
  );
  if (!tab.url?.startsWith("https://docs.google.com/presentation/")) {
    throw new Error("Open a Google Slides presentation before starting the camera.");
  }

  editorTabId = tabId;
  slideshowTabId = /\/present(?:\/|$)/.test(new URL(tab.url).pathname)
    ? tabId
    : undefined;
  await saveControlState();
  await ensureOffscreenDocument();
  const response = await withTimeout(
    sendOffscreenMessage({ type: "gesture-offscreen-start" }),
    30000,
    "Starting the background camera",
  );
  if (!response?.ok) {
    throw new Error(response?.error ?? "The background camera failed to start.");
  }
  cameraRunning = true;
}

async function stopBackgroundCamera() {
  if (await hasOffscreenDocument()) {
    const response = await withTimeout(
      sendOffscreenMessage({ type: "gesture-offscreen-stop" }),
      10000,
      "Stopping the background camera",
    );
    if (!response?.ok) {
      throw new Error(response?.error ?? "The background camera failed to stop.");
    }
    await chrome.offscreen.closeDocument();
  }
  cameraRunning = false;
  slideshowTabId = undefined;
  editorTabId = undefined;
  await chrome.storage.session.remove("gestureControlState");
  await chrome.action.setBadgeText({ text: "" });
}

async function sendEditorAction(tabId, action) {
  const contentMessage = {
    type: "gesture-slides-action-v133",
    action,
  };
  let response;
  try {
    response = await withTimeout(
      chrome.tabs.sendMessage(tabId, contentMessage),
      12000,
      "Waiting for the Google Slides page",
    );
  } catch (error) {
    await withTimeout(
      chrome.scripting.executeScript({
        target: { tabId },
        files: ["content.js"],
      }),
      10000,
      "Preparing Google Slides gesture control",
    );
    response = await withTimeout(
      chrome.tabs.sendMessage(tabId, contentMessage),
      12000,
      "Waiting for the Google Slides page",
    );
  }
  if (response?.contentProtocol !== "gesture-slides-action-v133") {
    await withTimeout(
      chrome.scripting.executeScript({
        target: { tabId },
        files: ["content.js"],
      }),
      10000,
      "Refreshing the Google Slides gesture controller",
    );
    response = await withTimeout(
      chrome.tabs.sendMessage(tabId, contentMessage),
      12000,
      "Retrying the Google Slides gesture action",
    );
  }
  if (response?.contentProtocol !== "gesture-slides-action-v133") {
    throw new Error(
      "Could not refresh the Google Slides controller. Reload the Google Slides tab and try again.",
    );
  }
  if (!response?.ok) {
    throw new Error(
      response?.error ?? "Could not control this Google Slides presentation.",
    );
  }
  return response;
}

async function handleDetectedGesture(action, pattern) {
  await restoreControlState();
  if (typeof action !== "string") {
    throw new Error("The camera sent an invalid gesture action.");
  }

  if (action === "start") {
    const existingSlideshow = await findSlideshowTab();
    if (existingSlideshow) {
      await rememberSlideshowTab(existingSlideshow);
      setActionStatus(
        "Slideshow is already open. Show a slide number to navigate.",
        false,
        pattern,
      );
      return "Slideshow is already open.";
    }
    if (editorTabId === undefined) {
      throw new Error("Start the camera from the Google Slides presentation you want to control.");
    }
    notifyPopup({ type: "gesture-dismiss-popup" });
    const response = await sendEditorAction(editorTabId, "start");
    if (Number.isInteger(response.targetTabId)) {
      slideshowTabId = response.targetTabId;
      editorTabId = response.returnTabId ?? editorTabId;
      await saveControlState();
    }
    setActionStatus(response.message ?? "Google Slides slideshow opened.", false, pattern);
    return response.message ?? "Google Slides slideshow opened.";
  }

  const slideMatch = /^slide:(\d+)$/.exec(action);
  const swipeMatch = /^swipe:(left|right)$/.exec(action);
  const presentationTab = await findPresentationControlTab();
  if (action === "exit" && presentationTab?.id !== undefined) {
    const result = await performTrustedAction(presentationTab.id, { type: "exit" });
    slideshowTabId = undefined;
    await saveControlState();
    setActionStatus(result, false, pattern);
    return result;
  }
  if (slideMatch && presentationTab?.id !== undefined) {
    const result = await performTrustedAction(presentationTab.id, {
      type: "navigate",
      slideNumber: Number(slideMatch[1]),
    });
    setActionStatus(result, false, pattern);
    return result;
  }
  if (swipeMatch && presentationTab?.id !== undefined) {
    const result = await performTrustedAction(presentationTab.id, {
      type: "step",
      direction: swipeMatch[1],
    });
    setActionStatus(result, false, pattern);
    return result;
  }

  if (presentationTab?.id === undefined) {
    throw new Error("No Google Slides presentation is selected. Start the camera from its tab.");
  }
  const response = await sendEditorAction(presentationTab.id, action);
  setActionStatus(response.message ?? `${action} completed.`, false, pattern);
  return response.message ?? `${action} completed.`;
}

function notifyPopup(message) {
  void chrome.runtime.sendMessage(message).catch(() => {
    // The popup is normally closed during a presentation.
  });
}

function setActionStatus(message, error, pattern) {
  lastActionMessage = message;
  lastActionError = error;
  lastActionPattern = pattern;
  void chrome.storage.session
    .set({ gestureLastAction: { message, error, pattern } })
    .catch((storageError) =>
      console.error("Could not save the latest gesture status:", storageError),
    );
  void chrome.action.setBadgeText({ text: error ? "!" : "OK" });
  void chrome.action.setBadgeBackgroundColor({
    color: error ? "#c62828" : "#388e3c",
  });
  void chrome.action.setTitle({ title: `Gesture Slides: ${message}` });
  notifyPopup({
    type: "gesture-action-status",
    message,
    error,
    pattern,
  });
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.type === "gesture-camera-start") {
    if (sender.id !== chrome.runtime.id || !Number.isInteger(message.tabId)) {
      sendResponse({ ok: false, error: "Could not identify the Google Slides tab." });
      return false;
    }

    startBackgroundCamera(message.tabId)
      .then(() => sendResponse({ ok: true }))
      .catch((error) =>
        sendResponse({
          ok: false,
          error: error instanceof Error ? error.message : String(error),
        }),
      );
    return true;
  }

  if (message?.type === "gesture-camera-stop") {
    if (sender.id !== chrome.runtime.id) {
      sendResponse({ ok: false, error: "The sender is not this extension." });
      return false;
    }

    stopBackgroundCamera()
      .then(() => sendResponse({ ok: true }))
      .catch((error) =>
        sendResponse({
          ok: false,
          error: error instanceof Error ? error.message : String(error),
        }),
      );
    return true;
  }

  if (message?.type === "gesture-camera-get-status") {
    if (sender.id !== chrome.runtime.id) {
      sendResponse({ ok: false, error: "The sender is not this extension." });
      return false;
    }
    hasOffscreenDocument()
      .then(async (exists) => {
        const stored = await chrome.storage.session.get("gestureLastAction");
        if (stored.gestureLastAction) {
          lastActionMessage = stored.gestureLastAction.message;
          lastActionError = stored.gestureLastAction.error;
          lastActionPattern = stored.gestureLastAction.pattern;
        }
        const handState = await chrome.storage.session.get("gestureHandDiagnostic");
        lastHandDiagnostic =
          handState.gestureHandDiagnostic ?? "No hands detected";
        const response = exists
          ? await sendOffscreenMessage({ type: "gesture-offscreen-get-status" })
          : { running: false };
        cameraRunning = Boolean(response?.running);
        sendResponse({
          ok: true,
          running: cameraRunning,
          message: cameraRunning
            ? "Camera is running in the background."
            : lastActionError
              ? lastActionMessage
              : undefined,
          lastActionMessage,
          lastActionError,
          lastActionPattern,
          lastHandDiagnostic,
        });
      })
      .catch((error) =>
        sendResponse({
          ok: false,
          error: error instanceof Error ? error.message : String(error),
        }),
      );
    return true;
  }

  if (message?.type === "gesture-camera-status") {
    cameraRunning = Boolean(message.running);
    const badgeText = message.error ? "!" : cameraRunning ? "●" : "";
    void chrome.action.setBadgeText({ text: badgeText });
    void chrome.action.setBadgeBackgroundColor({
      color: message.error ? "#c62828" : "#388e3c",
    });
    void chrome.action.setTitle({
      title: message.error
        ? `Gesture Slides: ${message.message}`
        : "Gesture Slides Controller",
    });
    notifyPopup({
      type: "gesture-camera-status",
      running: cameraRunning,
      error: Boolean(message.error),
      message: message.message,
    });
    return false;
  }

  if (message?.type === "gesture-hand-diagnostic") {
    if (!sender.url?.endsWith("/offscreen.html")) {
      return false;
    }
    lastHandDiagnostic =
      typeof message.message === "string" ? message.message : "Unknown hand";
    void chrome.storage.session
      .set({ gestureHandDiagnostic: lastHandDiagnostic })
      .catch((error) =>
        console.error("Could not save the hand identity diagnostic:", error),
      );
    notifyPopup({
      type: "gesture-hand-diagnostic",
      message: lastHandDiagnostic,
    });
    return false;
  }

  if (message?.type === "gesture-action-status") {
    setActionStatus(message.message, Boolean(message.error), message.pattern);
    return false;
  }

  if (message?.type === "gesture-detected") {
    if (!sender.url?.endsWith("/offscreen.html")) {
      sendResponse({ ok: false, error: "Gesture actions must come from the camera document." });
      return false;
    }
    handleDetectedGesture(message.action, message.pattern)
      .then((result) => sendResponse({ ok: true, message: result }))
      .catch((error) => {
        const errorMessage = error instanceof Error ? error.message : String(error);
        setActionStatus(errorMessage, true, message.pattern);
        sendResponse({ ok: false, error: errorMessage });
      });
    return true;
  }

  if (message?.type === "gesture-test-slide") {
    if (sender.id !== chrome.runtime.id || !Number.isInteger(message.tabId)) {
      sendResponse({ ok: false, error: "Could not identify the Google Slides tab." });
      return false;
    }
    chrome.tabs
      .get(message.tabId)
      .then((tab) => {
        if (/\/present(?:\/|$)/.test(new URL(tab.url ?? "").pathname)) {
          return performTrustedAction(message.tabId, {
            type: "navigate",
            slideNumber: message.slideNumber,
          });
        }
        return sendEditorAction(message.tabId, `slide:${message.slideNumber}`).then(
          (response) => response.message ?? "Selected slide 2 in the editor.",
        );
      })
      .then((result) => sendResponse({ ok: true, message: result }))
      .catch((error) =>
        sendResponse({
          ok: false,
          error: error instanceof Error ? error.message : String(error),
        }),
      );
    return true;
  }

  const isPanelAction = message?.type === "gesture-slides-panel-action";
  const isPageAction = message?.type === "gesture-slides-trusted-action";
  if (!isPanelAction && !isPageAction) {
    return false;
  }

  if (isPanelAction && sender.id !== chrome.runtime.id) {
    sendResponse({ ok: false, error: "The sender is not this extension." });
    return false;
  }

  const tabId = isPanelAction ? message.tabId : sender.tab?.id;
  if (tabId === undefined) {
    sendResponse({ ok: false, error: "Could not identify the Slides tab." });
    return false;
  }

  if (!Number.isInteger(tabId)) {
    sendResponse({ ok: false, error: "The Slides tab identifier is invalid." });
    return false;
  }

  performTrustedAction(tabId, message.action)
    .then((result) =>
      sendResponse({
        ok: true,
        ...(typeof result === "string" ? { message: result } : result),
      }),
    )
    .catch((error) => {
      sendResponse({
        ok: false,
        error: error instanceof Error ? error.message : String(error),
      });
    });
  return true;
});
