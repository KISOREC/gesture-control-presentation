export function physicalHandSide(categoryName, imageIsMirrored = false) {
  const label = categoryName?.toLowerCase();
  if (label !== "left" && label !== "right") {
    return undefined;
  }
  if (imageIsMirrored) {
    return label === "left" ? "Left" : "Right";
  }
  return label === "left" ? "Right" : "Left";
}

export function isRightSwipeHand(categoryName, imageIsMirrored = false) {
  return physicalHandSide(categoryName, imageIsMirrored) === "Right";
}

export function actionForHandPoses(hands) {
  if (
    hands.length === 2 &&
    hands.every(({ fingers }) => fingers.join("") === "11111")
  ) {
    return "start";
  }

  const leftHand = hands.find(({ side }) => side === "Left");
  if (!leftHand) {
    return undefined;
  }
  if (leftHand.fingers.every((finger) => finger === 0)) {
    return "exit";
  }
  const slideNumber = slideForGesture(leftHand.fingers, leftHand.landmarks);
  return slideNumber === undefined ? undefined : `slide:${slideNumber}`;
}

function slideForGesture(fingers, landmarks) {
  if (fingers.join("") === "11110" && landmarks) {
    const wrist = landmarks[0];
    const middleMcp = landmarks[9];
    const thumbBase = landmarks[1];
    const thumbTip = landmarks[4];
    const palmAxis = [middleMcp.x - wrist.x, middleMcp.y - wrist.y];
    const thumbAxis = [thumbTip.x - thumbBase.x, thumbTip.y - thumbBase.y];
    const palmLength = Math.hypot(...palmAxis);
    const thumbLength = Math.hypot(...thumbAxis);

    if (palmLength && thumbLength) {
      const thumbSide =
        (palmAxis[0] * thumbAxis[1] - palmAxis[1] * thumbAxis[0]) /
        (palmLength * thumbLength);
      if (thumbSide < -0.2) {
        return 3;
      }
    }
  }
  const gestures = new Map([
    ["01000", 1],
    ["01100", 2],
    ["01110", 3],
    ["01111", 4],
    ["11111", 5],
    ["10000", 6],
    ["11000", 7],
    ["11100", 8],
    ["11110", 9],
    ["01001", 10],
  ]);
  return gestures.get(fingers.join(""));
}

export class SwipeNavigation {
  constructor({
    distanceThreshold = 0.075,
    sampleWindow = 400,
    cooldown = 650,
    settleTime = 180,
    releaseTime = 700,
  } = {}) {
    this.distanceThreshold = distanceThreshold;
    this.sampleWindow = sampleWindow;
    this.cooldown = cooldown;
    this.settleTime = settleTime;
    this.releaseTime = releaseTime;
    this.samples = [];
    this.cooldownUntil = 0;
    this.swipeSuppressed = false;
    this.settledSince = undefined;
    this.handReleasedAt = undefined;
  }

  reset() {
    this.samples = [];
    this.cooldownUntil = 0;
    this.swipeSuppressed = false;
    this.settledSince = undefined;
    this.handReleasedAt = undefined;
  }

  update(screenX, now, isRightHand = false) {
    if (!isRightHand || !Number.isFinite(screenX)) {
      this.samples = [];
      this.settledSince = undefined;
      if (this.swipeSuppressed) {
        this.handReleasedAt ??= now;
        if (now - this.handReleasedAt >= this.releaseTime) {
          this.swipeSuppressed = false;
          this.handReleasedAt = undefined;
        }
      }
      return undefined;
    }

    this.handReleasedAt = undefined;
    this.samples.push({ x: screenX, time: now });
    this.samples = this.samples.filter(
      (sample) => now - sample.time <= this.sampleWindow,
    );

    if (this.swipeSuppressed) {
      const previous = this.samples[this.samples.length - 2];
      if (!previous || Math.abs(screenX - previous.x) <= 0.012) {
        this.settledSince ??= now;
        if (
          now >= this.cooldownUntil &&
          now - this.settledSince >= this.settleTime
        ) {
          this.swipeSuppressed = false;
          this.settledSince = undefined;
          this.samples = [{ x: screenX, time: now }];
        }
      } else {
        this.settledSince = undefined;
      }
      return undefined;
    }

    if (this.samples.length < 2) {
      return undefined;
    }

    const displacement = screenX - this.samples[0].x;
    if (Math.abs(displacement) < this.distanceThreshold) {
      return undefined;
    }

    this.cooldownUntil = now + this.cooldown;
    this.swipeSuppressed = true;
    this.settledSince = undefined;
    this.samples = [{ x: screenX, time: now }];
    return displacement < 0 ? "left" : "right";
  }
}
