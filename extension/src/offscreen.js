import { FilesetResolver, HandLandmarker } from "@mediapipe/tasks-vision";
import {
  actionForHandPoses,
  physicalHandSide,
  SwipeNavigation,
} from "./swipe-navigation.js";

const video = document.querySelector("#camera");
const stableGestureTime = 700;
const releaseGestureTime = 700;
let cameraStream;
let handLandmarker;
let frameTimer;
let lastVideoTime = -1;
let candidateAction;
let candidateSince = 0;
let lastAction;
let noGestureSince;
let actionInFlight = false;
let generation = 0;
const swipeNavigation = new SwipeNavigation();
let lastHandDiagnostic;

function distance(first, second) {
  return Math.hypot(first.x - second.x, first.y - second.y);
}

function jointAngle(first, joint, last) {
  const firstVector = [first.x - joint.x, first.y - joint.y];
  const lastVector = [last.x - joint.x, last.y - joint.y];
  const firstLength = Math.hypot(...firstVector);
  const lastLength = Math.hypot(...lastVector);
  if (firstLength === 0 || lastLength === 0) {
    return 0;
  }

  const cosine = Math.max(
    -1,
    Math.min(
      1,
      (firstVector[0] * lastVector[0] +
        firstVector[1] * lastVector[1]) /
        (firstLength * lastLength),
    ),
  );
  return (Math.acos(cosine) * 180) / Math.PI;
}

function fingersUp(landmarks) {
  const wrist = landmarks[0];
  const middleMcp = landmarks[9];
  const palmAxisX = middleMcp.x - wrist.x;
  const palmAxisY = middleMcp.y - wrist.y;
  const palmLength = Math.hypot(palmAxisX, palmAxisY);
  if (palmLength === 0) {
    return [0, 0, 0, 0, 0];
  }

  const thumbIsUp =
    jointAngle(landmarks[2], landmarks[3], landmarks[4]) >= 145 &&
    distance(landmarks[1], landmarks[4]) > 0.35 * palmLength;
  const fingerJoints = [
    [8, 7, 6, 5],
    [12, 11, 10, 9],
    [16, 15, 14, 13],
    [20, 19, 18, 17],
  ];
  const fingers = [Number(thumbIsUp)];

  for (const [tip, dip, pip, mcp] of fingerJoints) {
    const tipForward =
      ((landmarks[tip].x - landmarks[mcp].x) * palmAxisX +
        (landmarks[tip].y - landmarks[mcp].y) * palmAxisY) /
      palmLength;
    fingers.push(
      Number(
        jointAngle(landmarks[mcp], landmarks[pip], landmarks[dip]) >= 145 &&
          tipForward > 0.15 * palmLength,
      ),
    );
  }
  return fingers;
}

function actionLabel(action) {
  if (action === "start") {
    return "Start slideshow";
  }
  if (action === "exit") {
    return "Exit slideshow";
  }
  if (action === "swipe:left") {
    return "Previous slide";
  }
  if (action === "swipe:right") {
    return "Next slide";
  }
  return `Go to slide ${action.split(":")[1]}`;
}

function resetGestureState() {
  candidateAction = undefined;
  candidateSince = 0;
  lastAction = undefined;
  noGestureSince = undefined;
  actionInFlight = false;
  lastHandDiagnostic = undefined;
  swipeNavigation.reset();
}

async function stopCamera() {
  generation += 1;
  if (frameTimer !== undefined) {
    clearTimeout(frameTimer);
    frameTimer = undefined;
  }
  handLandmarker?.close();
  handLandmarker = undefined;
  cameraStream?.getTracks().forEach((track) => track.stop());
  cameraStream = undefined;
  video.srcObject = null;
  resetGestureState();
  await chrome.runtime.sendMessage({
    type: "gesture-hand-diagnostic",
    message: "Camera stopped",
  });
  await chrome.runtime.sendMessage({
    type: "gesture-camera-status",
    running: false,
    message: "Camera stopped.",
  });
}

async function startCamera() {
  if (cameraStream) {
    return;
  }

  const currentGeneration = generation;
  await chrome.runtime.sendMessage({
    type: "gesture-camera-status",
    running: false,
    message: "Requesting camera access…",
  });

  try {
    cameraStream = await navigator.mediaDevices.getUserMedia({
      audio: false,
      video: {
        facingMode: "user",
        width: { ideal: 640 },
        height: { ideal: 480 },
      },
    });
    video.srcObject = cameraStream;
    await video.play();

    const vision = await FilesetResolver.forVisionTasks(
      chrome.runtime.getURL("assets/wasm"),
    );
    handLandmarker = await HandLandmarker.createFromOptions(vision, {
      baseOptions: {
        modelAssetPath: chrome.runtime.getURL("assets/hand_landmarker.task"),
      },
      runningMode: "VIDEO",
      numHands: 2,
      minHandDetectionConfidence: 0.7,
      minHandPresenceConfidence: 0.7,
      minTrackingConfidence: 0.7,
    });
    if (currentGeneration !== generation) {
      cameraStream.getTracks().forEach((track) => track.stop());
      cameraStream = undefined;
      handLandmarker.close();
      handLandmarker = undefined;
      return;
    }
    resetGestureState();
    await chrome.runtime.sendMessage({
      type: "gesture-camera-status",
      running: true,
      message: "Camera ready. Return to your presentation and hold a gesture steady.",
    });
    frameTimer = setTimeout(processFrame, 30);
  } catch (error) {
    cameraStream?.getTracks().forEach((track) => track.stop());
    cameraStream = undefined;
    handLandmarker?.close();
    handLandmarker = undefined;
    const message = error instanceof Error ? error.message : String(error);
    await chrome.runtime.sendMessage({
      type: "gesture-camera-status",
      running: false,
      error: true,
      message: `Camera failed: ${message}`,
    });
    throw error;
  }
}

