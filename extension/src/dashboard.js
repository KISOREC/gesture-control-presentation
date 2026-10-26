import "./style.css";

const cameraToggle = document.querySelector("#camera-toggle");
const testSlideButton = document.querySelector("#test-slide");
const status = document.querySelector("#status");
const handPattern = document.querySelector("#hand-pattern");
const handIdentity = document.querySelector("#hand-identity");
const cameraIndicator = document.querySelector("#camera-indicator");

let cameraRunning = false;
let busy = false;

function setStatus(message, state = "info") {
  status.textContent = message;
  status.dataset.state = state;
}

function setCameraRunning(running) {
  cameraRunning = running;
  cameraToggle.textContent = running ? "Stop camera" : "Start camera";
  cameraIndicator.textContent = running
    ? "● Camera active in background"
    : "◉ Camera is stopped";
  handPattern.textContent = running
    ? "Camera runs in the background"
    : "Waiting for a hand";
}

async function sendMessage(message, timeoutMs = 15000) {
  let timeoutId;
  try {
    return await Promise.race([
      chrome.runtime.sendMessage(message),
      new Promise((_, reject) => {
        timeoutId = setTimeout(
          () => reject(new Error("The extension did not respond in time.")),
          timeoutMs,
        );
      }),
    ]);
  } finally {
    clearTimeout(timeoutId);
  }
}

cameraToggle.addEventListener("click", async () => {
  if (busy) {
    return;
  }

  busy = true;
  cameraToggle.disabled = true;
  try {
    if (cameraRunning) {
      const response = await sendMessage({ type: "gesture-camera-stop" });
      if (!response?.ok) {
        throw new Error(response?.error ?? "Could not stop the camera.");
      }
      setCameraRunning(false);
      setStatus("Camera stopped.");
      return;
    }

    const [tab] = await chrome.tabs.query({
      active: true,
      lastFocusedWindow: true,
    });
    if (
      tab?.id === undefined ||
      !tab.url?.startsWith("https://docs.google.com/presentation/")
    ) {
      throw new Error("Open a Google Slides presentation before starting the camera.");
    }

    setStatus("Starting background camera…");
    const response = await sendMessage({
      type: "gesture-camera-start",
      tabId: tab.id,
    });
    if (!response?.ok) {
      throw new Error(response?.error ?? "Could not start the camera.");
    }
    setCameraRunning(true);
    setStatus("Camera ready. Return to your presentation and hold a gesture steady.", "success");
  } catch (error) {
    setStatus(error instanceof Error ? error.message : String(error), "error");
  } finally {
    busy = false;
    cameraToggle.disabled = false;
  }
});

testSlideButton.addEventListener("click", async () => {
  if (busy) {
    return;
  }

  busy = true;
  testSlideButton.disabled = true;
  setStatus("Testing slide control…");
  try {
    const [tab] = await chrome.tabs.query({
      active: true,
      lastFocusedWindow: true,
    });
    if (tab?.id === undefined) {
      throw new Error("Could not identify the active Google Slides tab.");
    }
    const response = await sendMessage({
      type: "gesture-test-slide",
      tabId: tab.id,
      slideNumber: 2,
    });
    if (!response?.ok) {
      throw new Error(response?.error ?? "Google Slides did not accept the test action.");
    }
    setStatus(response.message, "success");
  } catch (error) {
    setStatus(
      `Test failed: ${error instanceof Error ? error.message : String(error)}`,
      "error",
    );
  } finally {
    busy = false;
    testSlideButton.disabled = false;
  }
});

chrome.runtime.onMessage.addListener((message) => {
  if (message?.type === "gesture-dismiss-popup") {
    window.close();
  } else if (message?.type === "gesture-camera-status") {
    setCameraRunning(message.running);
    setStatus(message.message, message.error ? "error" : "info");
  } else if (message?.type === "gesture-action-status") {
    setStatus(message.message, message.error ? "error" : "success");
    if (message.pattern) {
      handPattern.textContent = `Hand pattern: ${message.pattern}`;
    }
  } else if (message?.type === "gesture-hand-diagnostic") {
    handIdentity.textContent = `Hand identity: ${message.message}`;
  }
});

void chrome.runtime.sendMessage({ type: "gesture-camera-get-status" })
  .then((response) => {
    if (response?.ok) {
      setCameraRunning(response.running);
      if (response.lastActionPattern) {
        handPattern.textContent = `Hand pattern: ${response.lastActionPattern}`;
      }
      handIdentity.textContent = `Hand identity: ${response.lastHandDiagnostic ?? "No hands detected"}`;
      if (
        response.lastActionMessage &&
        response.lastActionMessage !== "No gesture action has been sent."
      ) {
        const statusPrefix = response.running
          ? "Camera is running in the background. "
          : "";
        setStatus(
          response.lastActionError
            ? response.lastActionMessage
            : `${statusPrefix}Last action: ${response.lastActionMessage}`,
          response.lastActionError ? "error" : "info",
        );
      } else {
        setStatus(
          response.message ??
            (response.running
              ? "Camera is running in the background."
              : "Open Google Slides, then start the background camera."),
        );
      }
    }
  })
  .catch(() => {
    setStatus("Open Google Slides, then start the background camera.");
  });