function sendGestureAction(action, pattern) {
  if (actionInFlight) {
    return;
  }

  actionInFlight = true;
  const currentGeneration = generation;
  void chrome.runtime
    .sendMessage({
      type: "gesture-detected",
      action,
      pattern,
    })
    .then((response) => {
      if (currentGeneration !== generation) {
        return;
      }
      if (!response?.ok) {
        throw new Error(response?.error ?? "Google Slides did not accept the gesture.");
      }
      lastAction = action;
    })
    .catch(async (error) => {
      if (currentGeneration === generation) {
        await chrome.runtime.sendMessage({
          type: "gesture-action-status",
          error: true,
          pattern,
          message: `${actionLabel(action)} failed: ${error instanceof Error ? error.message : String(error)}`,
        });
      }
    })
    .finally(() => {
      if (currentGeneration === generation) {
        actionInFlight = false;
      }
    });
}

function processGesture(action, pattern, now) {
  if (action === undefined) {
    candidateAction = undefined;
    candidateSince = now;
    if (noGestureSince === undefined) {
      noGestureSince = now;
    } else if (now - noGestureSince >= releaseGestureTime && !actionInFlight) {
      lastAction = undefined;
    }
    return;
  }

  noGestureSince = undefined;
  if (action !== candidateAction) {
    candidateAction = action;
    candidateSince = now;
  }
  if (now - candidateSince < stableGestureTime) {
    return;
  }
  if (action === lastAction || actionInFlight) {
    return;
  }

  sendGestureAction(action, pattern);
}

function processFrame() {
  if (handLandmarker === undefined || cameraStream === undefined) {
    return;
  }
  if (
    video.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA &&
    video.currentTime !== lastVideoTime
  ) {
    lastVideoTime = video.currentTime;
    const result = handLandmarker.detectForVideo(video, performance.now());
    const hands = (result.landmarks ?? []).map((landmarks, index) => {
      const classification = result.handedness?.[index]?.[0];
      const category = classification?.categoryName;
      return {
        fingers: fingersUp(landmarks),
        landmarks,
        rawSide: category,
        score: classification?.score,
        side: physicalHandSide(category),
      };
    });
    const pattern = hands.map(({ fingers }) => fingers.join("")).join(" · ");
    const handDiagnostic = hands.length
      ? hands
          .map(
            ({ side, rawSide, score }) =>
              `${side ?? "Unknown"} hand (model: ${rawSide ?? "unknown"}${Number.isFinite(score) ? ` ${Math.round(score * 100)}%` : ""})`,
          )
          .join(" · ")
      : "No hands detected";
    if (handDiagnostic !== lastHandDiagnostic) {
      lastHandDiagnostic = handDiagnostic;
      void chrome.runtime.sendMessage({
        type: "gesture-hand-diagnostic",
        message: handDiagnostic,
      });
    }
    const now = performance.now();
    const rightHand = hands.find(({ side }) => side === "Right");
    const swipeDirection = swipeNavigation.update(
      rightHand ? 1 - rightHand.landmarks[8].x : undefined,
      now,
      rightHand !== undefined,
    );
    let action = actionForHandPoses(hands);
    if (swipeDirection) {
      candidateAction = undefined;
      lastAction = undefined;
      noGestureSince = now;
      sendGestureAction(`swipe:${swipeDirection}`, pattern);
    } else {
      processGesture(action, pattern, now);
    }
  }
  frameTimer = setTimeout(processFrame, 30);
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type === "gesture-offscreen-start") {
    startCamera()
      .then(() => sendResponse({ ok: true }))
      .catch((error) =>
        sendResponse({
          ok: false,
          error: error instanceof Error ? error.message : String(error),
        }),
      );
    return true;
  }
  if (message?.type === "gesture-offscreen-stop") {
    stopCamera()
      .then(() => sendResponse({ ok: true }))
      .catch((error) =>
        sendResponse({
          ok: false,
          error: error instanceof Error ? error.message : String(error),
        }),
      );
    return true;
  }
  if (message?.type === "gesture-offscreen-get-status") {
    sendResponse({ ok: true, running: cameraStream !== undefined });
    return false;
  }
  return false;
});
